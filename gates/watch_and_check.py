#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
目录监视器 (watch_and_check.py)

作用：常驻后台，监视 chapters/；一旦有 ch-*.md 被写入/修改，就自动跑一次检查，
      并把结果追加到 notes/对账日志.md。
      这是「每生成就执行」的自动触发点——**与 agent 是否守流程无关**。

与迁入本仓前的差异（F18，2026-09-24）：
  原版调 preflight.py —— 那是本脚本在 kit 里的**同级兄弟**，但没有随本脚本一起迁进本仓，
  于是这条链在本仓一直跑不起来。好在 kit.run_child 对「子脚本缺失」返回 -2 而不是 0，
  所以它是**失败关闭**（会报错），不是静默放行；只是日志会把人指向一个不存在的文件。
  现改调仓内确实存在的 consistency_check.py。由此顺带简化两点：
    1. 不再需要项目锁：consistency_check.py 在本仓是**只读**的（原版写报告/趋势那段已整段
       移除），并发跑只多花 CPU，不会互相覆盖；本脚本自己写的
       .soloent/watch_state.json 也只有它在写。
    2. 不再需要 --tag 区分入口报告（本仓不写报告了）。--tag 仍照传，留给未来接钩子。

用法：
    python gates/watch_and_check.py                    # 前台运行（Ctrl+C 退出）
    python gates/watch_and_check.py --interval 5
    python gates/watch_and_check.py --root <书目录>
"""
import datetime
import json
import os
import sys
import time

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import kit  # noqa: E402

# 检查器缺失/超时/启动失败时 kit.run_child 的约定返回码
CHILD_FAILURES = {
    -2: "检查器脚本不存在（仓不完整？）",
    -3: "检查器超时（书太长？可用更大间隔并留意 consistency_check 的耗时）",
    -1: "子进程启动失败",
}


def snapshot(book):
    snap = {}
    d = book.chapters_dir
    if not os.path.isdir(d):
        return snap
    for fn in os.listdir(d):
        if not fn.endswith(".md"):
            continue
        p = os.path.join(d, fn)
        try:
            st = os.stat(p)
            snap[fn] = (round(st.st_mtime, 1), st.st_size)
        except OSError:
            pass
    return snap


def load_baseline(book):
    """从 .soloent/watch_state.json 读上次基线。

    为什么必须持久化：早期版本只把基线放在内存里（`last = snapshot()`），
    **watcher 停机期间发生的改动永远不会被发现**——重启后所有文件都"没变过"。
    """
    p = os.path.join(book.soloent, "watch_state.json")
    if not os.path.isfile(p):
        return None
    try:
        with open(p, encoding="utf-8-sig") as f:
            d = json.load(f)
        return {k: tuple(v) for k, v in (d or {}).items()}
    except (OSError, ValueError):
        return None


def save_baseline(book, snap):
    p = os.path.join(book.soloent, "watch_state.json")
    os.makedirs(os.path.dirname(p), exist_ok=True)
    try:
        kit.atomic_write_json(p, {k: list(v) for k, v in snap.items()})
    except OSError:
        pass


def find_result(text):
    """从子进程输出里挑出检查器的 JSON 结果。

    ⚠️ 为什么不能直接取最后一行：kit.run_child 返回的是 `stdout + stderr` 的**拼接**，
    而 consistency_check.py 是「最终 JSON 走 stdout、人类可读摘要走 stderr」——
    JSON 排在拼接串的**前面**。上位脚本不该假定这个顺序（真实运行时两边还可能交错），
    所以逐行从后往前试解析，取最后一个能解析成「带 counts 的对象」的行。
    """
    for line in reversed(text.strip().splitlines()):
        line = line.strip()
        if not line.startswith("{"):
            continue
        try:
            obj = json.loads(line)
        except ValueError:
            continue
        if isinstance(obj, dict) and "counts" in obj:
            return obj
    return None


def main():
    argv = kit.strip_root_arg(sys.argv[1:])
    book = kit.load_book(sys.argv[1:])
    interval = 5
    if "--interval" in argv:
        try:
            interval = int(argv[argv.index("--interval") + 1])
        except (ValueError, IndexError):
            pass

    log_path = os.path.join(book.notes_dir, "对账日志.md")
    pidf = os.path.join(book.soloent, "watcher.pid")

    def log(msg):
        stamp = datetime.datetime.now().strftime("%Y-%m-%d %H:%M:%S")
        os.makedirs(os.path.dirname(log_path), exist_ok=True)
        # 追加写必须用 utf-8（不能 utf-8-sig，否则每次追加都多写一个 BOM）
        with open(log_path, "a", encoding="utf-8") as f:
            f.write(f"- [{stamp}] {msg}\n")
        print(f"[{stamp}] {msg}", flush=True)

    log(f"watcher 启动（间隔 {interval}s，监视 {book.chapters_dir}）")
    os.makedirs(os.path.dirname(pidf), exist_ok=True)
    with open(pidf, "w", encoding="utf-8") as f:
        f.write(str(os.getpid()))

    last = load_baseline(book)
    cur0 = snapshot(book)
    if last is None:
        last = cur0
        log("首次运行：建立基线（不回溯历史改动）")
    else:
        missed = sorted(fn for fn in cur0 if fn not in last or cur0[fn] != last[fn])
        if missed:
            log(f"检测到上次停机期间的改动：{', '.join(missed[:8])}"
                + (f" 等 {len(missed)} 个" if len(missed) > 8 else ""))
    save_baseline(book, last)

    try:
        while True:
            time.sleep(interval)
            cur = snapshot(book)
            changed = sorted(fn for fn in cur if fn not in last or cur[fn] != last[fn])
            if not changed:
                continue
            log(f"检测到变化：{', '.join(changed)} → 自动检查")
            # 只调 consistency_check.py 一次（它在本仓是只读的，见模块 docstring）：
            # --since 1 只增量扫最近 1 章（书越长全量扫描越慢）；--tag watch 留给未来接钩子。
            rc, out, _present = kit.run_child(
                "consistency_check.py", book.root,
                ["--since", "1", "--tag", "watch"],
            )
            # 失败一律「基线不动，下轮重查」——检查没发生，就不能把这次改动记成已检。
            # 代价是持续失败会每轮重报一次；这是有意的：静默不报比刷屏更糟。
            if rc != 0:
                log(f"闸门：❌ {CHILD_FAILURES.get(rc, f'检查器未跑成（exit {rc}）')}；基线不动，下轮重查")
                # 只回显人读行：检查器的最终 JSON 也混在这段拼接输出里，
                # 整串塞进对账日志会把真正的失败原因淹掉（JSON 是给机器看的那份）。
                for line in out.strip().splitlines()[-6:]:
                    line = line.strip()
                    if line and not line.startswith("{"):
                        log(f"      {line}")
                continue
            summary = ""
            checks_ok = "?"
            result = find_result(out)
            if result is None:
                # 退出码 0 却说不出结构——按失败关闭处理，且不推进基线
                log("闸门：❌ 未返回结构化结果（失败关闭）；基线不动，下轮重查")
                for line in out.strip().splitlines()[-3:]:
                    if line.strip():
                        log(f"      {line.strip()}")
                continue
            counts = result.get("counts") or {}
            summary = (f"严重 {counts.get('严重', 0)} · 中等 {counts.get('中等', 0)}"
                       f" · 轻微 {counts.get('轻微', 0)}")
            checks_ok = "✅ 通过" if not any(
                counts.get(k, 0) for k in ("严重", "中等")) else "❌ 有拦截项"
            log(f"对账：{summary or '（无计数）'}")
            log(f"闸门：{checks_ok}（自动入口，未推进任何校验点）")
            last = cur
            save_baseline(book, cur)
    except KeyboardInterrupt:
        log("watcher 退出")
    finally:
        try:
            os.remove(pidf)
        except OSError:
            pass
    return 0


if __name__ == "__main__":
    kit.force_utf8()
    sys.exit(main())
