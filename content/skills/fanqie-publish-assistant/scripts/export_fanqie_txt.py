#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""把正文整理成番茄可直接上传的 txt。

用法:
  python3 export_fanqie_txt.py 正文目录/ --book "书名"
  python3 export_fanqie_txt.py 第1章.md 第2章.md --book "书名" --out fanqie
  python3 export_fanqie_txt.py 全本.md --book "书名" --mode single --check

做的事:
  1. 复用 fix_punctuation.py 规范中文标点（方向性引号、全角标点、省略号、破折号）
  2. 清除全部 Markdown 标记（# * _ ~ > 列表符 分节符 链接 图片 行内代码）
  3. 清除多余空行、行尾空格、零宽字符、段首缩进空格
  4. 按章切分，章节标题统一成「第N章 标题」
  5. 输出整本 txt 与分章 txt，并给出自检报告

不做的事（需人工或模型判断）: 顿号与逗号的区分、书名号、错别字、
章节内容质量。这些请在导出后按 SKILL.md 的复查清单人工过一遍。
"""

import argparse
import re
import sys
import unicodedata
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from collections import Counter  # noqa: E402
from fix_punctuation import process_text as fix_punctuation_text  # noqa: E402

# ---------- Markdown / 空白清理 ----------

FRONTMATTER_RE = re.compile(r'\A---\n.*?\n(?:---|\.\.\.)\n', re.S)
FENCE_RE = re.compile(r'^\s*(?:```|~~~)')
HR_RE = re.compile(r'^\s*(?:-{3,}|\*{3,}|_{3,}|={3,})\s*$')
HEADING_RE = re.compile(r'^\s{0,3}(#{1,6})\s*')
QUOTE_RE = re.compile(r'^\s{0,3}>+\s?')
LIST_RE = re.compile(r'^\s{0,3}(?:[-*+•·]\s+|\d{1,3}[.)]\s+)')
IMAGE_RE = re.compile(r'!\[[^\]]*\]\([^)]*\)')
LINK_RE = re.compile(r'\[([^\]]*)\]\([^)]*\)')
INLINE_CODE_RE = re.compile(r'`+\s*([^`]*?)\s*`+')
STRIKE_RE = re.compile(r'~~(.+?)~~')
EMPH_RE = re.compile(r'(\*{1,3}|_{1,3})(?=\S)(.+?)(?<=\S)\1')
ZERO_WIDTH_RE = re.compile('[\\u200b-\\u200f\\u202a-\\u202e\\ufeff]')
LEADING_INDENT_RE = re.compile(r'^\s+')

RESIDUAL_MARKS = {
    '*': '星号（加粗/斜体残留）',
    '#': '井号（标题残留）',
    '`': '反引号（代码残留）',
    '~': '波浪号（删除线残留）',
    '"': '半角双引号',
    "'": '半角单引号',
}


def strip_markdown_line(line):
    line = IMAGE_RE.sub('', line)
    line = LINK_RE.sub(r'\1', line)
    line = INLINE_CODE_RE.sub(r'\1', line)
    line = STRIKE_RE.sub(r'\1', line)
    prev = None
    while prev != line:
        prev = line
        line = EMPH_RE.sub(r'\2', line)
    return line


def clean_text(text, stats):
    """清 Markdown 与不可见字符，再逐行修标点。

    返回 [(是否为标题行, 文本), ...]。顺序很重要：Markdown 必须先清干净再修
    标点，否则 `**"对话"**` 里的星号会让开引号被判成右引号。
    """
    text = text.replace('\r\n', '\n').replace('\r', '\n')
    text = FRONTMATTER_RE.sub('', text)
    text = ZERO_WIDTH_RE.sub('', text)

    out = []
    in_fence = False
    for raw in text.split('\n'):
        if FENCE_RE.match(raw):
            in_fence = not in_fence
            continue
        if HR_RE.match(raw):
            stats['分节符删除'] += 1
            continue
        if in_fence:
            line, heading = raw, None
        else:
            heading = HEADING_RE.match(raw)
            line = HEADING_RE.sub('', raw) if heading else raw
            line = QUOTE_RE.sub('', line)
            line = LIST_RE.sub('', line)
            line = strip_markdown_line(line)
        line = line.replace('\t', ' ').replace('\u00a0', ' ')
        line = LEADING_INDENT_RE.sub('', line).rstrip()
        line = fix_punctuation_text(line, False, stats)
        out.append((bool(heading), line))
    return out


# ---------- 章节识别 ----------

CN_DIGITS = {'零': 0, '〇': 0, '一': 1, '二': 2, '两': 2, '三': 3, '四': 4,
             '五': 5, '六': 6, '七': 7, '八': 8, '九': 9}
CN_UNITS = {'十': 10, '百': 100, '千': 1000}

CHAPTER_RE = re.compile(
    r'^第\s*([0-9０-９零〇一二三四五六七八九十百千两]+)\s*([章回节话])'
    r'\s*[:：.．、·~～\-—─_]*\s*(.*)$')
SPECIAL_RE = re.compile(
    r'^(楔子|序章|序言|序幕|序|引子|前言|尾声|终章|结局|后记|番外[^\s]{0,20})'
    r'\s*[:：.．、·~～\-—─_]*\s*(.*)$')
MAX_TITLE_LEN = 50


def cn_to_int(s):
    s = unicodedata.normalize('NFKC', s.strip())
    if s.isdigit():
        return int(s)
    total, section = 0, 0
    for ch in s:
        if ch in CN_DIGITS:
            section = CN_DIGITS[ch]
        elif ch in CN_UNITS:
            unit = CN_UNITS[ch]
            section = section or 1
            if unit == 10:
                total += section * 10
            else:
                total += section * unit
            section = 0
        else:
            return None
    return total + section


INT_UNITS = ['', '十', '百', '千']
INT_DIGITS = '零一二三四五六七八九'


def int_to_cn(n):
    if n <= 0 or n > 9999:
        return str(n)
    if n < 10:
        return INT_DIGITS[n]
    if n < 20:
        return '十' + (INT_DIGITS[n % 10] if n % 10 else '')
    digits = str(n)
    parts, zero = [], False
    for i, ch in enumerate(digits):
        d = int(ch)
        unit = INT_UNITS[len(digits) - 1 - i]
        if d == 0:
            zero = True
            continue
        if zero and parts:
            parts.append('零')
        zero = False
        parts.append(INT_DIGITS[d] + unit)
    return ''.join(parts)


def detect_chapter(is_heading, line):
    """返回 (编号 or None, 标题正文, 单位字, 原标题行)；不是章节标题则返回 None。"""
    s = line.strip()
    if not s or len(s) > MAX_TITLE_LEN:
        return None
    m = CHAPTER_RE.match(s)
    if m:
        return cn_to_int(m.group(1)), m.group(3).strip(), m.group(2), s
    m = SPECIAL_RE.match(s)
    if m:
        name = (m.group(1) + (' ' + m.group(2).strip() if m.group(2).strip() else ''))
        return None, name, '', s
    if is_heading:
        return None, s, '', s
    return None


def format_title(chapter, style):
    if style == 'keep':
        return chapter.raw
    if chapter.number is None:
        return chapter.name
    num = int_to_cn(chapter.number) if style == 'chinese' else str(chapter.number)
    return f'第{num}{chapter.unit or "章"} {chapter.name}'.rstrip()


# ---------- 切分 ----------

class Chapter:
    def __init__(self, number, name, unit, source, raw=None):
        self.number = number
        self.name = name
        self.unit = unit
        self.source = source
        self.raw = raw if raw is not None else name
        self.paragraphs = []

    def word_count(self):
        return sum(len(re.sub(r'\s', '', p)) for p in self.paragraphs)


def split_chapters(lines, source, fallback_title):
    chapters, current = [], None
    preface = []
    for is_heading, line in lines:
        hit = detect_chapter(is_heading, line)
        if hit is not None:
            number, name, unit, raw = hit
            current = Chapter(number, name, unit, source, raw)
            chapters.append(current)
            continue
        content = line.strip()
        if not content:
            continue
        if current is None:
            preface.append(content)
        else:
            current.paragraphs.append(content)
    if preface:
        head = Chapter(None, fallback_title, '', source)
        head.paragraphs = preface
        chapters.insert(0, head)
    return chapters


# ---------- 输出 ----------

INVALID_FILENAME_RE = re.compile(r'[\\/:*?"<>|\n\r\t]')


def safe_filename(name):
    name = INVALID_FILENAME_RE.sub('_', name).strip().strip('.')
    return name[:80] or '未命名'


def chapter_text(title, chapter):
    return '\n'.join([title] + chapter.paragraphs) + '\n'


def read_source_text(path):
    """先按 UTF-8 读（自动去 BOM），解码失败再退回 GBK。

    Windows 上用记事本存成 ANSI 的旧稿也能直接处理。
    """
    data = path.read_bytes()
    for enc in ('utf-8-sig', 'gbk'):
        try:
            return data.decode(enc)
        except UnicodeDecodeError:
            continue
    return data.decode('utf-8', errors='replace')


def write_file(path, text, encoding):
    path.parent.mkdir(parents=True, exist_ok=True)
    with open(path, 'w', encoding=encoding, newline='\n') as fh:
        fh.write(text)


# ---------- 自检 ----------

def audit(chapters, titles):
    problems = []
    seen = {}
    prev = None
    for idx, (ch, title) in enumerate(zip(chapters, titles), 1):
        wc = ch.word_count()
        label = f'[{idx}] {title}（{ch.source.name}）'
        if not ch.paragraphs:
            problems.append(f'{label}：空章，没有正文')
        elif wc < 500:
            problems.append(f'{label}：仅 {wc} 字，番茄读者习惯 2000–4000 字/章，建议合并或扩写')
        elif wc > 10000:
            problems.append(f'{label}：{wc} 字，单章过长，建议拆分')
        if ch.number is not None:
            if ch.number in seen:
                problems.append(f'{label}：章节号与 [{seen[ch.number]}] 重复')
            else:
                seen[ch.number] = idx
            if prev is not None and ch.number != prev + 1:
                problems.append(f'{label}：章节号不连续（上一章为第 {prev} 章）')
            prev = ch.number
        if not ch.name and ch.number is not None:
            problems.append(f'{label}：只有章节号，没有章节名')
        body = '\n'.join(ch.paragraphs)
        for mark, desc in RESIDUAL_MARKS.items():
            if mark in body:
                problems.append(f'{label}：正文残留 {desc} `{mark}`')
    return problems


def main():
    ap = argparse.ArgumentParser(description='把正文整理成番茄可直接上传的 txt')
    ap.add_argument('inputs', nargs='+', help='正文文件或目录（.md / .txt）')
    ap.add_argument('--book', required=True, help='书名，用于输出文件名')
    ap.add_argument('--out', default='fanqie', help='输出目录，默认 fanqie/')
    ap.add_argument('--mode', choices=['both', 'single', 'split'], default='both',
                    help='both=整本+分章（默认），single=只出整本，split=只出分章')
    ap.add_argument('--number-style', choices=['arabic', 'chinese', 'keep'],
                    default='arabic', help='章节号格式，默认阿拉伯数字')
    ap.add_argument('--pad', action='store_true',
                    help='分章文件名加 001_ 前缀（上传工具按文件名排序时用）')
    ap.add_argument('--encoding', default='utf-8',
                    help='输出编码，默认 utf-8；老工具需要时可用 gbk')
    ap.add_argument('--check', action='store_true', help='只跑自检，不写文件')
    args = ap.parse_args()

    files = []
    for item in args.inputs:
        p = Path(item)
        if p.is_dir():
            files.extend(sorted(q for q in p.rglob('*')
                                if q.suffix.lower() in ('.md', '.txt')))
        elif p.exists():
            files.append(p)
        else:
            print(f'跳过：找不到 {item}', file=sys.stderr)
    if not files:
        print('没有可处理的文件', file=sys.stderr)
        sys.exit(1)

    chapters = []
    stats = Counter()
    for f in files:
        text = read_source_text(f)
        lines = clean_text(text, stats)
        chapters.extend(split_chapters(lines, f, f.stem))

    if not chapters:
        print('没有识别到任何章节，请检查章节标题格式（如「第1章 标题」）', file=sys.stderr)
        sys.exit(1)

    style = args.number_style
    titles = [format_title(c, style) for c in chapters]
    total_words = sum(c.word_count() for c in chapters)

    print(f'源文件 {len(files)} 个，识别章节 {len(chapters)} 章，总字数 {total_words}')
    if stats:
        print('标点修复：' + '，'.join(f'{k} {v} 处' for k, v in stats.items()))

    problems = audit(chapters, titles)
    if problems:
        print(f'\n自检发现 {len(problems)} 项待确认：')
        for p in problems:
            print('  - ' + p)
    else:
        print('自检通过：无空章、无残留标记、章节号连续')

    if args.check:
        sys.exit(1 if problems else 0)

    out = Path(args.out)
    written = []
    if args.mode in ('both', 'single'):
        whole = '\n\n'.join(chapter_text(t, c).rstrip('\n')
                            for t, c in zip(titles, chapters)) + '\n'
        path = out / f'{safe_filename(args.book)}【全本】.txt'
        write_file(path, whole, args.encoding)
        written.append(path)
    if args.mode in ('both', 'split'):
        chapter_dir = out / '分章'
        for idx, (title, ch) in enumerate(zip(titles, chapters), 1):
            prefix = f'{idx:03d}_' if args.pad else ''
            path = chapter_dir / f'{prefix}{safe_filename(title)}.txt'
            write_file(path, chapter_text(title, ch), args.encoding)
            written.append(path)
        manifest = '\n'.join(f'{i:>4}. {t}（{c.word_count()} 字）'
                             for i, (t, c) in enumerate(zip(titles, chapters), 1))
        index = out / '_上传清单.txt'
        write_file(index, f'{args.book}\n共 {len(chapters)} 章，{total_words} 字\n\n{manifest}\n',
                   args.encoding)
        written.append(index)

    print(f'\n已输出 {len(written)} 个文件到 {out}/（编码 {args.encoding}）')
    sys.exit(0)


if __name__ == '__main__':
    main()
