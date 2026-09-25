#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
平台敏感词闸门 (sensitive_check.py) —— 发布前的硬红线（B-47，v0.2 M15.4）

用途：拿作者提供的**平台敏感词表**扫正文，命中即报。

★本文件最重要的一条设计：**词表没配 = 本项未生效，绝不当成「扫过且干净」。**
本项目已经为「查不到」与「查了没问题」同形吃过多次亏
（零章检查 → 全章刷 clean；`convergence` 的不可达分支；伏笔表解析不出任何行却静默返回 0）。
敏感词闸门是同一个陷阱的又一次机会：没有词表时 findings 必然是空的，
而空的 findings 与「真的没有敏感词」长得一模一样。
所以：
  · 词表缺失/为空 → stdout 的 payload 里带 `not_effective: ["sensitive"]` 与原因；
  · stderr 明确打一行 ⚠️；
  · **不**把这种情况伪装成 0 findings 的正常结果。

★为什么不内置词表：敏感词表**随平台、随时效变化**，且各平台口径不同。
内置一份等于把「某平台某时刻的清单」固化进代码——它会过期，而过期的清单
比没有清单更危险（作者以为在保护，其实没有）。词表必须由作者提供、可随时替换。

词表格式（`<书根>/<paths.sensitive>` 或 `checks.sensitive.words` 指向的文件）：
    一行一个词；`#` 开头的行是注释；空行忽略。

配置（book.json）：
    "checks": { "sensitive": { "words": ".soloent/sensitive/番茄.txt", "severity": "严重" } }
severity 缺省「严重」——平台红线是硬拦截，不是提示。

退出码（B-14 契约）：0=跑完（有命中也是 0）／1=脚本崩／2=环境或配置错。
"""
import json
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import kit  # noqa: E402


def _ep(*args, **kwargs):
    """gates 契约：人类可读输出一律走 stderr，stdout 只留最终 JSON。"""
    print(*args, file=sys.stderr, **kwargs)


SEVERITIES = ("严重", "中等", "轻微", "提示")


def load_words(book, path):
    """读词表。返回 (words, reason)：读不到时 words 为空、reason 说明原因。

    ★不抛错、也不静默：读不到的原因必须能传到报告里。
    """
    if not path:
        return [], "未配置词表路径（checks.sensitive.words 或 paths.sensitive）"
    abs_path = path if os.path.isabs(path) else os.path.join(book.root, path)
    if not os.path.isfile(abs_path):
        return [], f"词表文件不存在：{abs_path}"
    try:
        with open(abs_path, encoding="utf-8-sig") as f:
            raw = f.read()
    except OSError as e:
        return [], f"词表读不了：{abs_path}（{e}）"
    words = []
    for line in raw.split("\n"):
        w = line.strip()
        if not w or w.startswith("#"):
            continue
        words.append(w)
    if not words:
        return [], f"词表是空的（只有注释/空行）：{abs_path}"
    return words, ""


def main():
    book = kit.load_book(sys.argv[1:])
    # 词表路径：优先 checks.sensitive.words，回落 paths.sensitive
    sec = book.sec("checks").get("sensitive")
    sec = sec if isinstance(sec, dict) else {}
    paths = book.cfg.get("paths")
    paths = paths if isinstance(paths, dict) else {}
    words_path = sec.get("words") or paths.get("sensitive") or ""
    severity = sec.get("severity") or "严重"
    if severity not in SEVERITIES:
        severity = "严重"

    words, reason = load_words(book, words_path)
    chapters = book.chapter_files()

    findings = []
    if words:
        # 长词优先匹配，避免短词先命中把长词的位置占掉（只影响报哪一条，不影响「命中」）
        for w in sorted(set(words), key=len, reverse=True):
            for no, fn, text in chapters:
                for i, line in enumerate(text.split("\n"), start=1):
                    if w in line:
                        findings.append((
                            severity, fn, i,
                            f"[敏感词] 命中「{w}」——平台红线，发布前必须处理",
                            line.strip()[:120],
                        ))

    payload = {
        "gate": "sensitive_check",
        "book_root": book.root,
        "chapter_count": len(chapters),
        "counts": kit.count_sev(findings),
        "findings": [
            {"severity": s, "chapter": ch, "line": ln, "check": name, "detail": detail}
            for s, ch, ln, name, detail in kit.sort_findings(findings)
        ],
    }
    if not words:
        # ★「本项未生效」必须显式——空的 findings 不许长得像「扫过且干净」
        payload["not_effective"] = ["sensitive"]
        payload["not_effective_reason"] = reason
        _ep("⚠️ 敏感词闸门**未生效**：" + reason)
        _ep("   本项不会产出任何发现——这不是「没有敏感词」，是「没扫」。")
        _ep('   配置示例：book.json → "checks": { "sensitive": { "words": ".soloent/sensitive/番茄.txt" } }')
    else:
        c = payload["counts"]
        _ep(f"词表 {len(set(words))} 条｜严重 {c['严重']} · 中等 {c['中等']} · 轻微 {c['轻微']}")

    print(json.dumps(payload, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    kit.force_utf8()
    # 统一入口（B-14）：未捕获异常 → EXIT_CRASH(1) + stdout 结构化原因
    kit.run_main(main)
