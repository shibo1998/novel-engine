#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
gates 检查器的回归固件（B-15 / docs/24 P2-2）。

为什么用 **unittest 而不是 pytest**：本机 `python -m pytest` 报 `No module named pytest`，
而本仓没有 Python 打包设施。引入 pytest 就等于多一步「先 pip install」——
那一步一定会被忘记，然后这些固件变成「文件在但从不运行」的死重量，
正是本项目反复在治的形态（docs/23 自承过、2026-09-25 又栽过一次：
`packages/core` 的 test 脚本硬编码文件清单，新增测试静默不执行）。
unittest 是标准库，零依赖，`python -m unittest` 直接跑。

跑法（在仓根）：
    python -m unittest discover -s gates/tests -t gates/tests -v
也会被 `pnpm -r test` 通过 packages/core/test/gates-python.test.ts 自动带上。

固件纪律：**每个检查器至少一正一反**。
只测正例等于只证明「它没崩」，不证明「它有牙齿」。
"""
import json
import os
import shutil
import subprocess
import sys
import tempfile
import unittest

GATES_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
PY = os.environ.get("NOVEL_PYTHON") or ("python" if os.name == "nt" else "python3")

# 含多处 AI 句式（裁判腔 / 柔化副词 / 时间切片 / 否定排比 / 空气拟态）
AI_STYLE_TEXT = (
    "# 第1章 测试\n\n"
    "他知道事情没那么简单。空气仿佛凝固了。\n\n"
    "他缓缓抬起头，一瞬间，脑海里闪过无数画面——不是恐惧，不是犹豫，是某种更冷的东西。\n\n"
    "林砚轻轻叹了口气。屋里鸦雀无声。\n"
)
PLAIN_TEXT = (
    "# 第1章 测试\n\n"
    "林砚推开门，风灌进来，窗纸哗哗响。\n\n"
    "他走到桌前，把冷馒头掰成两半，一半塞进嘴里。\n\n"
    "灶上的水开了，白汽一股股往上冒。\n"
)

BOOK_JSON = {
    "_schema": 1,
    "book": {"title": "固件书"},
    "paths": {
        "chapters": "chapters",
        "canon": ".soloent/canon.md",
        "ledger": ".soloent/ledger.tsv",
        "now": ".soloent/now.md",
    },
    "chapter": {"file_regex": "^ch-(\\d+)\\.md$"},
    "ledger": {"columns": ["章", "标题"], "chapter_column": "章", "title_column": "标题"},
}

STYLE_DOCS = {
    os.path.join(".soloent", "rules", "story-style.md"): "# 本书风格规则\n\n## 1 叙述\n短句为主，第三人称限知。\n",
    os.path.join(".soloent", "constitution", "MASTER.md"): "# 创作宪法\n\n1. 不写未成年恋爱。\n",
    os.path.join("1-边界", "预期.md"): "# 开书预期\n\n男频高武，每章两个爽点，章末留钩子。\n",
}


def make_book(root, chapter_text=PLAIN_TEXT, style_filled=True, book_json=None, extra_cfg=None, extra_chapters=None):
    """造一本最小可检书。

    style_filled=False → 三份风格文件缺失（反例）；
    extra_cfg         → 合并进 book.json 顶层（如 checks.duplicate / checks.sensitive）；
    extra_chapters    → {文件名: 正文}，追加章节（跨章判据需要两章以上）。
    """
    os.makedirs(os.path.join(root, ".soloent"), exist_ok=True)
    os.makedirs(os.path.join(root, "chapters"), exist_ok=True)
    os.makedirs(os.path.join(root, "state"), exist_ok=True)
    cfg = dict(BOOK_JSON if book_json is None else book_json)
    if extra_cfg:
        cfg.update(extra_cfg)
    with open(os.path.join(root, ".soloent", "book.json"), "w", encoding="utf-8") as f:
        json.dump(cfg, f, ensure_ascii=False)
    with open(os.path.join(root, ".soloent", "canon.md"), "w", encoding="utf-8") as f:
        f.write("# 正典\n主角：林砚。\n")
    with open(os.path.join(root, ".soloent", "ledger.tsv"), "w", encoding="utf-8") as f:
        f.write("章\t标题\n")
    with open(os.path.join(root, ".soloent", "now.md"), "w", encoding="utf-8") as f:
        f.write("# 当前进度\n\n（待填）\n")
    with open(os.path.join(root, "chapters", "ch-01.md"), "w", encoding="utf-8") as f:
        f.write(chapter_text)
    for fn, text in (extra_chapters or {}).items():
        with open(os.path.join(root, "chapters", fn), "w", encoding="utf-8") as f:
            f.write(text)
    if style_filled:
        for rel, text in STYLE_DOCS.items():
            p = os.path.join(root, rel)
            os.makedirs(os.path.dirname(p), exist_ok=True)
            with open(p, "w", encoding="utf-8") as f:
                f.write(text)
    return root


def run_gate(gate, root):
    """跑一个检查器，返回 (exit_code, payload|None, stderr)。

    payload 解析规则与 TS 侧一致：**只看 stdout**。非 0 退出时 stdout 里是结构化原因
    （`{ok:false, error:{kind}}`），不是结论。
    """
    proc = subprocess.run(
        [PY, os.path.join(GATES_DIR, gate + ".py"), "--root", root],
        capture_output=True, text=True, encoding="utf-8", timeout=180,
        env={**os.environ, "PYTHONIOENCODING": "utf-8"},
    )
    payload = None
    out = (proc.stdout or "").strip()
    if out:
        try:
            payload = json.loads(out)
        except ValueError:
            payload = None
    return proc.returncode, payload, proc.stderr or ""


class GateTestCase(unittest.TestCase):
    def setUp(self):
        self.root = tempfile.mkdtemp(prefix="novel-gate-fixture-")

    def tearDown(self):
        shutil.rmtree(self.root, ignore_errors=True)


class TestConsistencyCheck(GateTestCase):
    """章级内容对账。正例：正常正文；反例：AI 句式正文。"""

    def test_plain_chapter_is_clean_and_exits_zero(self):
        make_book(self.root, chapter_text=PLAIN_TEXT)
        code, payload, _ = run_gate("consistency_check", self.root)
        self.assertEqual(code, 0, "发现问题也返回 0；退出码只表示脚本有没有跑完")
        self.assertIsNotNone(payload, "stdout 必须是合法 JSON")
        self.assertEqual(payload["chapter_count"], 1, "章数对账是回填的前提，必须准")
        self.assertEqual(payload["findings"], [], "平实正文不该被误报")

    def test_ai_style_chapter_reports_findings(self):
        """反例——固件有牙齿的证明。没有这一条，正例只说明「它没崩」。"""
        make_book(self.root, chapter_text=AI_STYLE_TEXT)
        code, payload, _ = run_gate("consistency_check", self.root)
        self.assertEqual(code, 0)
        self.assertGreater(len(payload["findings"]), 0, "AI 句式必须被报出来")
        for f in payload["findings"]:
            self.assertIn(f["severity"], ("严重", "中等", "轻微", "提示"))
            self.assertEqual(f["chapter"], "ch-01.md")

    def test_chapter_count_matches_actual_files(self):
        make_book(self.root, chapter_text=PLAIN_TEXT)
        for i in (2, 3):
            with open(os.path.join(self.root, "chapters", "ch-0%d.md" % i), "w", encoding="utf-8") as f:
                f.write(PLAIN_TEXT.replace("第1章", "第%d章" % i))
        _, payload, _ = run_gate("consistency_check", self.root)
        self.assertEqual(payload["chapter_count"], 3, "章数对不上会让回填被拒（F12），这里钉住")


class TestStyleDocCheck(GateTestCase):
    """书级前置闸门。正例：三份填好；反例：一份都没落。"""

    def test_filled_docs_are_ready(self):
        make_book(self.root, style_filled=True)
        code, payload, _ = run_gate("style_doc_check", self.root)
        self.assertEqual(code, 0)
        self.assertTrue(payload["ready"], "填好的书不该被误拦")
        self.assertEqual(payload["findings"], [])

    def test_missing_docs_are_not_ready(self):
        make_book(self.root, style_filled=False)
        code, payload, _ = run_gate("style_doc_check", self.root)
        self.assertEqual(code, 0, "未就绪是**结论**，不是执行失败——退出码仍为 0")
        self.assertFalse(payload["ready"], "三份都没落必须拦")
        self.assertGreaterEqual(len(payload["findings"]), 3, "三份文件各应有对应发现")

    def test_chapter_count_is_always_zero(self):
        """书级闸门恒 chapter_count=0 → 接到回填的章数对账上必然抛错（失败关闭）。

        这条钉住的是**设计意图**：它不许被接到 applyGateResult 上把全书刷绿。
        """
        make_book(self.root, style_filled=True)
        _, payload, _ = run_gate("style_doc_check", self.root)
        self.assertEqual(payload["chapter_count"], 0)
        self.assertEqual(payload.get("scope"), "book")


class TestExitCodeContract(GateTestCase):
    """B-14：非 0 = 本次没有结论，且 stdout 要给出**结构化**原因。"""

    def test_broken_config_exits_2_with_structured_error(self):
        make_book(self.root)
        with open(os.path.join(self.root, ".soloent", "book.json"), "w", encoding="utf-8") as f:
            json.dump({"book": {"title": "坏配置"}}, f, ensure_ascii=False)

        for gate in ("consistency_check", "style_doc_check"):
            code, payload, _ = run_gate(gate, self.root)
            self.assertEqual(code, 2, "%s：配置错必须是 2" % gate)
            self.assertIsNotNone(payload, "%s：非 0 也要给结构化原因，否则上层只能拿到一坨文本" % gate)
            self.assertIs(payload.get("ok"), False)
            self.assertEqual(payload["error"]["kind"], "config")
            self.assertTrue(payload["error"]["problems"], "缺项要逐条列出来，不能只给一句概述")
            self.assertNotIn("findings", payload, "★失败时**不许**带 findings——那会被读成结论")

    def test_no_config_at_all_exits_2(self):
        code, payload, _ = run_gate("consistency_check", self.root)  # 空目录，没有 book.json
        self.assertEqual(code, 2)
        self.assertEqual(payload["error"]["kind"], "config")

    def test_crash_exits_1_with_structured_error(self):
        """崩溃路径：未捕获异常 → exit 1 + stdout 结构化原因（由 kit.run_main 兜住）。"""
        script = (
            "import sys; sys.path.insert(0, %r); import kit; kit.force_utf8();"
            "kit.run_main(lambda: 1/0)" % GATES_DIR
        )
        proc = subprocess.run([PY, "-c", script], capture_output=True, text=True, encoding="utf-8", timeout=60)
        self.assertEqual(proc.returncode, 1, "崩溃是 1，与配置错（2）分开")
        payload = json.loads(proc.stdout.strip())
        self.assertEqual(payload["error"]["kind"], "crash")
        self.assertIn("ZeroDivisionError", payload["error"]["detail"])
        self.assertIn("Traceback", proc.stderr, "traceback 仍要留在 stderr 供排查")


if __name__ == "__main__":
    unittest.main(verbosity=2)


class TestSensitiveCheck(GateTestCase):
    """B-47：平台敏感词闸门。★最要紧的是「词表没配 = 未生效」不许长得像「扫过且干净」。"""

    def test_no_word_list_is_explicitly_not_effective(self):
        make_book(self.root)
        code, payload, err = run_gate("sensitive_check", self.root)
        self.assertEqual(code, 0, "未生效是**结论**，不是执行失败")
        self.assertEqual(payload["findings"], [], "没词表当然没发现")
        # ★关键：空的 findings 必须伴随 not_effective，否则读的人会以为「扫过且干净」
        self.assertEqual(payload.get("not_effective"), ["sensitive"])
        self.assertIn("未配置词表路径", payload.get("not_effective_reason", ""))
        self.assertIn("未生效", err)
        self.assertIn("不是「没有敏感词」，是「没扫」", err)

    def test_missing_word_file_is_not_effective_with_reason(self):
        make_book(self.root, extra_cfg={"checks": {"sensitive": {"words": ".soloent/不存在的词表.txt"}}})
        code, payload, _ = run_gate("sensitive_check", self.root)
        self.assertEqual(code, 0)
        self.assertEqual(payload.get("not_effective"), ["sensitive"])
        self.assertIn("不存在", payload.get("not_effective_reason", ""))

    def test_hit_reports_severity_and_line(self):
        make_book(self.root, chapter_text="# 第1章 测试\n\n他掏出那把管制刀具。\n\n雨还在下。\n",
                  extra_cfg={"checks": {"sensitive": {"words": ".soloent/词表.txt"}}})
        with open(os.path.join(self.root, ".soloent", "词表.txt"), "w", encoding="utf-8") as f:
            f.write("# 平台红线\n\n管制刀具\n")
        code, payload, _ = run_gate("sensitive_check", self.root)
        self.assertEqual(code, 0, "发现问题也返回 0")
        self.assertEqual(len(payload["findings"]), 1)
        f0 = payload["findings"][0]
        self.assertEqual(f0["severity"], "严重", "平台红线默认硬拦截")
        self.assertEqual(f0["chapter"], "ch-01.md")
        self.assertEqual(f0["line"], 3, "要给出行号供人工定位")
        self.assertIn("管制刀具", f0["check"])
        self.assertNotIn("not_effective", payload, "词表配好时不该有未生效标记")

    def test_clean_chapter_with_word_list_has_no_marker(self):
        """反例的反例：有词表、没命中 → 真的干净（**没有** not_effective）。"""
        make_book(self.root, extra_cfg={"checks": {"sensitive": {"words": ".soloent/词表.txt"}}})
        with open(os.path.join(self.root, ".soloent", "词表.txt"), "w", encoding="utf-8") as f:
            f.write("管制刀具\n")
        code, payload, _ = run_gate("sensitive_check", self.root)
        self.assertEqual(code, 0)
        self.assertEqual(payload["findings"], [])
        self.assertNotIn("not_effective", payload)

    def test_empty_word_list_is_not_effective(self):
        """词表存在但只有注释 → 同样是「没扫」，不是「干净」。"""
        make_book(self.root, extra_cfg={"checks": {"sensitive": {"words": ".soloent/词表.txt"}}})
        with open(os.path.join(self.root, ".soloent", "词表.txt"), "w", encoding="utf-8") as f:
            f.write("# 只有注释\n\n")
        _, payload, _ = run_gate("sensitive_check", self.root)
        self.assertEqual(payload.get("not_effective"), ["sensitive"])
        self.assertIn("是空的", payload.get("not_effective_reason", ""))


class TestDuplicateCheck(GateTestCase):
    """B-46：章内/跨章重复。两类判据各一正一反。"""

    def test_cross_chapter_duplicate_sentence_is_reported(self):
        dup = "山风从谷口灌进来，吹得满坡的野草伏成一片。"
        make_book(self.root, chapter_text=f"# 第1章 测试\n\n{dup}\n",
                  extra_chapters={"ch-02.md": f"# 第2章 测试\n\n他停下脚步。\n\n{dup}\n"})
        code, payload, _ = run_gate("duplicate_check", self.root)
        self.assertEqual(code, 0)
        hits = [f for f in payload["findings"] if "跨章重复句" in f["check"]]
        self.assertEqual(len(hits), 1, "同一句跨两章应报一条")
        self.assertEqual(hits[0]["severity"], "中等")
        self.assertEqual(hits[0]["chapter"], "ch-02.md", "报在后出现的那一章（先读到的不算问题）")
        self.assertIn("第 1 章、第 2 章", hits[0]["check"])

    def test_short_sentence_repeat_is_not_reported(self):
        """短句重复是正常的（「他点了点头。」）——长度下限就是为它设的。"""
        make_book(self.root, chapter_text="# 第1章 测试\n\n他点了点头。\n",
                  extra_chapters={"ch-02.md": "# 第2章 测试\n\n他点了点头。\n"})
        _, payload, _ = run_gate("duplicate_check", self.root)
        self.assertEqual([f for f in payload["findings"] if "跨章重复句" in f["check"]], [])

    def test_within_chapter_phrase_repeat_is_reported(self):
        # 4 份：10 字窗口要跨过 7 字单元的边界才重复，3 份只能凑出 2 次（不到 min_repeat=3）
        make_book(self.root, chapter_text="# 第1章 测试\n\n" + "他缓缓抬起头。".join(["", "", "", "", ""]) + "\n")
        code, payload, _ = run_gate("duplicate_check", self.root)
        self.assertEqual(code, 0)
        hits = [f for f in payload["findings"] if "章内重复" in f["check"]]
        self.assertGreater(len(hits), 0, "同一短语在本章出现 3 次以上应报")
        self.assertEqual(hits[0]["severity"], "轻微", "排比/口头禅也可能触发 → 只报线索")

    def test_plain_text_is_clean(self):
        make_book(self.root, chapter_text=PLAIN_TEXT)
        code, payload, _ = run_gate("duplicate_check", self.root)
        self.assertEqual(code, 0)
        self.assertEqual(payload["findings"], [], "平实正文不该被误报")

    def test_config_overrides_defaults(self):
        """把阈值调高到不可能触发 → 同一个夹具不再报（证明配置真的被读）。"""
        dup = "山风从谷口灌进来，吹得满坡的野草伏成一片。"
        make_book(self.root, chapter_text=f"# 第1章 测试\n\n{dup}\n",
                  extra_chapters={"ch-02.md": f"# 第2章 测试\n\n{dup}\n"},
                  extra_cfg={"checks": {"duplicate": {"min_sentence_chars": 999}}})
        _, payload, _ = run_gate("duplicate_check", self.root)
        self.assertEqual([f for f in payload["findings"] if "跨章重复句" in f["check"]], [],
                         "阈值调到 999 后不该再报——配置没被读的话这里会红")
