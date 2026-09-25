#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
查重闸门 (duplicate_check.py) —— 章内与跨章的重复文字（B-46，v0.2 附 A）

用途：网文连载最常见的「机械感」来源之一是**自己抄自己**——
同一句景物描写在两章里原样出现、同一个短语在一章里连着用三次。
它不是错别字也不是设定冲突，机械判据里没人管，读者却一眼看得出。

两类判据，都是**客观计数**，不猜阈值：

1. **跨章整句重复**：同一句话（按 。！？…；换行 切分，长度 ≥ `min_sentence_chars`）
   出现在 ≥2 个章里 → 中等。
   为什么按「整句 + 长度下限」：短句（如「他点了点头。」）重复是正常的；
   长句原样重复几乎只可能是复制粘贴。长度下限是**客观过滤**，不是审美判断。

2. **章内短语重复**：同一段 `ngram` 字连续文字在同一章出现 ≥ `min_repeat` 次 → 轻微。
   为什么是轻微：排比、呼应、口头禅都可能触发。**只报线索，不当结论。**

配置（book.json 的 `checks.duplicate`，全部可选）：
    "checks": { "duplicate": {
        "min_sentence_chars": 12,   # 跨章整句重复的最短句长
        "ngram": 10,                # 章内短语重复的连续字数
        "min_repeat": 3             # 章内短语至少出现几次才算
    } }

★为什么默认值这么保守：本项目的一贯裁决是**没给真书数据之前不猜阈值**。
这几个值是「明显不像巧合」的下界，不是「好文笔」的标准。拿真书跑出数据后再调。

退出码（B-14 契约）：0=跑完（有命中也是 0）／1=脚本崩／2=环境或配置错。
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


DEFAULTS = {"min_sentence_chars": 12, "ngram": 10, "min_repeat": 3}
# 句末标点 + 换行都算句子边界。全角标点是正文里的常态，半角兜底
SENTENCE_SPLIT = re.compile(r"[。！？…；\n]+")


def _positive_int(v, fallback):
    """只认正整数；其它（负数/0/字符串/None）一律回退默认——手滑的配置不该让整章检查失败。"""
    try:
        n = int(v)
    except (TypeError, ValueError):
        return fallback
    return n if n > 0 else fallback


def main():
    book = kit.load_book(sys.argv[1:])
    sec = book.sec("checks").get("duplicate")
    sec = sec if isinstance(sec, dict) else {}
    min_chars = _positive_int(sec.get("min_sentence_chars"), DEFAULTS["min_sentence_chars"])
    ngram = _positive_int(sec.get("ngram"), DEFAULTS["ngram"])
    min_repeat = _positive_int(sec.get("min_repeat"), DEFAULTS["min_repeat"])

    chapters = book.chapter_files()
    findings = []

    # ── 判据 1：跨章整句重复 ──
    # 句子 → 出现过的 (章号, 文件名, 行号) 列表
    seen = {}
    for no, fn, text in chapters:
        for i, line in enumerate(text.split("\n"), start=1):
            for sent in SENTENCE_SPLIT.split(line):
                s = sent.strip()
                if len(s) < min_chars:
                    continue
                seen.setdefault(s, []).append((no, fn, i))

    for sent, hits in seen.items():
        chapter_nos = {h[0] for h in hits}
        if len(chapter_nos) < 2:
            continue
        where = "、".join(f"第 {no} 章" for no in sorted(chapter_nos))
        # 报在**后出现**的那一章上：读者先读到的那次不算问题
        last_no, last_fn, last_line = hits[-1]
        findings.append((
            "中等", last_fn, last_line,
            f"[跨章重复句] 同一句在 {where} 原样出现（{len(chapter_nos)} 章）——像复制粘贴",
            sent[:120],
        ))

    # ── 判据 2：章内短语重复 ──
    for no, fn, text in chapters:
        flat = re.sub(r"\s+", "", text)
        if len(flat) < ngram * min_repeat:
            continue
        counts = {}
        for i in range(len(flat) - ngram + 1):
            g = flat[i:i + ngram]
            counts[g] = counts.get(g, 0) + 1
        # 同一段文字里的重叠计数会互相包含（「他推开门，雨声」与「推开门，雨声压」）。
        # 只保留**不被更长的高频片段包含**的那些，避免一次重复报出一串子串。
        repeated = {g: c for g, c in counts.items() if c >= min_repeat}
        for g in sorted(repeated, key=len, reverse=True):
            if any(g != other and g in other for other in repeated):
                continue
            # 找第一次出现的行号（报给人工定位）
            line_no = 0
            for i, line in enumerate(text.split("\n"), start=1):
                if g[:6] in re.sub(r"\s+", "", line):
                    line_no = i
                    break
            findings.append((
                "轻微", fn, line_no,
                f"[章内重复] 「{g[:20]}…」在本章出现 {repeated[g]} 次（≥{min_repeat}）——排比/口头禅也可能触发，只报线索",
                g[:120],
            ))

    sorted_findings = kit.sort_findings(findings)
    payload = {
        "gate": "duplicate_check",
        "book_root": book.root,
        "chapter_count": len(chapters),
        "counts": kit.count_sev(sorted_findings),
        "findings": [
            {"severity": s, "chapter": ch, "line": ln, "check": name, "detail": detail}
            for s, ch, ln, name, detail in sorted_findings
        ],
    }
    c = payload["counts"]
    _ep(
        f"跨章整句重复 ≥{min_chars} 字｜章内短语重复 {ngram} 字 ≥{min_repeat} 次"
        f"｜严重 {c['严重']} · 中等 {c['中等']} · 轻微 {c['轻微']}"
    )
    print(json.dumps(payload, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    kit.force_utf8()
    # 统一入口（B-14）：未捕获异常 → EXIT_CRASH(1) + stdout 结构化原因
    kit.run_main(main)
