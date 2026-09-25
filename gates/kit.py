#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
kit.py —— 通用小说写作工具链 · 共享模块

设计原则（这是整个 kit 的立身之本）：
  1. **代码通用，配置项目级**。所有「随书变化」的值（人名、数值表、账本列、
     评级刻度、字数上限…）一律放在 <书>/.soloent/book.json，不写进代码。
     历史上两本书各自复制了一份 tools/，结果 6 个脚本全部漂移——本模块就是为了终结这件事。
  2. **单一来源**。同一个值只允许存在一处。机检项清单以 consistency_check.py 的
     --list-checks 输出为准，文档不复述。
  3. **可推导的交给脚本，不可推导的留人工标记位**。
     能算的（加减乘除、单调性、章号连续性）机检；不能算的（这一章实际写了什么）
     交给 brief.py 把事实摆到眼前 + 每章一停由作者过目。

用法（在书目录下）：
    python <kit>/tools/preflight.py
或指定项目：
    python <kit>/tools/preflight.py --root "D:/1-work/novel/某本书"
"""
import json
import os
import re
import sys


def _ep(*args, **kwargs):
    """gates 契约：诊断/报错等人类可读输出走 stderr，stdout 只留 JSON。"""
    print(*args, file=sys.stderr, **kwargs)


# ── gates 退出码契约（2026-09-25 统一，B-14）───────────────────────────────
#
#   0 = 正常跑完。**结论只看 stdout 的 JSON**——findings 有几条、严重度如何，
#       与退出码**毫无关系**。发现问题也是 0。
#   1 = 脚本崩了（未捕获异常）。本次**没有结论**。
#   2 = 环境/配置错（书配置缺失、读不了、结构非法）。本次**没有结论**。
#
# ★非 0 的含义只有一个：**本次没产出可用结论**。上层一律当失败处理，
#   绝不允许把非 0 读成「查了没问题」——那是本项目反复在治的假绿形态。
#
# 为什么非 0 也要往 stdout 吐 JSON：上层要能按 kind 分流
# （配置错 → 作者去改 book.json；崩溃 → 报 bug）。只给 stderr 的话，
# 上层只能拿到一坨文本，分不出这两件事，最后只能统一报「gate 执行失败」。
EXIT_OK = 0
EXIT_CRASH = 1
EXIT_CONFIG = 2


def gate_name():
    """当前检查器名（取 argv[0] 的文件名）——用于结构化错误里的 gate 字段。"""
    return os.path.splitext(os.path.basename(sys.argv[0] or "gate"))[0]


def emit_error(kind, detail, book_root=None, problems=None):
    """把失败原因以**结构化**形式吐到 stdout。

    ⚠️ 这份 JSON **不是结论**：它没有 findings、没有 chapter_count。
    上层的形状校验会（也应该）拒绝把它当 GateResult 用。
    """
    err = {"kind": kind, "detail": detail}
    if problems:
        err["problems"] = list(problems)
    print(json.dumps({
        "gate": gate_name(),
        "book_root": book_root,
        "ok": False,
        "error": err,
    }, ensure_ascii=False))


def fail_config(detail, book_root=None, problems=None):
    """环境/配置错：结构化原因走 stdout，人类可读细节走 stderr，然后 exit 2。"""
    emit_error("config", detail, book_root, problems)
    sys.exit(EXIT_CONFIG)


def run_main(fn):
    """检查器统一入口：包住 main()，把未捕获异常变成 EXIT_CRASH + 结构化原因。

    没有这层包装，未捕获异常就是 Python 默认的 traceback + exit 1：
    stdout 一个字符都没有，上层只能拿到退出码和 stderr 里的一坨文本，
    既分不出「崩了」与「配置错」，也没法做任何程序化处理。
    """
    try:
        code = fn()
    except SystemExit:
        raise
    except BaseException as e:  # noqa: BLE001 —— 入口层要兜住一切，包括 KeyboardInterrupt 之外的 BaseException
        import traceback
        traceback.print_exc(file=sys.stderr)
        _ep(f"⛔ 检查器崩溃：{type(e).__name__}: {e}")
        emit_error("crash", f"{type(e).__name__}: {e}")
        sys.exit(EXIT_CRASH)
    sys.exit(EXIT_OK if code is None else int(code))


KIT_ROOT = os.path.dirname(os.path.abspath(__file__))      # 本目录 = scripts/
PLUGIN_ROOT = os.path.dirname(KIT_ROOT)                    # 插件根
# 支撑目录沿用 SoloEnt 官方约定：templates / docs / scripts（+ assets 放打包进来的库）
#
# ⚠️ 迁仓后目录层级变了：本仓把「随插件分发的内容」整体收进 content/，
# 于是 templates/ 与 assets/ 都比旧插件深一层。曾经写成 PLUGIN_ROOT/templates
# ——那个路径**不存在**，而 style_doc_issues 的模板比对有 isfile 守卫，
# 于是「与插件模板一字不差」这条判据静默失效（死分支，不报错也不生效）。
# 改路径时务必跑 `python -c "import kit;print(kit.TEMPLATES)"` 确认目录真实存在。
ASSETS = os.path.join(PLUGIN_ROOT, "content")              # 随插件分发的内容根（规则/技能/模板）
TEMPLATES = os.path.join(PLUGIN_ROOT, "content", "templates")  # 新书骨架模板
DOCS = os.path.join(PLUGIN_ROOT, "docs")                   # 分阶段手册（按需加载）
# 兼容旧名：早期版本把分阶段手册放在 references/，保留这个别名以防有引用残留
REFERENCES = DOCS
CONFIG_REL = os.path.join(".soloent", "book.json")
SOLOENT = ".soloent"
SCHEMA = 1


def atomic_write_text(path, text, encoding="utf-8", newline="\n"):
    """同目录临时文件写完后原子替换，避免中断留下半截状态文件。

    Windows 上若目标文件仍被其他进程以写模式打开，os.replace 会报
    PermissionError（共享冲突）——那是瞬态，短暂重试即可，否则并发入口
    会因为「别人正开着这个文件」而整体失败。
    """
    import tempfile
    import time

    parent = os.path.dirname(os.path.abspath(path))
    os.makedirs(parent, exist_ok=True)
    fd, tmp = tempfile.mkstemp(prefix=".%s." % os.path.basename(path), suffix=".tmp", dir=parent)
    try:
        with os.fdopen(fd, "w", encoding=encoding, newline=newline) as f:
            f.write(text)
            f.flush()
            os.fsync(f.fileno())
        deadline = time.time() + 5.0
        while True:
            try:
                os.replace(tmp, path)
                break
            except PermissionError:
                if time.time() >= deadline:
                    raise
                time.sleep(0.1)
    except Exception:
        try:
            os.close(fd)
        except OSError:
            pass
        try:
            os.remove(tmp)
        except OSError:
            pass
        raise


def atomic_write_json(path, data):
    atomic_write_text(path, json.dumps(data, ensure_ascii=False, indent=2))


# ---------------------------------------------------------------- 项目锁

def _lock_fd(fd):
    """对已打开的锁文件做非阻塞独占锁。进程退出（含崩溃）时 OS 自动释放，
    因此不存在「残留死锁文件」的问题——这是选 OS 锁而不是 O_EXCL 轮转的原因。"""
    if os.name == "nt":
        import msvcrt
        os.lseek(fd, 0, os.SEEK_SET)
        msvcrt.locking(fd, msvcrt.LK_NBLCK, 1)
    else:
        import fcntl
        fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)


def _unlock_fd(fd):
    try:
        if os.name == "nt":
            import msvcrt
            os.lseek(fd, 0, os.SEEK_SET)
            msvcrt.locking(fd, msvcrt.LK_UNLCK, 1)
        else:
            import fcntl
            fcntl.flock(fd, fcntl.LOCK_UN)
    except OSError:
        pass


class LockBusy(Exception):
    """项目锁被其他入口占用且等待超时。调用方应跳过本次而不是硬等。"""


class project_lock:
    """项目级互斥锁（`.soloent/locks/<name>.lock`）。

    用途（报告 NW-P1-008）：Hook、Watcher、手工命令可能同时对同一本书跑检查；
    报告、趋势 CSV、状态哈希的「读 → 改 → 写」若无锁会互相丢更新。
    入口约定：preflight 编排全程持 `preflight` 锁；consistency_check 写报告/趋势
    时持 `report` 锁；state_sync 写哈希时持 `state` 锁。子检查持的锁名与父编排
    不同，避免同进程重复加锁自锁。

    timeout 内拿不到锁抛 LockBusy——自动入口捕获后跳过本次（幂等），
    手工入口可以加大 timeout 排队等。
    """

    def __init__(self, root, name="preflight", timeout=120):
        self.path = os.path.join(root, SOLOENT, "locks", name + ".lock")
        self.timeout = timeout

    def __enter__(self):
        import time
        os.makedirs(os.path.dirname(self.path), exist_ok=True)
        deadline = time.time() + self.timeout
        while True:
            fd = os.open(self.path, os.O_CREAT | os.O_RDWR)
            try:
                _lock_fd(fd)
                try:
                    os.lseek(fd, 0, os.SEEK_SET)
                    os.truncate(fd, 0)
                    os.write(fd, str(os.getpid()).encode("ascii"))
                except OSError:
                    pass
                self._fd = fd
                return self
            except OSError:
                os.close(fd)
            if time.time() >= deadline:
                raise LockBusy(f"项目锁被占用且等待超时（{self.timeout}s）：{self.path}")
            time.sleep(0.15)

    def __exit__(self, *exc):
        try:
            _unlock_fd(self._fd)
        finally:
            os.close(self._fd)
        return False


# ---------------------------------------------------------------- 定位项目

def find_book_root(start=None, explicit=None):
    """定位「书目录」。

    顺序：显式 --root > 环境变量 NOVEL_BOOK_ROOT > 从 start（默认 CWD）逐级向上找
    .soloent/book.json。找不到返回 None。

    逐级向上是有意的：无论你把书目录当工作区打开，还是把作品库当工作区打开，
    只要 CWD 在书目录之内，都能找到。
    """
    if explicit:
        d = os.path.abspath(explicit)
        return d if os.path.isfile(os.path.join(d, CONFIG_REL)) else None
    env = os.environ.get("NOVEL_BOOK_ROOT")
    if env and os.path.isfile(os.path.join(os.path.abspath(env), CONFIG_REL)):
        return os.path.abspath(env)
    d = os.path.abspath(start or os.getcwd())
    for _ in range(8):
        if os.path.isfile(os.path.join(d, CONFIG_REL)):
            return d
        parent = os.path.dirname(d)
        if parent == d:
            break
        d = parent
    return None


def root_arg(argv):
    """从 argv 里取 --root <path>（同时支持 --root=<path>）。"""
    for i, a in enumerate(argv):
        if a == "--root" and i + 1 < len(argv):
            return argv[i + 1]
        if a.startswith("--root="):
            return a.split("=", 1)[1]
    return None


def strip_root_arg(argv):
    """去掉 --root 及其取值，剩下的才是工具自己的参数。"""
    out, skip = [], False
    for a in argv:
        if skip:
            skip = False
            continue
        if a == "--root":
            skip = True
            continue
        if a.startswith("--root="):
            continue
        out.append(a)
    return out


# ---------------------------------------------------------------- 配置

class Book:
    """一本书的运行时视图：配置 + 路径解析 + 通用读取。"""

    def __init__(self, root, cfg):
        self.root = root
        self.cfg = cfg

    # -- 路径 --
    def path(self, key, default=None):
        rel = (self.cfg.get("paths") or {}).get(key, default)
        if rel is None:
            return None
        return os.path.join(self.root, rel.replace("/", os.sep))

    def resolve_rule(self, rel):
        """定位 `rules.load` 里声明的一条规则文件，返回 (绝对路径, 来源) 或 None。

        **顺序：kit 资产 → 本书 `.soloent/rules/`。**
        为什么需要回落：书作者会自己在 `.soloent/rules/` 写规则（本书专属的硬口径、
        闸门流程等）。以前只查 kit 资产，于是这类规则：
          · AGENTS.md 里被渲染成 `{kit}/assets/rules/xxx.md` —— 一条**不存在的死路径**
          · SessionStart 注入时被当成「缺失文件」跳过
        两边都按「没配」处理，等于规则写了却从来没生效（2026-09-20 在某本书实测到）。

        ⚠️ kit 资产优先：共有规则以插件版本为准（避免某本书留着旧副本读到过期内容）；
        只有 kit 里**没有**时才用书里的自写副本。
        """
        rel = str(rel).replace("\\", "/")
        vault = self.vault
        if vault:
            kit_path = os.path.join(vault, "rules", rel.replace("/", os.sep))
            if os.path.isfile(kit_path):
                return kit_path, "kit"
        local = os.path.join(self.root, ".soloent", "rules", rel.replace("/", os.sep))
        if os.path.isfile(local):
            return local, "book"
        return None

    @property
    def vault(self):
        """规则与技能的根目录。

        book.json 里写 `$PLUGIN/assets` 而不是绝对路径——插件换机器/换安装位置后，
        重跑一次 `sync` 就会把所有书的 AGENTS.md 重渲染成正确路径。
        写成绝对路径也支持（老配置兼容），但不推荐。
        """
        v = str(self.cfg.get("vault") or "")
        return v.replace("$PLUGIN", PLUGIN_ROOT).replace("/", os.sep) if v else ""

    @property
    def chapters_dir(self):
        return self.path("chapters", "chapters")

    @property
    def notes_dir(self):
        return self.path("notes", "notes")

    @property
    def soloent(self):
        return os.path.join(self.root, SOLOENT)

    # -- 配置分区（带默认值，缺项不炸）--
    def sec(self, name):
        v = self.cfg.get(name)
        return v if isinstance(v, dict) else {}

    def get(self, name, key, default=None):
        v = self.sec(name).get(key)
        return default if v is None else v

    # -- 通用读取 --
    def read(self, path):
        if not path or not os.path.isfile(path):
            return None
        with open(path, encoding="utf-8-sig") as f:
            return f.read()

    def read_path(self, key, default=None):
        return self.read(self.path(key, default))

    # -- 章节 --
    @property
    def file_regex(self):
        return re.compile(self.get("chapter", "file_regex", r"^ch-(\d+)\.md$"))

    def chapter_files(self):
        """[(章号, 文件名, 全文)]，按章号升序。只收 file_regex 命中的。"""
        out = []
        d = self.chapters_dir
        if not os.path.isdir(d):
            return out
        for fn in sorted(os.listdir(d)):
            if not os.path.isfile(os.path.join(d, fn)):
                continue
            m = self.file_regex.match(fn)
            if not m:
                continue
            try:
                with open(os.path.join(d, fn), encoding="utf-8-sig") as f:
                    out.append((int(m.group(1)), fn, f.read()))
            except OSError:
                continue
        out.sort(key=lambda x: x[0])
        return out

    def stray_files(self):
        """chapters/ 下未被纳入检查的 .md（含子目录里的）——杜绝「文件在但没被查」的静默失效。"""
        out = []
        d = self.chapters_dir
        if not os.path.isdir(d):
            return out
        for fn in sorted(os.listdir(d)):
            p = os.path.join(d, fn)
            if os.path.isdir(p):
                for sub in sorted(os.listdir(p)):
                    if sub.endswith(".md"):
                        out.append(fn + "/" + sub)
                continue
            if fn.endswith(".md") and not self.file_regex.match(fn):
                out.append(fn)
        return out

    def max_chapter(self):
        fs = self.chapter_files()
        return fs[-1][0] if fs else 0


# ---------------------------------------------------------------- 配置契约

REQUIRED_PATH_KEYS = ["chapters", "canon", "ledger", "now"]


def config_problems(cfg):
    """最小结构校验（NW-P2-011）。返回问题列表，空列表 = 通过。

    只查「缺了就会让工具跑错或跑崩」的骨架项：_schema 版本、书名、关键路径、
    正文命名规则、账本列结构。正典机检项等业务数值**不在校验范围**——
    那些本来就允许为空、随写作长出（见 docs/00-总览与流程.md）。

    例外：**由插件提供的可选机检项**（panel / name_roster /
    foreshadow_check / rhythm）是固定 schema，不是「随书长出」的，所以校验类型。
    起因（2026-09-20 实测）：把 `checks.panel.max_lines` 写成字符串「十」，
    consistency_check 直接崩在 `int('十')` 上，报错是
    `invalid literal for int() with base 10: '十'`——**完全看不出是哪个键写错了**。
    """
    if not isinstance(cfg, dict):
        return ["配置根节点不是对象"]
    problems = []
    sch = cfg.get("_schema")
    if sch != SCHEMA:
        problems.append(f"_schema={sch!r} 不是当前版本 {SCHEMA}"
                        "（运行 scripts/migrate_config.py --root <书目录> 升级）")
    B = cfg.get("book")
    if not isinstance(B, dict) or not isinstance(B.get("title"), str) or not B.get("title"):
        problems.append("book.title 缺失或不是非空字符串")
    P = cfg.get("paths")
    if not isinstance(P, dict):
        problems.append("paths 段缺失（应为对象）")
    else:
        for k in REQUIRED_PATH_KEYS:
            v = P.get(k)
            if not isinstance(v, str) or not v:
                problems.append(f"paths.{k} 缺失或不是非空字符串")
    C = cfg.get("chapter")
    if not isinstance(C, dict) or not isinstance(C.get("file_regex"), str) or not C.get("file_regex"):
        problems.append("chapter.file_regex 缺失（正文文件命名规则）")
    L = cfg.get("ledger")
    if not isinstance(L, dict):
        problems.append("ledger 段缺失（应为对象）")
    else:
        cols = L.get("columns")
        if not isinstance(cols, list) or not cols or not all(isinstance(c, str) for c in cols):
            problems.append("ledger.columns 缺失或不是非空字符串列表")
        elif L.get("chapter_column", "ch") not in cols:
            problems.append(f"ledger.chapter_column={L.get('chapter_column')!r} 不在 columns 里")

    # --- 插件提供的可选机检项：类型必须对得上（错了等于机检项静默失效或直接崩）---
    problems += _optional_check_types(cfg)
    return problems


def _optional_check_types(cfg):
    """可选机检项的类型校验。返回人话问题列表（含**该怎么改**）。"""
    out = []
    C = cfg.get("checks")
    if C is None:
        return out
    if not isinstance(C, dict):
        return ["checks 段不是对象"]

    def need_num(path, value, low=0):
        """数值键：接受 int 也接受 float（阈值允许小数，如 0.5/7.0），但 bool 不算数。"""
        if value is None:
            return
        if isinstance(value, bool) or not isinstance(value, (int, float)):
            out.append(f"{path} 应为数值，当前是 {type(value).__name__}（{value!r}）")

    P = C.get("panel")
    if P is not None:
        if not isinstance(P, dict):
            out.append("checks.panel 应为对象或 null")
        else:
            need_num("checks.panel.max_lines", P.get("max_lines"), 1)
            if P.get("forbid") is not None and not isinstance(P.get("forbid"), list):
                out.append("checks.panel.forbid 应为字符串列表")
            if P.get("prefix") is not None and not isinstance(P.get("prefix"), str):
                out.append("checks.panel.prefix 应为字符串")

    R = C.get("rhythm")
    if R is not None:
        if not isinstance(R, dict):
            out.append("checks.rhythm 应为对象或 null")
        else:
            for key in ("min_chars", "min_sentences", "narr_avg_min", "narr_long_min_pct",
                        "short_ge10_max_pct", "dialogue_max_pct", "turn_min_per_1000"):
                need_num("checks.rhythm." + key, R.get(key), 0)
            if R.get("turn_words") is not None and not isinstance(R.get("turn_words"), list):
                out.append("checks.rhythm.turn_words 应为字符串列表")

    # checks.hook_check 的类型校验 2026-09-24 已删除——该机检项整项移出检查器
    # （Python 侧依赖未随迁的 brief.py，恒不生效），判据改由 TS 侧 `novel hooks` 承担。
    # 保留校验只会让 book.json 里一个没人读的键看起来「合法且有效」。

    NR = C.get("name_roster")
    if NR is not None:
        if not isinstance(NR, dict):
            out.append("checks.name_roster 应为对象或 null")
        else:
            for key in ("registered", "exempt"):
                v = NR.get(key)
                if v is not None and (not isinstance(v, list)
                                      or not all(isinstance(x, str) for x in v)):
                    out.append(f"checks.name_roster.{key} 应为字符串列表")

    F = C.get("foreshadow_check")
    if F is not None and not isinstance(F, dict):
        out.append("checks.foreshadow_check 应为对象或 null")
    return out


def load_book(argv=None, required=True):
    """加载书配置。失败时打印可执行的排查提示（而不是抛栈）。"""
    argv = list(sys.argv[1:] if argv is None else argv)
    root = find_book_root(explicit=root_arg(argv))
    if root is None:
        if required:
            _ep("⛔ 找不到书配置：从当前目录逐级向上都没有 .soloent/book.json")
            _ep("   请把 CWD 切到书目录，或显式指定：--root \"D:/1-work/novel/某本书\"")
            # 这两条路径以前写死成 `_agent/book.example.json`——那个目录早就不存在了。
            # 2026-09-24 再修一次：`init_book.py` 与 `assets/book.example.json` 在本仓
            # **都不存在**（新书初始化已改由 CLI 的 `novel init` 承担，配置由代码生成而非模板复制）。
            # 提示里指向不存在的文件，用户照做必然失败，且失败原因（路径错）与真实原因不符。
            _ep("   新书初始化：novel init --dir <书目录> --title <书名> "
                  "[--genre <题材>] [--platform <平台>]")
            _ep("   （该命令会一并生成 .soloent/book.json 与三份待填的风格/红线文件）")
            fail_config("找不到书配置：从当前目录逐级向上都没有 .soloent/book.json")
        return None
    p = os.path.join(root, CONFIG_REL)
    try:
        with open(p, encoding="utf-8-sig") as f:
            cfg = json.load(f)
    except (OSError, ValueError) as e:
        _ep(f"⛔ 配置读不了：{p}\n   {e}")
        fail_config(f"配置读不了：{p}", root, [str(e)])
    # 结构校验失败一律拒绝（失败关闭）。以前只对 _schema 打警告继续跑——
    # 拼错列名 / 缺路径会让工具在深水区才炸，或静默检查错对象。
    problems = config_problems(cfg)
    if problems:
        _ep(f"⛔ 配置结构校验未通过：{p}")
        for pr in problems:
            _ep("   - " + pr)
        _ep("   修复：python <插件>/scripts/migrate_config.py --root \"" + root + "\"")
        if required:
            fail_config(f"配置结构校验未通过：{p}", root, problems)
        return None
    return Book(root, cfg)


# ---------------------------------------------------------------- 通用工具

CJK = re.compile(r"[\u4e00-\u9fff]")
_CN = {"一": 1, "二": 2, "三": 3, "四": 4, "五": 5, "六": 6, "七": 7,
       "八": 8, "九": 9, "十": 10, "百": 100}


def hanzi_count(text):
    """汉字数（不含标点、数字、字母）。"""
    return len(CJK.findall(text or ""))


def cn2int(s):
    """中文数字 -> int（一~九十九、一百）。非法返回 None。"""
    if not s or any(c not in _CN for c in s):
        return None
    section, num = 0, 0
    for c in s:
        v = _CN[c]
        if v == 10:
            section += (num or 1) * 10
            num = 0
        elif v == 100:
            section = (section + (num or 1)) * 100
            num = 0
        else:
            num = v
    return (section + num) or None


def near(line, words, idx, window):
    """line 中是否有 words 里的词出现在距 idx <= window 的位置。"""
    for w in words:
        start = 0
        while True:
            p = line.find(w, start)
            if p < 0:
                break
            if abs(p - idx) <= window:
                return True
            start = p + 1
    return False


def to_int(v):
    """宽松取整：允许千分位、下划线、空白。失败返回 None。"""
    n = to_num(v)
    return None if n is None else int(n)


def to_num(v):
    """宽松取数：**保留小数**（int 优先，带小数点才返回 float）。失败返回 None。

    为什么不能一律取整：账本里 `58.5` 这类值被截成 58 之后，
    与正典锚点 58.5 的比对会全部误报——这个坑已经踩过一次。
    """
    if v is None:
        return None
    s = str(v).strip().replace(",", "").replace("_", "")
    if not s or s in ("—", "-", "?", "None", "null"):
        return None
    try:
        f = float(s)
    except ValueError:
        return None
    return int(f) if f.is_integer() else f


SEV_ORDER = {"严重": 0, "中等": 1, "轻微": 2, "提示": 9}

# 「风格类」发现的判定在 consistency_check.is_style_finding（它拥有句式禁项名单
# AI_STRUCT_PATTERNS；锁定细节的 rule 同样以「[名]」开头，分类器必须能区分两者——
# 2026-09-21 实测：放 kit 里靠 [前缀 判断会把硬口径误降级）。


# ---------------------------------------------------------------- 写作前置体检
#
# 2026-09-20 复盘的教训：这套工具会认真检查「文件在不在、生成物新不新」，
# 却从不检查「风格/红线层填了没」。实测某书 `story-style.md` 与 `MASTER.md`
# 与模板 **byte 级完全一致**、`checks.rhythm` 还是 null，照样 doctor 24/0/0
# 写完 69 章——于是「去 AI 味」从第一天起就是空的。
#
# 判据只放在这一处：doctor（会话体检，报警告）与 brief（写前接地，拦死）共用，
# 避免两处各写一套「填没填」的判断而慢慢分叉。

# (book.json paths 键, 约定默认路径, 人读名称, 对应模板文件)
STYLE_DOCS = [
    ("style", ".soloent/rules/story-style.md", "本书风格规则（最高优先级）", "story-style.md"),
    ("constitution", ".soloent/constitution/MASTER.md", "创作宪法", "MASTER.md"),
    ("expectation", "1-边界/预期.md", "开书预期（防跑偏锚点）", "预期.md"),
]

# 模板/骨架里表示「待你填写」的标记，出现即视为没填
# ⚠️ 全角右括号那条（"待填）"）是 2026-09-24 补的：原先只收了半角的 "待填)"，
# 而 `novel init` 写进 canon.md / now.md 的恰恰是**全角**「（待填）」——
# 于是最常见的那一种占位符反而不在词表里。词表少一条的后果不是报错，
# 是闸门对最常见的占位写法视而不见，正是「守卫在但不生效」的经典形态。
PLACEHOLDER_MARKS = ("✏️", "此处待填", "待填：", "待填)", "待填）", "（未填", "(未填")


def style_doc_issues(root, cfg=None):
    """风格/红线层「填了没」。返回 [(级别, 相对路径, 说明)]，级别 ∈ {"block", "warn"}。

    **级别是「原因类别」，不是「是否拦截」**——是否拦截见 style_gate_ready()。
      block = 有占位符没填 / 文件缺失或为空
      warn  = 与插件模板一字不差（说明从没动过；理论上可能是作者有意采用通用模板）
    两者都不静默——这是本次事故的根因。
    """
    out = []
    paths = (cfg or {}).get("paths") or {}
    for key, default, label, tpl_name in STYLE_DOCS:
        rel = str(paths.get(key) or default)
        p = os.path.join(root, rel)
        text = ""
        if os.path.isfile(p):
            try:
                with open(p, encoding="utf-8-sig") as f:
                    text = f.read()
            except OSError:
                text = ""
        if not text.strip():
            out.append(("block", rel, f"{label}缺失或为空"))
            continue
        hit = next((m for m in PLACEHOLDER_MARKS if m in text), None)
        if hit:
            out.append(("block", rel, f"{label}仍含占位符「{hit}」"))
            continue
        tpl_path = os.path.join(TEMPLATES, tpl_name)
        try:
            if os.path.isfile(tpl_path):
                with open(tpl_path, encoding="utf-8-sig") as f:
                    if f.read() == text:
                        out.append(("warn", rel, f"{label}与插件模板一字不差（等于没填）"))
        except OSError:
            pass
    return out


def style_gate_ready(root, cfg=None):
    """写正文前的硬判据：风格/红线层必须「存在且填过」。返回 (就绪?, [未就绪说明])。

    ★判据是「一条 issue 都没有」，**不是**「没有 block」。

    为什么必须这样收口（2026-09-24 修）：原先只把 block 计入未就绪，于是
    「把文件删掉」就成了一条绕过闸门的路径——对下游而言「有占位符」与「文件缺失」
    完全等价（都是零文风依据），却只有前者拦人。这正是本项目反复在堵的那类假绿：
    **判据形状不同，就会被挑软的那条走**。级别仍保留，只为在报告里说清原因类别。
    """
    issues = style_doc_issues(root, cfg)
    bad = [f"{rel}：{why}" for _lvl, rel, why in issues]
    return (not bad), bad


def str_bytes(text):
    """UTF-8 字节数——注入预算按字节算（中文字符不是 1 字节）。"""
    return len((text or "").encode("utf-8"))


# ---------------------------------------------------------------- 拆书（写作边界）

# 转折/关联词默认表（句长节奏的「转折词密度」用它）。**唯一来源**——
# init_book 写新书默认值、consistency_check 算读数都用这一份，别各抄一遍。
# ⚠️ 不收歧义单字：「可」绝大多数是「可以/可能/许可」，「倒」多为「倒下/摔倒」——
# 实测某比对里「可」占了词表计数的 42%，把两边的转折词密度都灌成假的（2026-09-20）。
# 宁可少收，也不要让一个高频非转折字主导这个指标。
DEFAULT_TURN_WORDS = ["但是", "可是", "不过", "只是", "倒是", "偏偏", "反而", "却", "然而",
                      "其实", "毕竟", "反正", "何况", "再说", "不然", "要不", "哪怕", "就算",
                      "虽说", "既然", "于是", "结果", "到底", "横竖", "干脆", "索性"]

# 实际命名习惯多带「样板书前缀」：`刷怪-1.1_开篇梗概.md`、`凡人-1.2_文风.md`。
# 只认行首会把这些**真做过拆书**的书误判成「没拆」——2026-09-20 在真实书库里实测到，
# 差点用错误的判据去拦两本已经拆过书的稿子。所以按「文件名里含 N.M_ 段」判。
BREAKDOWN_MARK = re.compile(r"(?<![\d.])\d+\.\d+_")
PLACEHOLDER_HINTS = ("✏️", "待填", "（未填", "(未填", "TODO", "同书名")


def breakdown_artifacts(root):
    """`1-边界/` 下的拆书成果。

    认两种命名：`1.1_开篇拆解.md` 与 `刷怪-1.1_开篇梗概.md`（带样板书前缀）。
    只扫一层子目录（`1-边界/某书/1.1_….md` 也算），不做深度递归。
    """
    base = os.path.join(root, "1-边界")
    out = []
    try:
        entries = sorted(os.listdir(base))
    except OSError:
        return []
    for fn in entries:
        p = os.path.join(base, fn)
        if os.path.isdir(p):
            try:
                for sub in sorted(os.listdir(p)):
                    if sub.endswith(".md") and BREAKDOWN_MARK.search(sub):
                        out.append(fn + "/" + sub)
            except OSError:
                continue
            continue
        if fn.endswith(".md") and BREAKDOWN_MARK.search(fn):
            out.append(fn)
    return out


def declared_benchmarks(root, cfg=None):
    """预期里声明的「对标作品」文本（没有则返回空串）。

    判据：`1-边界/预期.md` 里含「对标」的行，冒号后面有实质内容（不是占位符）。
    """
    paths = (cfg or {}).get("paths") or {}
    rel = str(paths.get("expectation") or os.path.join("1-边界", "预期.md"))
    text = ""
    try:
        with open(os.path.join(root, rel), encoding="utf-8-sig") as f:
            text = f.read()
    except OSError:
        return ""
    for line in text.splitlines():
        if "对标" not in line:
            continue
        body = line.split("：", 1)[-1].split(":", 1)[-1].strip()
        body = body.strip("*_ ").strip()
        if body and not any(h in body for h in PLACEHOLDER_HINTS):
            return body
    return ""


def boundary_issues(root, cfg=None):
    """写作边界（拆书）是否做过。返回 [(级别, 说明)]，级别 ∈ {"block", "warn"}。

    为什么需要（2026-09-20 复盘）：`1-边界/预期.md` 里明明写着
    「对标《我有一座冒险屋》的钩子密度 +《全球高武》的数值纪律」，
    而 `1-边界/` 下**没有任何拆书成果**，书照样写到 69 章——
    对标停在口号层，模型只能回归概率最高的写法，于是「一点新意都没有」。

    强度分档（不搞一刀切）：
      · 预期声明的对标 → **没拆就 block**（你说了要对标，就得真的拆过）
      · 没声明对标 → 只 warn（"没有样板书"本来就是允许的起点）
      · `book.json` 的 `boundary.opt_out_reason` 有内容 → 一律放过（拍板留档过）
    """
    reason = str(((cfg or {}).get("boundary") or {}).get("opt_out_reason") or "").strip()
    if reason:
        return []
    arts = breakdown_artifacts(root)
    if arts:
        return []
    bench = declared_benchmarks(root, cfg)
    if bench:
        return [("block",
                 f"预期里声明了对标作品（{bench[:40]}），但 1-边界/ 下没有任何拆书成果"
                 f"（应为 1.1_开篇拆解.md 这类文件）——对标不能停在口号层。"
                 f"要么按 docs/02 走一遍拆书，要么在 book.json 的 "
                 f"boundary.opt_out_reason 写明为什么不拆")]
    return [("warn",
             "没有拆书成果（1-边界/ 下无 1.1_… 这类文件），预期里也没声明对标作品——"
             "缺写作边界的参照系，容易写成「平均值」。至少拆一次开篇，或写明不需要")]



def rules_budget_issues(root, cfg=None, max_bytes=None):
    """规则注入预算体检。返回 [(级别, 说明)]，级别 ∈ {"block", "warn"}。

    为什么需要（2026-09-21 ch-33 复盘）：`inject_canon.collect_rules` 在预算耗尽时
    会**按列表顺序跳过**后面的规则文件——实测高武 12 个文件只注入了 7 个，
    被挤掉的恰是 `style-urban` 这类题材文风规则；仙侠更极端，只注入 3/11。
    而这件事**此前没有任何一处会报警**：书照写，质量差，谁也看不出原因。

    判据（与 inject_canon 同源，不另立一套）：
      · 按 `rules.base_rules` 分层估算每层体积
      · 底座层超份额 → block（底座缺失 = 写手在无风格约束状态下动笔）
      · 题材层超预算 → warn（逐条点名，作者据此压缩）
    """
    rules = (cfg or {}).get("rules") or {}
    load = [str(x) for x in (rules.get("load") or [])]
    if not load:
        return []
    base_set = {str(x) for x in (rules.get("base_rules") or [])}
    vault = (cfg or {}).get("vault") or ""
    base_dir = os.path.join(vault, "rules") if vault else ""
    if not base_dir or not os.path.isdir(base_dir):
        return []   # 目录读不到的事由 inject_canon 报，别重复

    if max_bytes is None:
        # 与 hooks/inject_canon.py 同源；读不到就跳过（不硬编码一个会漂的数字）
        try:
            import importlib.util
            hp = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))),
                              "hooks", "inject_canon.py")
            spec = importlib.util.spec_from_file_location("_ic_budget", hp)
            mod = importlib.util.module_from_spec(spec)
            spec.loader.exec_module(mod)
            max_bytes = mod.MAX_RULES_BYTES
            share = getattr(mod, "BASE_RULES_SHARE", 0.7)
        except Exception:
            return []
    else:
        share = 0.7

    def _size(rel):
        # kit 资产优先，其次本书 .soloent/rules/（与 book.resolve_rule 同序）
        for p in (os.path.join(base_dir, rel.replace("/", os.sep)),
                  os.path.join(root, ".soloent", "rules", rel.replace("/", os.sep))):
            if os.path.isfile(p):
                try:
                    with open(p, encoding="utf-8-sig") as f:
                        return len(f.read().strip().encode("utf-8"))
                except OSError:
                    return 0
        return 0

    base_total = sum(_size(r) for r in load if r in base_set)
    genre_total = sum(_size(r) for r in load if r not in base_set)
    base_pool = int(max_bytes * share)
    out = []
    if base_total > base_pool:
        out.append(("block",
                    f"规则底座层体积 {base_total}B 超过份额 {base_pool}B——"
                    f"会导致底座内某些文件被静默跳过，写手在缺规则状态下动笔。"
                    f"请压缩（把定案复盘移到 notes/），或减少 base_rules 条目"))
    if base_total + genre_total > max_bytes:
        over = base_total + genre_total - max_bytes
        out.append(("warn",
                    f"规则总量 {base_total + genre_total}B 超注入上限 {max_bytes}B "
                    f"（超 {over}B）——题材规则可能被跳过，跑 `python hooks/inject_canon.py` "
                    f"看具体缺哪些；建议把各书 story-style 里的定案复盘移到 notes/"))
    return out


def sort_findings(findings):
    return sorted(findings, key=lambda x: (SEV_ORDER.get(x[0], 9), str(x[1]), x[2] if isinstance(x[2], int) else 0))


def count_sev(findings):
    c = {"严重": 0, "中等": 0, "轻微": 0}
    for f in findings:
        c[f[0]] = c.get(f[0], 0) + 1
    return c


def write_report(book, findings, title, tag=""):
    """把机检结果写成 notes/<title>[-tag]-YYYY-MM-DD.md，返回 (路径, 摘要文本)。

    `tag` 用来区分**同时可能运行的入口**——落盘钩子与后台 watcher 会在同一秒
    都对账一次，不带 tag 的话它们会互相覆盖同一个文件。
    """
    import datetime
    today = datetime.date.today().isoformat()
    c = count_sev(findings)
    tail = f" ｜ 提示 {c['提示']}（起草自由 · 不计入拦截）" if c.get("提示") else ""
    lines = [f"# {title}（{today}）\n",
             f"扫描章节：{len(book.chapter_files())} 章 ｜ "
             f"严重 {c['严重']} · 中等 {c['中等']} · 轻微 {c['轻微']}{tail}\n"]
    for sev in ("严重", "中等", "轻微", "提示"):
        rows = [f for f in findings if f[0] == sev]
        if not rows:
            continue
        lines.append(f"\n## {sev}（{len(rows)}）\n")
        lines.append("| 章 | 行 | 规则 | 摘录 |")
        lines.append("| --- | --- | --- | --- |")
        for _, fn, ln, rule, snap in rows:
            lines.append(f"| {fn} | {ln} | {rule} | {snap} |")
    report = "\n".join(lines)
    d = book.notes_dir
    os.makedirs(d, exist_ok=True)
    name = f"{title}-{tag}-{today}.md" if tag else f"{title}-{today}.md"
    dst = os.path.join(d, name)
    # 原子替换：并发入口共享同一份当日报告，中断/竞争不能留下半截 Markdown
    atomic_write_text(dst, report)
    return dst, report


def append_trend(book, findings):
    """把本次严重/中等/轻微计数写到 notes/对账趋势.csv（**一行一天**）。

    为什么要趋势：只有当天的快照看不出"黑名单词是在增加还是在减少"。
    一行一天累积起来，才看得出漂移方向。

    ⚠️ **同日覆盖，不重复追加**：本函数每次对账都会被调用（watcher 轮询、落盘钩子、
    手动跑都算）。早期实现是无脑 append —— 2026-09-18 一天就写了 **45 行完全相同的记录**，
    趋势被自己的噪音淹掉，反而看不出方向（注释写着"一行一天"，代码却没做到）。

    ⚠️ **调用方必须已持有 `report` 项目锁**：这是「读全表 → 改一行 → 重写全表」，
    并发时无锁会丢更新或写坏 CSV。锁由 consistency_check.main 统一获取（报告 +
    趋势一次持锁），子检查跑在 preflight 的 `preflight` 锁内，两者异名不会自锁。
    """
    import csv
    import datetime
    c = count_sev(findings)
    d = book.notes_dir
    os.makedirs(d, exist_ok=True)
    p = os.path.join(d, "对账趋势.csv")
    today = datetime.date.today().isoformat()
    row = [today, c["严重"], c["中等"], c["轻微"], len(book.chapter_files())]

    header, rows = None, []
    if os.path.isfile(p):
        try:
            with open(p, encoding="utf-8-sig", newline="") as f:
                all_rows = [r for r in csv.reader(f) if r]
            if all_rows:
                header, rows = all_rows[0], all_rows[1:]
        except (OSError, ValueError):
            header, rows = None, []
    if header is None:
        header = ["日期", "严重", "中等", "轻微", "扫描章数"]
    # 顺手做一次全表去重（清掉历史遗留的同日重复行），再决定是覆盖还是追加
    seen, dedup = {}, []
    for r in rows:
        if not r:
            continue
        if r[0] in seen:
            dedup[seen[r[0]]] = r
        else:
            seen[r[0]] = len(dedup)
            dedup.append(r)
    rows = dedup
    if rows and rows[-1] and rows[-1][0] == today:
        rows[-1] = row
    else:
        rows.append(row)
    # 统一写 utf-8-sig：整表重写，BOM 只会有一个（早期"追加时用 utf-8 免得多个 BOM"
    # 的做法在改成整表重写后已无必要）
    try:
        atomic_write_text(p, _csv_text(header, rows), encoding="utf-8-sig")
    except OSError:
        pass
    return p


def _csv_text(header, rows):
    import csv
    import io
    buf = io.StringIO()
    w = csv.writer(buf, lineterminator="\n")
    w.writerow(header)
    w.writerows(rows)
    return buf.getvalue()


def read_stdin_json():
    """读 stdin 的 JSON（hook 用）。失败返回 {}。"""
    try:
        return json.loads(sys.stdin.read() or "{}")
    except (ValueError, OSError):
        return {}


def emit_hook(event, text):
    """输出 hook 协议（严格 schema：多一个键就会校验失败被丢弃）。"""
    print(json.dumps({"hookSpecificOutput": {"hookEventName": event, "additionalContext": text}},
                     ensure_ascii=False))


def force_utf8():
    try:
        sys.stdout.reconfigure(encoding="utf-8")
    except Exception:
        pass


def run_child(script, book_root, extra=None, timeout=180):
    """跑插件里的另一个脚本（与 kit.py 同级）。

    返回 `(rc, out, present)`：
    - `rc`      退出码。**脚本缺失时返回 -2（不是 0）**——缺失绝不能被当成"通过"。
    - `out`     stdout + stderr 合并文本。
    - `present` 脚本是否存在（bool）。⚠️ 这是 bool，不是 stderr 文本。
                调用方若不需要它，写 `_` 即可；**不要**当字符串用（`.strip()` 会炸）。
    """
    p = os.path.join(KIT_ROOT, script)
    if not os.path.isfile(p):
        # ⚠️ 曾经这里返回 0——那会让"子脚本缺失"被上层当成校验通过（假通过）。
        # 闸门的整个意义就是拦住意外，这里必须报错。
        return -2, f"[kit] 子脚本不存在：{script}（插件安装不完整？）", False
    import subprocess
    cmd = [sys.executable, p, "--root", book_root] + (extra or [])
    try:
        r = subprocess.run(cmd, capture_output=True, text=True, encoding="utf-8", timeout=timeout)
        return r.returncode, (r.stdout or "") + (r.stderr or ""), True
    except subprocess.TimeoutExpired:
        return -3, f"[kit] 子进程超时（>{timeout}s）：{script}", True
    except Exception as e:
        return -1, f"[kit] 子进程失败：{e}", True
