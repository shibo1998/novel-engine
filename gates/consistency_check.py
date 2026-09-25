#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
一致性对账 (consistency_check.py) —— 单章内机检

用途：对 chapters/ 做机检，暴露「设定漂移」与「质量欠账」，每条给行号便于人工判定。
设计原则：
  1. 宁可多报「疑似」，不放过硬伤。
  2. **机检项清单以本脚本 --list-checks 输出为唯一来源**，各文档不复述（避免代码改了文档没改）。
  3. 全部正典值来自 <书>/.soloent/book.json，本文件不含任何本书内容。

用法：
    python <kit>/tools/consistency_check.py                    # 全部正文
    python <kit>/tools/consistency_check.py ch-08 ch-10        # 只查指定章
    python <kit>/tools/consistency_check.py --list-checks      # 打印机检项清单
    python <kit>/tools/consistency_check.py --root <书目录>    # 指定项目
输出：控制台摘要（stderr）+ 最终 JSON（stdout）
退出码：0=跑完（有问题也返回 0，问题数由摘要行体现，供上层解析）
        2=这次检查**根本没发生**（书根指错 / 配置不合法 / 筛选没匹配到任何章）。
          此时 stdout 仍会给出书级 finding（如 no-chapters-found），但退出码与
          「跑完且没问题」明确区分——「什么都没查到」绝不许长得像「查了没问题」。
"""
import json
import os
import re
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import kit  # noqa: E402


def _ep(*args, **kwargs):
    """gates 契约：人类可读输出一律走 stderr，stdout 只留最终 JSON。"""
    print(*args, file=sys.stderr, **kwargs)


# ------------------------------------------------------------- AI 句式结构
# 源：content/rules/ai-anti-patterns.md 的「句式类（结构级）」（全局规则，与具体书无关，故内置）。
# 为什么单列一档：book.json 的 blacklist 只覆盖**词级**（23 词），句式结构此前完全无机检，
# 只能靠人/AI 自觉。2026-09-19 实测：ch-32 机检「严重 0 中等 0 轻微 0」，
# 却含 7 处句式违规（否定排比／裁判腔／排比三联／抽象情绪／柔化副词／忽然／结尾三联）。
# 级别定「轻微」：提示人工判定，不拦闸门（句式有语境例外，不能一刀切判错）。
AI_STRUCT_PATTERNS = [
    ("否定排比", r"不是[^，。！？]{1,12}，不是",
     "否定排比「不是A，不是B，是C」——改为写具体可检验的事实"),
    ("裁判腔", r"他知道|她知道|心里清楚|心里明白|他不知道的是",
     "「他知道」裁判腔——改为用行为暴露想法"),
    ("柔化副词", r"缓缓|微微|轻轻|悄悄|默默",
     "柔化副词——改为直接动词，或给动作加变化节奏"),
    ("时间切片", r"一瞬间|刹那|这一刻|那一刻",
     "时间切片——改为用声音、动作的起伏递进"),
    ("眼睛文学", r"眸子|眸光|眼底划过",
     "眼睛文学——改为可检验的动作"),
    ("空气时间拟态", r"空气(仿佛|似乎)?凝固|时间(仿佛|似乎)?静止|鸦雀无声",
     "空气/时间拟态——改为写声音的空洞"),
    ("推拉垫字", r"还没等|只听得",
     "推拉连词垫字——起手直接陈述物理事实"),
]


# 机检可见的「去 AI 味」残留类别（B3 句法自查应当清零的那一类）。
# preflight 的流程留痕对撞（flow_trace）用它判定「留痕宣称自查完成却有残留」。
# 为什么单列：2026-09-20 复盘——69 章留痕几乎全报 0/1，正文却残留 63 处黑名单词。
# 格式合法 ≠ 真跑过；这一组就是「真跑过自查就不该剩下」的机检集合。
_AI_STRUCT_IDS = frozenset(sid for sid, _, _ in AI_STRUCT_PATTERNS)


# 起草自由模式（gate.draft_free）下可降级为「提示」的风格类发现。
# ⚠️ 与上方 is_style_finding（留痕对撞口径）不同：这里额外含「句长节奏/转折词密度」，
# 且句式 tag 用 AI_STRUCT_IDS 判定——锁定细节（[测试锁定] 等）不是风格类，任何模式都拦。
_DRAFT_FREE_STYLE_PREFIXES = ("句长节奏", "转折词密度", "面板条目", "面板文体", "面板结论文案",
                              "AI句式/黑名单词", "比喻词堆砌", "章末升华", "同段连发")


def is_draft_free_style_finding(rule):
    r = str(rule)
    m = re.match(r"\[([^\]]+)\]", r)
    if m:
        return m.group(1).strip() in _AI_STRUCT_IDS
    return r.startswith(_DRAFT_FREE_STYLE_PREFIXES)


def is_style_finding(rule):
    """该条机检发现是否属于「去 AI 味」类别（供 preflight 留痕对撞用）。

    认六类：黑名单词、AI 句式结构、同段连发、比喻堆砌、章末升华、面板文体。
    不含句长节奏——那是 B4（节奏控制）的辖区，且阈值待样板书校准，不参与对撞。
    """
    r = rule or ""
    m = re.match(r"\[([^\]]+)\]", r)
    if m and m.group(1) in _AI_STRUCT_IDS:
        return True
    return (r.startswith("AI句式/黑名单词")
            or "同段连发" in r or "比喻词堆砌" in r
            or "章末升华" in r or "面板条目" in r)


def _bigrams(text, limit=60):
    """中文二元组——用来做「承诺 vs 交付」的粗粒度词面核对。

    为什么用二元组：中文没有词边界，取 2 字滑窗是唯一不需要分词的稳妥做法。
    它只用来判「有没有交集」，不判语义，所以宁可粗。
    """
    out, seen = [], set()
    for i in range(max(0, len(text) - 1)):
        t = text[i:i + 2]
        if not re.match(r"^[\u4e00-\u9fff]{2}$", t) or t in seen:
            continue
        seen.add(t)
        out.append(t)
        if len(out) >= limit:
            break
    return out


def _canon_names(book):
    """从 canon.md 的「人物」节表格里取登记名册。

    ⚠️ **列位不是固定的**：常见两种写法——
      · `| 林澈 | 林澈 | 林彻 | 定位 |`（名字在第 0 列）
      · `| 主角 | 林小满 | — |`（第 0 列是身份标签，第 1 列才是名字）
    认错列会把「主角／父亲／教官」当成角色名去比对人物卡，全盘假报。
    所以列位可配：`checks.name_roster.name_column`（默认 0）。
    """
    raw = book.read_path("canon") or ""
    try:
        col = int((book.sec("checks").get("name_roster") or {}).get("name_column", 0) or 0)
    except (TypeError, ValueError):
        col = 0
    names, in_sec = [], False
    for line in raw.splitlines():
        if re.match(r"^##\s+", line):
            in_sec = ("人物" in line or "角色" in line)
            continue
        if not in_sec or not line.strip().startswith("|"):
            continue
        cells = [c.strip() for c in line.strip().strip("|").split("|")]
        if len(cells) <= col or not "".join(cells).strip("-: "):
            continue
        name = re.sub(r"[*`\[\]]", "", cells[col]).strip()
        # 去掉紧跟的括号注解：`许昂（高二3班，C 级）`→`许昂`、`顾清和（女性，A⁻ 级）`→`顾清和`
        name = re.sub(r"\s*[（(].*$", "", name).strip()
        # 表头/占位行：`| 项 | 正典值 | … |`、初始化模板的 `| ✏️主角 | | | |`
        if not name or "✏️" in name or name in (
                "角色", "姓名", "人物", "编号", "项", "正典值", "禁用/错误写法",
                "说明", "定位", "备注", "常见错写", "唯一写法"):
            continue
        if 1 <= len(name) <= 6 and re.search(r"[\u4e00-\u9fff]", name):
            names.append(name)
    return names


def _roster_completeness(book, C, add):
    """登记完整性：`canon.md` 人物表 ／ `checks.name_roster.registered` ／ `characters/` 三方互校。

    为什么是这个判据（而不是「从正文里抽人名」）：
    2026-09-20 先试了「正文里 X说/道/问 → 检查是否登记」，实测在本书产出
    **200+ 条全假**（`不知道`切出「不知」、`也没回头`切出「都没」…）——
    中文没有词边界，2-3 字滑窗必然切碎常用词。那是把闸门写成噪音源，宁可换判据。
    改成三方互校（全是确定性比对，零猜测）：
      ① canon 登记了 → characters/ 必须有卡
      ② 登记册（作者维护的「本书有谁」）里有 → canon 必须登记、且必须有卡
    ② 正是本次事故的入口：canon 与人物卡都停在第 30 章，
    后面 39 章冒出来的苏映雪、簿房、白苇、陈守拙、苏鸿年、关海年**两边都没有**。
    """
    R = C.get("name_roster") or {}
    if not R or not R.get("enabled", True):
        return
    canon_names = _canon_names(book)
    roster = [str(x).strip() for x in (R.get("registered") or []) if str(x).strip()]
    if not canon_names and not roster:
        return
    cards = os.path.join(book.root, "characters")
    blob = ""
    if os.path.isdir(cards):
        for fn in sorted(os.listdir(cards)):
            if fn.endswith(".md"):
                blob += (book.read(os.path.join(cards, fn)) or "")

    no_card = [n for n in dict.fromkeys(canon_names + roster) if n not in blob]
    if no_card:
        add("轻微", "（人物卡）", 0,
            f"{len(no_card)} 个角色在 canon／登记册里，但 characters/ 下找不到卡："
            + "、".join(no_card[:8]) + ("…" if len(no_card) > 8 else ""),
            "人物卡是「谁能说什么、定位是什么」的事实来源；缺卡的角色最容易前后写成两个人")
    not_in_canon = [n for n in roster if n not in canon_names]
    if not_in_canon:
        add("轻微", "（正典）", 0,
            f"{len(not_in_canon)} 个角色在登记册里，canon.md 人物表却没登记："
            + "、".join(not_in_canon[:8]) + ("…" if len(not_in_canon) > 8 else ""),
            "正典是唯一事实来源；新角色只写在正文里，几十章后就会被写成另一个人")


# 2026-09-24 删除 `_hook_check`（原 194-223 行）。删因：
#   ① 它靠 `import brief` 取细纲钩子，而 `brief.py` 未随迁、全仓不存在；
#      外层 `except Exception: return` 把 ImportError 一并吞掉 → **恒不生效且毫无提示**。
#   ② 同一判据已在 TS 侧重新实现：`packages/core/src/hooks.ts`（213 行 + 10 项测试），
#      且成熟度更高——它带了实测 34 章人工对账后定的纪律（只报线索不当结论、
#      不接 CI 硬失败、锚词剔除人名、片段匹配而非整串全等），见
#      `docs/ne-架构与契约.md §7.2`「边界比功能重要」。
#   ③ 留两份实现正是本仓禁止的「同一判据两份副本」；且两份都不生效。
# 处置：删 Python 这份，改由 `novel hooks` 出**只读报告**（不计入拦截、不影响退出码，
# 守住 §7.2 的纪律）。本检查器从此不再产出 hook 类 finding。


# 伏笔回收总表**没有规范 schema**——两本真书的列名与列序都不一样：
#   高武 | 伏笔 | 埋设 | 半引爆 | 状态 |            埋设值形如 "6（首金）/ 23（闪回）"
#   仙侠 | 伏笔内容 | 埋设位置 | 预期收回 | 状态 | 备注 |  埋设值形如 "第 1 / 16 / 38 章"
# 旧实现写死「第 3 列、且必须是裸整数」，于是**两本书一行都解析不出来**，
# 还静默返回 0 条——2026-09-25 实测：真书打开开关后 0 findings，看着像「查了没问题」。
# 这与本仓反复在治的「查不到 = 没问题」是同一个病，只是这次发生在解析层。
# 改为：① 按表头里含「埋设」的那一列定位（不写死列号，两本书都能对上）；
#       ② 从该列**宽松抽取**所有数字（兼容 第80章／6（首金）／33–34／1 / 16 / 38）。
# 仍然只是词面口径，不判语义；判不出东西时由 note 显式说明，绝不再静默。


def _foreshadow_rows(book):
    """解析伏笔回收总表 → `([(伏笔名, [章号...]), ...], note)`。

    note 非空 = **一条都没解析出来**，且说明卡在哪。调用方必须把它显示出来——
    「0 条发现」与「0 条输入」形状不同，这是本项目的硬规矩。
    """
    raw = book.read_path("foreshadow")
    if not raw:
        return [], "伏笔表读不到（book.json 的 paths.foreshadow 指向的文件不存在）"
    lines = [l.strip() for l in raw.splitlines() if l.strip().startswith("|")]
    if not lines:
        return [], "伏笔表里没有任何表格行"

    # ① 定位「埋设」列：取表头行里含「埋设」的那一格（兼容「埋设」与「埋设位置」）
    col = None
    for l in lines:
        cells = [c.strip() for c in l.strip("|").split("|")]
        idx = [i for i, c in enumerate(cells) if "埋设" in c]
        if idx:
            col = idx[0]
            break
    if col is None:
        return [], "伏笔表里找不到含「埋设」的表头列（无从判断哪一列是埋设章号）"

    rows = []
    for l in lines:
        if "---" in l:
            continue
        cells = [c.strip() for c in l.strip("|").split("|")]
        if len(cells) <= col or "埋设" in cells[col]:
            continue                       # 表头行 / 列数不够的行
        name = re.sub(r"[*_`]", "", cells[0]).strip()
        chs = [int(x) for x in re.findall(r"\d+", cells[col])]
        if name and chs:
            rows.append((name, chs))
    if not rows:
        return [], (f"表头「埋设」在第 {col + 1} 列，但没有任何一行的该列含章号"
                    "（认「6（首金）」「第 1 / 16 / 38 章」「33–34」这几种写法）")
    return rows, ""


def _foreshadow_check(book, C, chno, fn, text, add):
    """伏笔回收总表标了「埋设于第 N 章」，就该在第 N 章找到它的线索词。

    只做词面交集，判「有没有」不判「好不好」；零交集才报，属提示级。
    口径的天然局限要说清：作者可能**故意**把伏笔埋得很轻——仙侠的伏笔表就明写
    「埋得越轻越好，不许加任何提示性描写」。那种情况下词面零交集未必是漏埋，
    所以它只当线索，不作结论（与 `novel hooks` 同一纪律）。
    """
    F = C.get("foreshadow_check") or {}
    if not F or not F.get("enabled", True):
        return
    rows, _note = _foreshadow_rows(book)
    for name, chs in rows:
        if chno not in chs:
            continue
        toks = _bigrams(re.sub(r"[（(].*?[)）]", "", name))
        if toks and not any(t in text for t in toks):
            add("轻微", fn, 0,
                f"伏笔「{name}」标了埋设于第 {chno} 章，但本章找不到它的任何线索词"
                "——要么没埋，要么表没回填", name)


# ------------------------------------------------------------------ 检查

def check(book, chapters):
    """返回 [(严重度, 文件名, 行号, 规则, 摘录)]"""
    C = book.sec("checks")
    out = []

    # 归一化：允许 dict / list 两种写法
    name_bad = C.get("name_bad") or {}
    role_bad = C.get("role_bad") or []
    number_bad = C.get("number_bad") or []
    intel_bad = C.get("intel_bad") or {}
    gated = C.get("gated_keywords") or []
    unit = C.get("unit_conflicts") or {}
    timeline = C.get("timeline_bad") or []
    age_ctx = C.get("age_context_bad") or []
    scale = C.get("scale") or {}
    scale_near = C.get("scale_near") or {}
    locked = C.get("locked_details") or []
    blacklist = C.get("blacklist") or []
    elev = C.get("elevation") or {}
    rare = C.get("rare_chars") or {}
    quote = C.get("quote_style") or {}
    word_max = book.get("chapter", "word_max", 3000)
    # 字数下界（F19）。默认给一个**故意很低**的值：它不是文风下限，
    # 而是「这个文件还不是一章」的存在性断言——正常章 2300+ 字，50 字以下只可能是空壳。
    word_min = book.get("chapter", "word_min", 50)
    title_re = book.get("chapter", "title_regex")
    title_hint = book.get("chapter", "title_hint", "# 第0XX章 标题")
    exempt = {(f, int(l)) for f, l, *_ in (C.get("scale_exempt") or [])}

    unit_pats = unit.get("patterns") or []
    unit_ctx = unit.get("context") or []
    unit_win = unit.get("window", 8)

    def add(sev, fn, ln, rule, snap):
        out.append((sev, fn, ln, rule, (snap or "").strip()[:80]))

    # 书级（只跑一次）：登记完整性——canon 说了算，人物卡必须跟得上
    _roster_completeness(book, C, add)

    for chno, fn, text in chapters:
        lines = text.splitlines()

        # --- 标题格式 ---
        if title_re and lines and not re.match(title_re, lines[0]):
            add("中等", fn, 1, f"章标题格式应为「{title_hint}」", lines[0][:80])
        # 兜底：未配置 chapter.title_regex 时，至少要求「首个非空行是 H1」。
        # 缺标题的章在 state 里 title 会是空串——那是结构上就不像一章的文件。
        # 配了 title_regex 就不重复报（上面那条更精确）。
        if not title_re:
            first_nonempty = next((l for l in lines if l.strip() != ""), "")
            if not first_nonempty.lstrip().startswith("#"):
                add("中等", fn, 0, "缺 H1 标题（首个非空行不是 # …）——未配置 chapter.title_regex 时的兜底",
                    first_nonempty[:80])

        for i, line in enumerate(lines, 1):
            # 1 唯一写法
            for right, bads in name_bad.items():
                if str(right).startswith("_"):
                    continue
                for bad in bads or []:
                    if bad in line:
                        add("严重", fn, i, f"「{bad}」应为「{right}」", line)
            # 2 人物定位红线
            for label, pats in role_bad:
                for p in pats or []:
                    if p in line:
                        add("严重", fn, i, f"人物定位越界：{label}", line)
            # 3 数值口径硬错
            for label, pats in number_bad:
                for p in pats or []:
                    if p in line:
                        add("严重", fn, i, label, line)
            # 4 情报禁令
            for label, pats in intel_bad.items():
                if str(label).startswith("_"):
                    continue
                for p in pats or []:
                    if p in line:
                        add("严重", fn, i, label, line)
            # 5 口径冲突（须邻近口径词才判，避免误报「晚上八点」）
            if unit_pats and any(c in line for c in unit_ctx):
                for pat, sev, rule in unit_pats:
                    hit = False
                    for m in re.finditer(pat, line):
                        if kit.near(line, unit_ctx, m.start(), unit_win):
                            hit = True
                            break
                    if hit:
                        add(sev, fn, i, rule, line)
            # 6 时间线硬伤
            for pat, sev, rule in timeline:
                if re.search(pat, line):
                    add(sev, fn, i, rule, line)
            # 7 年龄 × 语境
            for pat, ctx, sev, rule in age_ctx:
                if re.search(pat, line) and any(c in line for c in ctx):
                    add(sev, fn, i, rule, line)
            # 8 评级刻度：只校验「距档位最近的那个数字」，排除时间/货币量词与上标吃字
            #   数字位数可配（book.json 的 checks.scale_digits，默认 2–4 位）——
            #   硬编码 \d{2,4} 会漏掉 1 位与 5 位以上的读数。
            sd = C.get("scale_digits") or [2, 4]
            num_re = rf"(?<![\d.])(\d{{{sd[0]},{sd[1]}}}(?:\.\d+)?)(?![\d])"
            for grade, rng in scale.items():
                gm = re.search(re.escape(grade) + r"(?![⁻⁺])", line)
                if not gm:
                    continue
                idx = gm.start()
                cands = []
                for m in re.finditer(num_re, line):
                    after = line[m.end():m.end() + 3]
                    if re.match(r"\s*(小时|分钟|分|天|秒|月|年|点|元)", after):
                        continue
                    cands.append((abs(m.start() - idx), float(m.group(1)), m.group(1)))
                if not cands:
                    continue
                cands.sort()
                _, v, n = cands[0]
                lo, hi = rng[0], rng[1]
                if not (lo <= v <= hi) and (fn, i) not in exempt:
                    add("中等", fn, i,
                        f"「{n}」紧邻 {grade}({lo}–{hi}) 却不在区间内，刻度可疑（需人工判定）", line)
            # 9 成本表：境界词附近出现表外数字
            for word, oks in scale_near.items():
                if str(word).startswith("_") or word not in line:
                    continue
                for m in re.finditer(r"(?<![\d.])(\d[\d_]{1,12})(?![\d])", line):
                    v = int(m.group(1).replace("_", ""))
                    if v not in oks and v > 9:
                        add("中等", fn, i,
                            f"「{m.group(1)}」出现在「{word}」附近，与成本表({oks[0]})不符——请人工确认", line)
                        break
            # 10 锁定细节
            for did, ctx, bads, hint in locked:
                if any(c in line for c in ctx):
                    for b in bads:
                        if re.search(b, line):
                            add("严重", fn, i, f"[{did}] {hint}", line)
                            break
            # 11 黑名单
            for w in blacklist:
                if w in line:
                    add("轻微", fn, i, f"AI句式/黑名单词「{w}」", line[:60])
            # 12 生僻字
            for ch_rare, better in rare.items():
                if str(ch_rare).startswith("_"):
                    continue
                if ch_rare in line:
                    add("严重", fn, i, f"生僻字「{ch_rare}」——建议改为「{better}」", line)
            # 12b 低频但正常的字（只提示，不判错）
            # 为什么单独一类：曾按语料频率一刀切把「埂/畦/锹/褐」判成生僻字，
            # 但那些是正常词——样板书不写它们只是因为不种地。
            # 判断标准是「普通读者认不认识」，不是语料频率。这一档留给人工判断。
            for ch_soft in (C.get("rare_soft") or []):
                if ch_soft in line:
                    add("轻微", fn, i,
                        f"低频用字「{ch_soft}」——属正常词，仅供人工判断是否换更常见的写法", line[:60])
                    break
            # 13 标点规范
            for bad_q in (quote.get("forbid") or []):
                if bad_q in line:
                    add("严重", fn, i, quote.get("reason", "标点不符正典"), line)
                    break
            # 14 章末升华（只看尾部若干行）
            tail = int(elev.get("tail_lines", 3) or 3)
            if i > len(lines) - tail:
                for w in (elev.get("words") or []):
                    if w in line:
                        add("中等", fn, i, f"疑似章末升华/说教「{w}」", line[:70])

            # 14b AI 句式结构（源：content/rules/ai-anti-patterns.md）
            for sid, pat, desc in AI_STRUCT_PATTERNS:
                if re.search(pat, line):
                    add("轻微", fn, i, f"[{sid}] {desc}", line[:60])
            # 14c 「忽然/突然/猛地」同段连发（源规则：一页 ≥2 次即违规）
            _h = re.findall(r"忽然|突然|猛地", line)
            if len(_h) >= 2:
                add("中等", fn, i,
                    f"「忽然/突然/猛地」同段连发 {len(_h)} 次（一页 ≥2 即违规）", line[:60])

        # 15 悬空设定（整章判定：未解锁就使用）
        for cid, pat, rule, allow, unlock in gated:
            if unlock is not None and chno >= unlock:
                continue
            if chno in (allow or []):
                continue
            for i, line in enumerate(lines, 1):
                if re.search(pat, line):
                    add("严重", fn, i, f"[{cid}] {rule}", line)

        # 16 超长章
        n = kit.hanzi_count(text)
        if word_max and n > word_max:
            add("中等", fn, 0, f"超长章：{n} 汉字 > 上限 {word_max}", "")

        # 16a 空章 / 占位章（F19）
        # 为什么必须补这一条：本脚本原有的内容层断言**全是「不该有什么」**——
        # 唯一写法、黑名单、人物越界、生僻字、标点、超长…… 一个**零内容**的章
        # 天然一条都不命中，于是干干净净地全绿。「查不到问题」再次被当成「没问题」，
        # 与协议层那个谬误同源，只是下沉了一层；补的就是第一条「应该有什么」。
        if word_min and n < word_min:
            add("严重", fn, 0,
                f"疑似空章/占位章：{n} 汉字 < 下限 {word_min}"
                "（存在性断言：这么短的文件不构成一章，不是文风下限）", "")

        # 16b 比喻词堆砌（章级：一章比喻 ≤2 个，源 ai-anti-patterns.md）
        # 只算明确比喻词，**不含「像」**——「像」有推测/举例等正常用法，纳入会大量误报。
        _sim = re.findall(r"仿佛|似乎|宛如|犹如", text)
        if len(_sim) > 2:
            add("中等", fn, 0,
                f"比喻词堆砌 {len(_sim)} 处（一章 ≤2）——{'、'.join(sorted(set(_sim)))}", "")

        # 16c 面板/系统条目文体（checks.panel；面板流金手指专属，无配置即跳过）
        # 为什么管它：面板条目直接当正文写 = 字面意义的「流水账」。
        # 2026-09-20 实测：ch-1 有 39% 的段落是【…】条目，全书均值 14.3%。
        P = C.get("panel") or {}
        if P:
            pfx = str(P.get("prefix", "【"))
            cap = int(P.get("max_lines", 0) or 0)
            plines = [(i, l) for i, l in enumerate(lines, 1)
                      if l.strip().startswith(pfx)]
            if cap and len(plines) > cap:
                add("中等", fn, 0,
                    f"面板条目行数 {len(plines)} > 上限 {cap}（{pfx} 开头的段落）——"
                    f"条目成串即流水账；改并入叙述转述或删减", "")
            for i, l in plines:
                for bad in (P.get("forbid") or []):
                    bad = str(bad)
                    if bad and bad in l:
                        add("严重", fn, i,
                            f"面板条目含结论文案「{bad}」——面板只记账，不替读者下结论/提前给答案",
                            l[:60])
                        break

        # 16d 内容层「承诺 vs 交付」（2026-09-20 新增；按 book.json 开关，无配置即跳过）
        # 章末钩子那半已于 2026-09-24 移出本检查器（见上方 `_hook_check` 处的删除说明），
        # 改由 `novel hooks` 出只读报告。
        _foreshadow_check(book, C, chno, fn, text, add)

        # 17 句长节奏（分轨：叙述与对话各算各的）
        out.extend(_rhythm(book, fn, text, C.get("rhythm") or {}))

    return out


def rhythm_stats(text, R):
    """一句谱：按 `_rhythm` 的口径算出各项读数（供机检与 `--suggest-rhythm` 共用）。

    **为什么单独抽出来**：阈值建议必须与机检用**同一套口径**，否则「按建议填了却还是被拦」
    或者反过来「填了等于没开」。任何一处改了算法，两边一起变。
    返回 dict；正文太短（< min_chars）返回 None。
    """
    R = R or {}
    body = re.sub(r"^#.*$", "", text, flags=re.M)
    total = kit.hanzi_count(body)
    if total < int(R.get("min_chars", 300) or 300):
        return None

    DIAL = re.compile(r"\u201C[^\u201D]*\u201D")
    names = R.get("tag_names") or []
    if names:
        tag = re.compile(r"^\s*(?:" + "|".join(re.escape(x) for x in names) + r"|他|她|那人)\s*"
                         r"(?:问|说|道|应|答|笑|点头|摇头)(?:了|着|道)?\s*[，,]?\s*$")
    else:
        tag = None

    paras = [p.strip() for p in body.split("\n") if p.strip()]
    narr = "".join(p for p in paras if "\u201C" not in p)

    def sent_stats(x):
        s = [y for y in re.split(r"[。！？…]+", x) if re.search(r"[\u4e00-\u9fff]", y)]
        if tag:
            s = [y for y in s if not tag.match(y.strip())]
        L = [kit.hanzi_count(y) for y in s]
        if not L:
            return 0, 0.0, 0.0, 0.0
        return (len(L), sum(L) / len(L),
                sum(1 for v in L if v > 25) * 100 / len(L),
                sum(1 for v in L if v <= 10) * 100 / len(L))

    nn, narr_avg, narr_long, narr_short = sent_stats(narr)
    dial_pct = kit.hanzi_count("".join(DIAL.findall(body))) * 100 / total
    turn_words = R.get("turn_words") or []
    turn = (sum(body.count(w) for w in turn_words) * 1000 / total) if turn_words else 0.0
    return {
        "chars": total, "narr_chars": kit.hanzi_count(narr),
        "narr_sentences": nn, "narr_avg": narr_avg,
        "narr_long_pct": narr_long, "narr_short_pct": narr_short,
        "dialogue_pct": dial_pct, "turn_per_1000": turn,
        "panel_lines": len([p for p in paras if p.startswith("【")]),
    }


def _rhythm(book, fn, text, R):
    """句长节奏分轨。

    为什么分轨：初版用「整章平均句长」做指标，结果在惩罚对话的存在——对话天然短
    （"嗯。""六块。"），40% 对话的章节怎么改都到不了线，而且掩盖了真问题：叙述句本身也偏短。
    现改为叙述与对话各算各的，对话另设占比上限。
    """
    if not R or not R.get("enabled", True):
        return []
    st = rhythm_stats(text, R)
    if st is None:
        return []
    fn = fn
    narr_avg = st["narr_avg"]
    narr_long = st["narr_long_pct"]
    narr_short = st["narr_short_pct"]
    dial_pct = st["dialogue_pct"]
    turn = st["turn_per_1000"]
    nn = st["narr_sentences"]
    min_s = int(R.get("min_sentences", 20) or 20)
    # 读数精度取到「比阈值多一位小数」：否则 1.4999 会被显示成「1.50 < 下限 1.5」，
    # 报了个自相矛盾的数字，作者会以为是工具坏了（2026-09-20 实测踩到）。
    ctx = (f"（叙述{st['narr_chars']}字/句均{narr_avg:.2f}/长句{narr_long:.1f}%"
           f"/≤10字{narr_short:.1f}% ｜ 对话{dial_pct:.1f}%）")
    res = []
    if nn >= min_s and narr_avg < R.get("narr_avg_min", 0):
        res.append(("严重", fn, 0,
                    f"句长节奏：叙述句平均 {narr_avg:.2f} 字 < 下限 {R['narr_avg_min']}——叙述过碎，需铺陈", ctx))
    if nn >= min_s and narr_long < R.get("narr_long_min_pct", 0):
        res.append(("严重", fn, 0,
                    f"句长节奏：叙述长句(>25字)仅 {narr_long:.1f}% < 下限 {R['narr_long_min_pct']}%——缺少长句铺陈", ctx))
    if nn >= min_s and narr_short > R.get("short_ge10_max_pct", 100):
        res.append(("严重", fn, 0,
                    f"句长节奏：≤10字短句占叙述句 {narr_short:.1f}% > 上限 {R['short_ge10_max_pct']}%——"
                    f"每句都砸一下就没有重锤了；成串的名词/数字短句连着用即清单体", ctx))
    if dial_pct > R.get("dialogue_max_pct", 100):
        res.append(("中等", fn, 0,
                    f"篇幅配比：对话占 {dial_pct:.1f}% > 上限 {R['dialogue_max_pct']}%", ctx))
    if (R.get("turn_words") or []) and turn < R.get("turn_min_per_1000", 0):
        res.append(("严重", fn, 0,
                    f"转折词密度 {turn:.3f}/千字 < 下限 {R['turn_min_per_1000']}——"
                    f"句子之间缺少关联，读起来生硬、不像人说话", ctx))
    return res


# ------------------------------------------------------------------ 自述

def print_checks(book):
    C = book.sec("checks")
    rows = []
    for right, bads in (C.get("name_bad") or {}).items():
        if not str(right).startswith("_"):
            rows.append(("严重", f"唯一写法  「{right}」；报错 " + "／".join(bads or [])))
    for label, pats in (C.get("role_bad") or []):
        rows.append(("严重", f"人物定位越界[{label}]  禁止 " + "／".join(pats or [])))
    for label, pats in (C.get("number_bad") or []):
        rows.append(("严重", f"数值口径硬错[{label}]  禁止 " + "／".join(pats or [])))
    for label, pats in (C.get("intel_bad") or {}).items():
        if not str(label).startswith("_"):
            rows.append(("严重", f"情报禁令[{label}]  禁止 " + "／".join(pats or [])))
    for cid, pat, rule, allow, unlock in (C.get("gated_keywords") or []):
        state = "未解锁（待作者拍板解锁章）" if unlock is None else f"自第 {unlock} 章起已解锁"
        rows.append(("严重", f"悬空设定[{cid}]  /{pat}/；{state}；允许出现于第 "
                             + "、".join(map(str, allow or [])) + " 章（未解锁的未来承诺）\n"
                             + f"            清除条件：拍板后把该项第 5 个元素填成解锁章号（改一处即可）"))
    unit = C.get("unit_conflicts") or {}
    for pat, sev, rule in (unit.get("patterns") or []):
        rows.append((sev, f"口径冲突  /{pat}/ （与「" + "／".join(unit.get("context") or [])
                          + f"」相邻 {unit.get('window', 8)} 字内才判）：{rule}"))
    for pat, sev, rule in (C.get("timeline_bad") or []):
        rows.append((sev, f"时间线硬伤  /{pat}/：{rule}"))
    for pat, ctx, sev, rule in (C.get("age_context_bad") or []):
        rows.append((sev, f"年龄×语境  /{pat}/ 且同行含「" + "／".join(ctx) + f"」：{rule}"))
    for did, ctx, bads, hint in (C.get("locked_details") or []):
        rows.append(("严重", f"锁定细节[{did}]  同行含「" + "／".join(ctx) + "」时禁写 "
                             + "／".join(bads) + f"：{hint}"))
    if C.get("scale"):
        rows.append(("中等", f"评级刻度  仅校验距档位最近的数字，须落区间（共 {len(C['scale'])} 档）"))
    if C.get("scale_near"):
        rows.append(("中等", f"成本表  境界词附近出现表外数字即报警（共 {len(C['scale_near'])} 项）"))
    if C.get("scale_exempt"):
        rows.append(("—", f"刻度豁免  {len(C['scale_exempt'])} 行已人工核验（理由留档，非静默忽略）"))
    if C.get("quote_style"):
        rows.append(("严重", f"标点规范  {C['quote_style'].get('reason', '')}"))
    if C.get("rare_chars"):
        rows.append(("严重", f"生僻字  " + "／".join(f"{k}→{v}" for k, v in C["rare_chars"].items()
                                                     if not str(k).startswith("_"))))
    elev = C.get("elevation") or {}
    if elev.get("words"):
        rows.append(("中等", f"章末升华  仅查最后 {elev.get('tail_lines', 3)} 行，"
                             f"命中 {len(elev['words'])} 个词之一即报"))
    if C.get("blacklist"):
        rows.append(("轻微", f"AI 黑名单词  {len(C['blacklist'])} 个词逐行报点"))
    P = C.get("panel") or {}
    if P:
        cap = P.get("max_lines")
        rows.append(("中等", f"面板文体  「{P.get('prefix', '【')}」开头段落每章 ≤{cap} 行"
                             "——条目成串即流水账"))
        if P.get("forbid"):
            rows.append(("严重", "面板结论文案  面板行内禁用 " + "／".join(str(x) for x in P["forbid"])
                         + "——面板只记账，不替读者下结论/提前给答案"))
    R = C.get("rhythm") or {}
    if R.get("enabled", True) and R:
        rows.append(("严重", f"句长节奏（分轨）  叙述句均长 ≥{R.get('narr_avg_min')} 字、"
                             f"长句(>25字) ≥{R.get('narr_long_min_pct')}%、"
                             f"≤10字短句 ≤{R.get('short_ge10_max_pct')}%、"
                             f"转折词 ≥{R.get('turn_min_per_1000')}/千字"))
        rows.append(("中等", f"篇幅配比  对话占比 ≤{R.get('dialogue_max_pct')}%"))
    # 口径必须与 check() 一致：check() 对这两个键各有默认值/兜底，
    # 而这里原先直接取原始配置，未配置时会把「None」当成检查项印出来——
    # 清单是「机检项唯一来源」，来源说 None 就等于说瞎话。
    _wmax = book.get("chapter", "word_max", 3000)
    _wmin = book.get("chapter", "word_min", 50)
    _tre = book.get("chapter", "title_regex")
    rows.append(("中等", f"章标题格式  须匹配 /{_tre}/" if _tre
                         else "章标题格式  未配置 chapter.title_regex；兜底要求首个非空行为 H1"))
    if _wmax:
        rows.append(("中等", f"超长章  汉字数 > {_wmax}"))
    rows.append(("严重", f"空章/占位章  汉字数 < {_wmin}"
                         "（存在性断言，不是文风下限；chapter.word_min 可调，设 0 关闭）"))
    rows.append(("轻微", "AI 句式结构  " + str(len(AI_STRUCT_PATTERNS)) + " 类（"
                         + "／".join(s for s, _, _ in AI_STRUCT_PATTERNS)
                         + "）——源 content/rules/ai-anti-patterns.md；有语境例外，须人工判定"))
    rows.append(("中等", "同段连发  「忽然/突然/猛地」一页 ≥2 次即违规"))
    rows.append(("中等", "比喻词堆砌  一章「仿佛/似乎/宛如/犹如」> 2 处"))
    NR = C.get("name_roster") or {}
    if NR:
        rows.append(("轻微", "登记完整性  canon.md 人物表里的角色，characters/ 下必须有对应的卡"
                             "（人名从正文抽取试过，中文无词边界会大量切碎常用词，已弃用）"))
    # 章末钩子（hook_check）刻意不在本清单：该机检项 2026-09-24 已整项移出检查器，
    # 改由 `novel hooks` 出只读报告（不计入拦截、不影响退出码，见 docs/ne-架构与契约.md §7.2）。
    # 列在这里会让人以为「跑一次 gates 就核过钩子了」，而事实是不会。
    if C.get("foreshadow_check"):
        # 把「本次到底拿几条伏笔去比」写进清单：不写的话，作者看到 0 findings
        # 无从分辨是「查过且没问题」还是「压根没解析出东西」。
        _frows, _fnote = _foreshadow_rows(book)
        _fdesc = "伏笔埋设  回收总表标了「埋设于第 N 章」而该章无线索词即提示"
        if _fnote:
            _fdesc += f"　⚠️ 当前解析不出任何伏笔：{_fnote}"
        else:
            _fdesc += f"（本次解析到 {len(_frows)} 条伏笔）"
        rows.append(("轻微", _fdesc))

    # --- 未启用 / 不会生效的机检项（2026-09-24 新增）---
    # 为什么必须显式列出来：某项在 findings 里没出现，可能是「查了没问题」，
    # 也可能是「根本没启用」——两者在输出上**同形**。作者看到「0 问题」，
    # 无从分辨自己是被检查过了还是被跳过了。这与本项目反复在治的
    # 「查不到 = 没问题」是同一个病，只是发生在配置层。
    # 本节的输出只走 stderr、不产生 finding、不影响退出码：目的是让「没查」可见，
    # 而不是把每个未配置项都变成一条要人处理的告警（那会淹没真问题）。
    off = []
    R = C.get("rhythm") or {}
    _rhythm_thresholds = ("narr_avg_min", "narr_long_min_pct", "short_ge10_max_pct",
                          "dialogue_max_pct", "turn_min_per_1000")
    if not R:
        off.append(("句长节奏", "checks.rhythm 未配置"))
    elif not R.get("enabled", True):
        off.append(("句长节奏", f"checks.rhythm.enabled = {R.get('enabled')!r}"))
    elif not any(R.get(k) is not None for k in _rhythm_thresholds):
        off.append(("句长节奏",
                    "一个阈值都没填——判据形如 `读数 < R.get(key, 0)`，兜底 0 时永不成立，"
                    "等于没开。用 --suggest-rhythm 生成一组再粘进来"))

    P = C.get("panel") or {}
    if not P:
        off.append(("面板文体", "checks.panel 未配置"))
    elif P.get("max_lines") is None and not P.get("forbid"):
        off.append(("面板文体", "既无 max_lines 也无 forbid——本项不会产出任何发现"))

    # 章末钩子（hook_check）不在此节：它已不是本检查器的机检项，无所谓「未生效」。
    # 判据现在在 `novel hooks` 里，那边自带「没解析到锚词」的显式提示——
    # 也就是说，「查不到」与「查了没问题」在那边形状不同，本节的职责不再需要覆盖它。

    # 已废弃的键：book.json 里若还留着 checks.hook_check，它现在**不会被任何东西读取**。
    # 为什么必须点名而不是沉默跳过：这正是本节存在的理由——让「写了但没人读」可见。
    # 作者留着这个键、以为章末钩子还在被检查，是比键本身更坏的事。
    # 注意：**不能**把它做成 config_problems（那会 sys.exit(2)）——两本真书都还带着
    # `hook_check: null`，报成结构错误会直接把书锁死。废弃 ≠ 配置非法。
    if "hook_check" in C:
        off.append(("章末钩子（已废弃）",
                    "checks.hook_check 自 2026-09-24 起不再被读取——原实现依赖未随迁的 brief.py，"
                    "恒不生效，已整项移出检查器；章末钩子改由 `novel hooks` 出只读报告，本键可删"))

    F = C.get("foreshadow_check") or {}
    if not F or not F.get("enabled", True):
        off.append(("伏笔埋设", "checks.foreshadow_check 未启用"))
    else:
        _fp = str((book.sec("paths") or {}).get("foreshadow") or "")
        if not _fp:
            off.append(("伏笔埋设", "已启用但恒不生效：book.json 的 paths.foreshadow 未声明"))
        elif not os.path.isfile(os.path.join(book.root, _fp)):
            off.append(("伏笔埋设", f"已启用但恒不生效：伏笔表文件不存在（{_fp}）"))
        else:
            # 文件在、开关也开，但**表解析不出东西**——这是最隐蔽的一种「不生效」：
            # 所有前置条件都齐了，跑起来 0 findings，看着像「查过且没问题」。
            # 2026-09-25 实测踩到：两本真书的伏笔表列序与旧实现假设不符，静默 0 输入。
            _fr, _fnote = _foreshadow_rows(book)
            if _fnote:
                off.append(("伏笔埋设", f"已启用但**恒不生效**：{_fnote}"))

    NR = C.get("name_roster") or {}
    if not NR or not NR.get("enabled", True):
        off.append(("登记完整性", "checks.name_roster 未启用"))
    elif not _canon_names(book) and not (NR.get("registered") or []):
        off.append(("登记完整性",
                    "已启用但恒不生效：canon.md 人物表为空、登记册也为空（三方互校无输入）"))

    _ep("机检项清单（唯一来源：consistency_check.py 读 book.json 生成；文档请引用本命令输出，勿复述）")
    _ep("=" * 72)
    for i, (sev, desc) in enumerate(sorted(rows, key=lambda r: kit.SEV_ORDER.get(r[0], 9)), 1):
        _ep(f"{i:>2}. 【{sev}】{desc}")
    _ep()
    if off:
        _ep(f"⚠ 本次**未生效**的机检项 {len(off)} 项——下列各项不会产出任何发现，")
        _ep("  不要把它们没报问题当成「查过且没问题」：")
        for name, why in off:
            _ep(f"  · {name}：{why}")
        _ep()
    g = book.sec("gate")
    _ep(f"阈值：黑名单累计 > {g.get('blacklist_total', 60)} 触发警告；"
          f"单章黑名单词 > {g.get('blacklist_per_chapter', 6)} 触发警告。")
    _ep("批量长跑：本仓**没有**实现「自上次过闸后新增 ≥2 章未逐章校验即拦截」这条判据——")
    _ep("  旧 kit 里它写死在 preflight.py，而 preflight.py 未随迁（本仓无此文件）。")
    _ep("  本仓对应的保护在 `novel book`：任一章未过闸即停并报断点，另有 --max-llm-calls 额度闸。")
    _ep("  （`gate.batch_warn` 这个键在旧 kit 就没有任何脚本读它，2026-09-20 已从新书模板移除。）")


# ------------------------------------------------------------------ 阈值校准

def _pct(values, q):
    """分位数（线性插值）。值太少时退化为最值，避免报出无意义的小数。"""
    v = sorted(values)
    if not v:
        return 0.0
    if len(v) == 1:
        return float(v[0])
    pos = (len(v) - 1) * q
    lo = int(pos)
    hi = min(lo + 1, len(v) - 1)
    return v[lo] + (v[hi] - v[lo]) * (pos - lo)


def suggest_rhythm(book, argv):
    """`--suggest-rhythm [--from <目录>]`：按实测算一遍，给出可粘贴的阈值（**只读**）。

    为什么需要它：`checks.rhythm` 的阈值按规矩**必须来自实测**（story-style.md §3.1），
    而「等拆完样板书再校准」常常永远等不到——于是要么一直是启动档，要么拍脑袋填。
    这个模式把校准变成一条命令，与机检**共用同一套口径**（都走 rhythm_stats）：

      · 按**样板书**校准（推荐）：`--suggest-rhythm --from 1-边界`
        （把样板书原文放进该目录；目录里若同时有 .txt 与 .md，**只用 .txt**——
         样板书原文通常导出成 txt，而 .md 是拆解报告，混进来会带偏统计）
      · 按**本书现状**定一个「先能用」的档：直接跑（读 chapters/）
        ⚠️ 按现状校准只会「罚最差的四分之一」，不会把标准提上去——想让文风真的变，
        得按样板书校准，或直接采用目标值（book.example.json 里的默认档）。
    """
    R = book.sec("checks").get("rhythm") or {}
    base = {
        "min_chars": R.get("min_chars", 300),
        "min_sentences": R.get("min_sentences", 12),
        "tag_names": R.get("tag_names") or [],
        "turn_words": R.get("turn_words") or kit.DEFAULT_TURN_WORDS,
    }

    src = None
    for i, a in enumerate(argv):
        if a == "--from" and i + 1 < len(argv):
            src = argv[i + 1]
        elif a.startswith("--from="):
            src = a.split("=", 1)[1]

    if src:
        d = src if os.path.isabs(src) else os.path.join(book.root, src)
        txt_files, md_files = [], []
        for dp, _dn, fns in os.walk(d):
            for fn in sorted(fns):
                p = os.path.join(dp, fn)
                rel = os.path.relpath(p, book.root).replace(os.sep, "/")
                if fn.endswith(".txt"):
                    txt_files.append((rel, book.read(p) or ""))
                elif fn.endswith(".md"):
                    md_files.append((rel, book.read(p) or ""))
        # 优先只读 .txt：样板书原文通常是导出的 txt，而目录里的 .md 是拆解报告与预期.md
        # 这类**分析文字**，混进来会把句长/对话占比统计带偏（2026-09-20 实测）。
        files = txt_files or md_files
        if not files:
            _ep(f"⚠ {d} 下没有 .md/.txt —— 把样板书原文放进去再跑")
            return 1
        label = f"参考文本（{src}）"
    else:
        files = [(fn, t) for _n, fn, t in book.chapter_files()]
        label = "本书正文章节"
        if not files:
            _ep("⚠ chapters/ 下没有章节，也没给 --from 指定参考文本")
            return 1

    rows = []
    for fn, text in files:
        st = rhythm_stats(text, base)
        if st:
            rows.append((fn, st))
    if not rows:
        _ep(f"⚠ {label} 里没有超过 {base['min_chars']} 汉字的样本（句长节奏按章统计）")
        return 1

    def col(k):
        return [r[1][k] for r in rows]

    avg, long_p, short_p = col("narr_avg"), col("narr_long_pct"), col("narr_short_pct")
    dial, turn = col("dialogue_pct"), col("turn_per_1000")

    _ep("=" * 68)
    _ep(f"句长节奏阈值建议 ｜ 样本：{label}（{len(rows)} 篇）")
    _ep("=" * 68)
    _ep(f"{'指标':<22}{'min':>8}{'P25':>8}{'中位':>8}{'P75':>8}{'max':>8}")
    for name, series, fmt in (
        ("叙述句平均句长", avg, "{:.1f}"), ("叙述长句(>25字)%", long_p, "{:.1f}"),
        ("≤10字短句占%", short_p, "{:.1f}"), ("对话占全章%", dial, "{:.1f}"),
        ("转折词/千字", turn, "{:.2f}"),
    ):
        _ep(f"{name:<22}{fmt.format(min(series)):>8}{fmt.format(_pct(series, .25)):>8}"
              f"{fmt.format(_pct(series, .5)):>8}{fmt.format(_pct(series, .75)):>8}"
              f"{fmt.format(max(series)):>8}")

    sug = {
        "enabled": True,
        "min_chars": base["min_chars"],
        "min_sentences": base["min_sentences"],
        "narr_avg_min": round(_pct(avg, .25), 1),
        "narr_long_min_pct": round(_pct(long_p, .25), 1),
        "short_ge10_max_pct": round(_pct(short_p, .75), 1),
        # 对话占比是**风格选择**不是质量线：用 P90（离群保护）并给 45% 下限。
        # 取 P75 会把「对话正常偏多」的章也当成问题（实测本书 P75 只有 37.5%，
        # 而 kit 默认是 55%——按 P75 建议等于把标准凭空收紧一倍）。
        "dialogue_max_pct": round(min(75.0, max(45.0, _pct(dial, .90))), 1),
        "turn_min_per_1000": round(_pct(turn, .25), 2),
    }
    n_flag = 0
    for fn, st in rows:
        if (st["narr_sentences"] >= sug["min_sentences"]
                and (st["narr_avg"] < sug["narr_avg_min"]
                     or st["narr_long_pct"] < sug["narr_long_min_pct"]
                     or st["narr_short_pct"] > sug["short_ge10_max_pct"]
                     or st["turn_per_1000"] < sug["turn_min_per_1000"])):
            n_flag += 1
    _ep()
    _ep("按分位取的「罚最差四分之一」建议值（下限用 P25、上界用 P75；对话占比用 P90）：")
    _ep(json.dumps(sug, ensure_ascii=False, indent=2))
    _ep()
    _ep(f"→ 按此值，本样本中 **{n_flag}/{len(rows)}** 篇会被拦。")
    _ep("  ⚠️ 注意这不是「四分之一」：四个指标**各自**罚最差四分位，而只要有**任何一项**越线就算被拦，"
          "并集自然大得多（4 项近似独立时约 68%）。想让总体只拦 ~25%，"
          "把下限调到 P10 附近、上限调到 P90 附近。")
    _ep("→ 按现状取分位只会固化现状；要提标准，请用 `--from <样板书目录>` 按对标实测取。")
    _ep("  （旧 kit 另有一份 `assets/book.example.json` 目标档；本仓没有这个文件，"
        "不要照旧文档去找——校准的唯一入口就是本命令的 --from。）")
    _ep("→ 复跑：`--list-checks` 可核对该项是否已启用；填好后 doctor 不再提「启动档」。")
    return 0


# ------------------------------------------------------------------ 入口

def fail_no_chapters(book, check_id, detail):
    """书级失败关闭：输出显式 error finding + 非 0 退出码（F12 落点 3）。

    为什么必须改退出码：本脚本的契约是「0=跑完（有问题也返回 0）」，
    于是「一章都没扫到」和「扫完没发现问题」在协议上是同一个形状——
    上层拿到空 findings 就会把 state 里所有章刷成 clean。零章不是「没问题」，
    是「这次检查根本没发生」，两者必须在退出码上分开。
    """
    _ep(f"⛔ {detail}")
    payload = {
        "gate": "consistency_check",
        "book_root": book.root,
        "chapter_count": 0,
        "counts": {"严重": 1, "中等": 0, "轻微": 0},
        "findings": [
            {"severity": "严重", "chapter": "（书）", "line": 0,
             "check": check_id, "detail": detail},
        ],
    }
    print(json.dumps(payload, ensure_ascii=False))
    return 2


def main():
    argv = kit.strip_root_arg(sys.argv[1:])
    book = kit.load_book(sys.argv[1:])
    if "--list-checks" in argv:
        print_checks(book)
        return 0
    if "--suggest-rhythm" in argv:
        return suggest_rhythm(book, argv)

    def opt(name, default=None):
        for i, a in enumerate(argv):
            if a == name and i + 1 < len(argv):
                return argv[i + 1]
            if a.startswith(name + "="):
                return a.split("=", 1)[1]
        return default

    # --tag：区分同时运行的入口（落盘钩子 / 后台 watcher），避免报告互相覆盖
    tag = opt("--tag", "")

    wl = [a for a in argv if not a.startswith("--")
          and a != tag and not a.isdigit()]
    chapters = book.chapter_files()

    # 零章：目录不存在 / 命名不符 file_regex / 书根打错一层，都落在这里。
    # 这是 F12 那条假绿链的源头，必须在书级直接失败关闭（见 fail_no_chapters）。
    if not chapters:
        return fail_no_chapters(
            book, "no-chapters-found",
            f"未找到任何章节：{book.chapters_dir} 不存在，"
            f"或其中没有匹配 {book.file_regex.pattern} 的 .md")

    # --since N：只扫最近 N 章。给钩子/长书场景用——全量扫描会随章数线性变慢，
    # 钩子有宿主超时，书越长越容易静默失效。
    since = opt("--since")
    if since and since.isdigit():
        n = int(since)
        chapters = chapters[-n:] if n > 0 else chapters

    if wl:
        chapters = [(n, fn, t) for n, fn, t in chapters
                    if fn in wl or fn.replace(".md", "") in wl
                    or any(fn.startswith(w) for w in wl)]
        # 书里有章、但筛选一个都没匹配上：同样属于「这次检查没发生」。
        # 章名敲错一个字母的静默全绿，与零章是同一种病。
        if not chapters:
            return fail_no_chapters(
                book, "no-chapters-matched",
                f"书里有章节，但给定的筛选条件没有匹配到任何一章：{' '.join(wl)}"
                "（章名是否敲错？不加参数即全量检查）")

    findings = check(book, chapters)

    # 只在全量扫描时上报「未纳入检查」——按章筛选时报这个会误导
    if not wl and not since:
        stray = book.stray_files()
        if stray:
            findings.append(("中等", "（目录）", 0, "未纳入检查",
                             f"chapters/ 下有 {len(stray)} 个 .md 未被纳入检查（命名不符）："
                             + ", ".join(stray[:6])))

    # 起草自由模式（gate.draft_free）：风格类发现降为「提示」——只报告，不计入拦截。
    # 依据 2026-09-14/15 作者与 Gemini 的结论 + 三次实测（详见 docs/17 与 9-14 日志）：
    # 负向禁令不该在验收时惩罚「自由起草」的正文；硬口径类（锁定细节/口径冲突/账本）不受影响。
    if bool((book.sec("gate") or {}).get("draft_free")):
        style = [f for f in findings if is_draft_free_style_finding(f[3])]
        if style:
            findings = [f for f in findings if not is_draft_free_style_finding(f[3])]
            findings += [("提示", f[1], f[2], f[3], f[4]) for f in style]

    findings = kit.sort_findings(findings)
    c = kit.count_sev(findings)
    # gates 契约（novel-engine）：不改任何文件——原版在此写 notes/对账-*.md 与趋势 CSV
    #（kit.write_report / kit.append_trend），已整段移除；人类可读摘要走 stderr，
    # stdout 只吐最终 JSON。
    extra = f" ｜ 提示 {c['提示']}" if c.get("提示") else ""
    _ep(f"严重 {c['严重']} · 中等 {c['中等']} · 轻微 {c['轻微']}{extra}")
    payload = {
        "gate": "consistency_check",
        "book_root": book.root,
        "chapter_count": len(chapters),
        "counts": c,
        "findings": [
            {"severity": sev, "chapter": ch, "line": ln, "check": name, "detail": detail}
            for sev, ch, ln, name, detail in findings
        ],
    }
    print(json.dumps(payload, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    kit.force_utf8()
    # 统一入口（B-14）：未捕获异常 → EXIT_CRASH(1) + stdout 结构化原因；
    # 正常返回 → EXIT_OK(0)。**退出码只表示脚本有没有跑完，结论只看 stdout 的 JSON。**
    kit.run_main(main)
