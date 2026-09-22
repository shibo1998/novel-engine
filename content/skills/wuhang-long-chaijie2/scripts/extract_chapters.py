import os
import re
import sys


class _ChapterTitleMatch:
    """行级章节命中，接口与 re.Match 的 group(1)/start() 一致。"""

    __slots__ = ("_start", "_title")

    def __init__(self, start, title):
        self._start = start
        self._title = title

    def start(self):
        return self._start

    def group(self, n):
        return self._title if n == 1 else None


# 英文小说正文里的兵力统计行（非章节标题）
_TROOP_ROSTER_TITLE = re.compile(
    r"^(?:"
    r"Slaves?\s*\("
    r"|Monkeys?\s+in\s+the"
    r"|Undead Warrior Trolls?\.?$"
    r"|(?:Crimson |Ice )?Wolves?,\s"
    r"|Wolves?\s+in\s+the"
    r"|Slimes?\.$"
    r"|Mythical Elemental Spirits?\.$"
    r"|Wyverns?\.$"
    r")",
    re.IGNORECASE,
)


def _is_english_chapter_title(title):
    """Royal Road 等英文章节标题行（不含行首序号）。"""
    if re.match(r"(?:Side|Bonus) Chapter[:;]", title, re.IGNORECASE):
        return True
    if re.match(r"\[.+\]", title):
        return True
    if not re.match(r"[A-Z]", title):
        return False
    if re.search(r"\(Around|\blost \d+|\d+ left\.", title, re.IGNORECASE):
        return False
    if _TROOP_ROSTER_TITLE.match(title):
        return False
    if re.search(r"\bwere lost\.", title, re.IGNORECASE):
        return False
    if re.match(r"\d+\.-", title):
        return False
    return True


def _find_english_chapter_title_matches(text):
    """英文章节：行首「序号 + 标题」，并按章节号单调递增去噪。"""
    line_start = 0
    candidates = []
    for line in text.splitlines(keepends=True):
        stripped = line.strip()
        m = re.match(r"^(\d+)\s+(.+)$", stripped)
        if m and _is_english_chapter_title(m.group(2)):
            candidates.append(
                (line_start + line.find(stripped), int(m.group(1)), stripped)
            )
        line_start += len(line)

    if not candidates:
        return []

    kept = []
    last_num = 0
    for start, num, title in candidates:
        if num > last_num:
            kept.append(_ChapterTitleMatch(start, title))
            last_num = num
    return kept


def _find_chapter_title_matches(text):
    """章节标题行定位；规则须与 summarize.py 内同名函数保持一致。"""
    _indent = r"[ \t\u3000]*"
    md_only = re.compile(
        rf"(^{_indent}#+\s*第[ \d零一二三四五六七八九十百千万]+[章卷回节].*$)",
        re.MULTILINE,
    )
    md_hits = list(md_only.finditer(text))
    if len(md_hits) >= 2:
        return md_hits
    pattern = re.compile(
        rf"(^{_indent}(?:"
        r"#+\s*第[ \d零一二三四五六七八九十百千万]+[章卷回节]"
        r"|第[ \d零一二三四五六七八九十百千万]+[章卷回节]"
        r"|[\d]+[、．](?!\d)"
        r"|[\d]+\s+Chapter\s+[\d]+"
        r"|Chapter\s*[\d]+"
        r"|[\d]+\s+Chapter"
        r"|序章|尾声|番外|前言|后记"
        r").*$)",
        re.MULTILINE,
    )
    cn_hits = list(pattern.finditer(text))
    en_hits = _find_english_chapter_title_matches(text)
    if len(en_hits) >= 2 and len(en_hits) > len(cn_hits):
        return en_hits
    return cn_hits if cn_hits else en_hits


def _derive_novel_paths(novel_path):
    """根据项目根目录推导输出路径（与 SKILL 约定一致）。"""
    novel_path = os.path.abspath(novel_path)
    novel_name = os.path.splitext(os.path.basename(novel_path))[0]
    project_root = os.getcwd()
    boundary_dir = os.path.join(project_root, "1-边界")
    cache_dir = os.path.join(project_root, "summary_cache")
    return {
        "project_root": project_root,
        "boundary_dir": boundary_dir,
        "cache_dir": cache_dir,
        "novel_name": novel_name,
        "chapter_list_md": os.path.join(cache_dir, f"1.0_{novel_name}_章节目录.md"),
        "synopsis_file": os.path.join(boundary_dir, f"1.1_{novel_name}_故事梗概.md"),
    }


def _split_chapters(filepath):
    """读取文件并切分为章节列表，每项为 {index, title, content}。"""
    if not os.path.exists(filepath):
        print(f"❌ 错误：找不到文件 {filepath}")
        return []

    try:
        with open(filepath, "r", encoding="utf-8") as f:
            content = f.read()
    except Exception as e:
        print(f"❌ 读取文件失败: {e}")
        return []

    matches = _find_chapter_title_matches(content)
    if not matches:
        print("⚠️ 未检测到章节标题。请检查文件格式（如「第X章」或「# 第X章」独立成行）。")
        return []

    chapters = []
    for i, match in enumerate(matches):
        title = match.group(1).strip()
        start = match.start()
        end = matches[i + 1].start() if i + 1 < len(matches) else len(content)
        body = content[start:end].replace(title, "", 1).strip()
        chapters.append({"index": i + 1, "title": title, "content": body})
    return chapters


def export_chapter_list(chapters, novel_path):
    """将分章结果导出为章节目录（Markdown）。"""
    paths = _derive_novel_paths(novel_path)
    novel_name = paths["novel_name"]
    os.makedirs(paths["cache_dir"], exist_ok=True)

    md_lines = [
        f"# 《{novel_name}》章节目录",
        "",
        f"> 共 {len(chapters)} 章，由脚本自动识别分章",
        "",
        "| 序号 | 章节标题 | 正文字数 |",
        "| ---: | --- | ---: |",
    ]

    for c in chapters:
        title = c["title"]
        char_count = len(c.get("content", ""))
        safe_title = title.replace("|", "\\|")
        md_lines.append(f"| {c['index']} | {safe_title} | {char_count} |")

    with open(paths["chapter_list_md"], "w", encoding="utf-8") as f:
        f.write("\n".join(md_lines) + "\n")

    print(f"✅ 成功识别 {len(chapters)} 个章节")
    print(f"📋 章节目录已导出: {os.path.abspath(paths['chapter_list_md'])}")
    return paths["chapter_list_md"]


def list_chapters(filepath):
    chapters = _split_chapters(filepath)
    if not chapters:
        return
    export_chapter_list(chapters, filepath)
    print("👀 识别示例 (前5章):")
    for c in chapters[:5]:
        print(f"   - [{c['index']}] {c['title']}")
    print("   ...")


def extract_chapters(filepath, start_chap, end_chap):
    chapters = _split_chapters(filepath)
    if not chapters:
        return

    start_idx = max(0, start_chap - 1)
    end_idx = min(len(chapters), end_chap)

    if start_idx >= len(chapters):
        print(f"⚠️ 起始章节 {start_chap} 超出总章节数 {len(chapters)}。")
        return

    extracted = []
    for c in chapters[start_idx:end_idx]:
        extracted.append(c["title"] + "\n" + c["content"])

    text_out = "\n\n".join(extracted)

    if len(text_out) > 30000:
        text_out = text_out[:30000] + "\n\n...[内容过长已截断]..."

    print(text_out)


if __name__ == "__main__":
    if len(sys.argv) < 2:
        print("用法:")
        print("  python3 extract_chapters.py <小说文件路径> --list")
        print("  python3 extract_chapters.py <小说文件路径> <起始章号> <结束章号>")
        print("示例:")
        print("  python3 extract_chapters.py 1-边界/book.txt --list")
        print("  python3 extract_chapters.py 1-边界/book.txt 1 10")
        sys.exit(1)

    filepath = sys.argv[1]

    if len(sys.argv) >= 3 and sys.argv[2] == "--list":
        list_chapters(filepath)
        sys.exit(0)

    if len(sys.argv) < 4:
        print("❌ 错误：请提供起始章号与结束章号，或使用 --list 导出章节目录。")
        sys.exit(1)

    start = int(sys.argv[2])
    end = int(sys.argv[3])
    extract_chapters(filepath, start, end)
