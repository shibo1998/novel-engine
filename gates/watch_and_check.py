#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
目录监视器 (watch_and_check.py)

作用：常驻后台，监视 chapters/；一旦有 ch-*.md 被写入/修改，就自动过闸，
      并把结果追加到 notes/对账日志.md。
      这是「每生成就执行」的自动触发点——**与 agent 是否守流程无关**。

编排约定（报告 NW-P1-008）：本脚本**只调用 preflight 一次**（--tag watch --since 1
--json），不再自己先跑 consistency_check——否则一次变化触发两遍全书扫描，
且共享当日报告互相覆盖。preflight 拿不到项目锁时跳过本轮并保留基线，下轮重查。

特点：纯标准库（无需安装 watchdog），每 N 秒轮询 mtime + 大小。

用法：
    python <kit>/tools/watch_and_check.py               # 前台运行（Ctrl+C 退出）
    python <kit>/tools/watch_and_check.py --interval 5
    python <kit>/tools/watch_and_check.py --root <书目录>
后台运行见 start_watcher.ps1 / stop_watcher.ps1（在项目 tools/ 下）。
"""
import datetime
import json
import os
import sys
import time

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import kit  # noqa: E402


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
            log(f"检测到变化：{', '.join(changed)} → 自动过闸")
            # **只调用 preflight 一次**（编排约定，报告 NW-P1-008）：
            # 不再自己先跑 consistency_check——那会让每次变化触发两遍全书扫描，
            # 且无 tag 报告会被钩子/手工入口同时重写。
            # --tag watch：与落盘钩子（--tag hook）分开写报告；--since 1：只增量扫最近 1 章
            # （账本/状态仍全量）；--lock-timeout 60：另一入口在查就等一会儿。
            rc, out, _ = kit.run_child(
                "preflight.py", book.root,
                ["--no-advance", "--tag", "watch", "--since", "1", "--json",
                 "--lock-timeout", "60"],
            )
            if rc == 3:
                log("闸门：⏭ 跳过（另一个检查正在进行）；基线不动，下轮重查")
                continue
            summary = ""
            checks_ok = "?"
            try:
                result = json.loads(out.strip().splitlines()[-1])
                counts = result.get("counts") or {}
                summary = (f"严重 {counts.get('严重', 0)} · 中等 {counts.get('中等', 0)}"
                           f" · 轻微 {counts.get('轻微', 0)}")
                checks_ok = "✅ 通过" if result.get("ok") else "❌ 拦截"
            except (ValueError, IndexError):
                log("闸门：❌ 未返回结构化结果（失败关闭），请手动运行 tools/preflight.py 排查")
                last = cur
                save_baseline(book, cur)
                continue
            log(f"对账：{summary or '（无计数）'}")
            log(f"闸门：{checks_ok}（自动入口，未推进校验点）")
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
