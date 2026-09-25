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


def make_book(root, chapter_text=PLAIN_TEXT, style_filled=True, book_json=None):
    """造一本最小可检书。style_filled=False 时三份风格文件保持未填模板形态（缺失）。"""
    os.makedirs(os.path.join(root, ".soloent"), exist_ok=True)
    os.makedirs(os.path.join(root, "chapters"), exist_ok=True)
    os.makedirs(os.path.join(root, "state"), exist_ok=True)
    cfg = BOOK_JSON if book_json is None else book_json
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
