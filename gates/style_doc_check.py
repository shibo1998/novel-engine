#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
风格/红线层前置闸门 (style_doc_check.py) —— 写正文之前的「填了没」

用途：在**写任何一章之前**判断 `story-style.md` / `MASTER.md` / `1-边界/预期.md`
三份「人写的规则」是否真的填过。空着或还是模板占位符 → 不许开写。

为什么需要它（本文件存在的全部理由）：
  这三份文件决定文风、红线与开书边界。它们空着的时候，模型只能按自己的默认审美写，
  结果就是三章共用一个套路、句子流水账——正是本项目要解决的核心痛点。
  而旧链路里 **Python 侧判据早就写好了**（kit.style_doc_issues / kit.style_gate_ready，
  覆盖三份文件、block/warn 分级、占位符与「与模板一字不差」两类判据），
  却**一个调用者都没有**——是死代码。于是「有守卫」和「没守卫」在行为上完全一样。
  本脚本的作用就是**把它接进 gates 契约**，而不是另写一套判据。
  ★任何「把判据在 TS/Python 各抄一份」的做法都会漂移，本项目已为此吃过多次亏。

与 consistency_check.py 的分工：
  · consistency_check：**章级**内容对账（读 chapters/，逐章报行号）。
  · style_doc_check：**书级**前置条件（读规则文件，与章节无关）。
    两者都不改文件，都遵守「人类可读走 stderr、stdout 只留最终 JSON」。

用法：
    python gates/style_doc_check.py --root <书目录>

输出：stderr 摘要 + stdout 最终 JSON（形状与 consistency_check 一致）
退出码：0=跑完（有问题也返回 0，问题数由摘要行体现）
        2=这次检查**根本没发生**（书根指错 / 配置不合法）——由 kit.load_book 统一给出。

⚠️ **本闸门是书级的，不产出可回填的逐章状态。**
   因此 `chapter_count` 恒为 0：一旦有人把它接到 applyGateResult 的章数对账上，
   会因为 `0 != state.chapters.length` 直接抛错——**失败关闭**，而不是静默把全书刷绿。
   （回填用的逐章闸门只有一个：consistency_check。）
"""
import json
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import kit  # noqa: E402


def _ep(*args, **kwargs):
    """gates 契约：人类可读输出一律走 stderr，stdout 只留最终 JSON。"""
    print(*args, file=sys.stderr, **kwargs)


# kit.style_doc_issues 的级别 → 本仓统一严重度。
# 为什么 block 映射到「严重」而不是自造一档：严重度集合是既有协议的一部分
# （types.ts 的 GateSeverity / 前端展示 / applyGateResult 聚合），多造一档
# 会让每一处消费方都要改。而「严重」在本仓的既有语义正是「必须解决才能继续」。
LEVEL_TO_SEVERITY = {"block": "严重", "warn": "中等"}

# 级别在报告里的中文说法（避免读者去猜 block/warn 谁更重）
LEVEL_LABEL = {"block": "阻断", "warn": "提醒"}


def main():
    argv = kit.strip_root_arg(sys.argv[1:])
    book = kit.load_book(sys.argv[1:])       # 书根/配置不合法时它自己 exit 2
    root = book.root

    issues = kit.style_doc_issues(root, getattr(book, "cfg", None))
    # ready 的判据只有一处：kit.style_gate_ready（一条 issue 都没有才算就绪）。
    # 不在这里另算一套，否则「闸门说就绪、kit 说没就绪」这种自相矛盾迟早出现。
    ready, blocking = kit.style_gate_ready(root, getattr(book, "cfg", None))

    findings = []
    for level, rel, why in issues:
        findings.append({
            "severity": LEVEL_TO_SEVERITY.get(level, "中等"),
            "chapter": "（书）",
            "line": 0,
            "check": f"[{LEVEL_LABEL.get(level, level)}] {rel}",
            "detail": why,
        })

    counts = {"严重": 0, "中等": 0, "轻微": 0, "提示": 0}
    for f in findings:
        counts[f["severity"]] += 1

    # stderr 摘要：把「三份文件分别什么状态」摊开，而不是只报一个总数。
    # 读者最需要的下一步信息是「该去填哪个文件」。
    _ep("风格/红线层前置检查（写正文之前）")
    _ep("=" * 60)
    for key, default, label, _tpl in kit.STYLE_DOCS:
        rel = str((getattr(book, "cfg", None) or {}).get("paths", {}).get(key) or default)
        hit = next((i for i in issues if i[1] == rel), None)
        if hit is None:
            _ep(f"  ✅ {label}：{rel}")
        else:
            _ep(f"  ⛔ {label}：{rel} —— {hit[2]}")
    _ep()
    if ready:
        _ep("结论：可以开写。")
    else:
        _ep(f"结论：⛔ 还不可以开写——上面 {len(blocking)} 项处理完之前，"
            "生成的正文没有文风依据。")
        _ep("      （判据是「一条 issue 都没有」：占位符、缺失、与模板一字不差，"
            "对下游都是零依据，一律拦。）")
    _ep()

    payload = {
        "gate": "style_doc_check",
        "book_root": root,
        # 书级闸门，无逐章归属。恒 0 → 接到 applyGateResult 的章数对账上必然抛错（失败关闭）。
        "chapter_count": 0,
        "scope": "book",
        "ready": ready,
        "counts": counts,
        "findings": findings,
    }
    print(json.dumps(payload, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    kit.force_utf8()
    sys.exit(main())
