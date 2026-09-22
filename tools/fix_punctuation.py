#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""按中文标点规范批量修复正文标点。

用法:
  python3 fix_punctuation.py 文件...                  就地修复
  python3 fix_punctuation.py --check 文件...          只检查并输出 diff，不写回（有问题时退出码为 1）
  python3 fix_punctuation.py --strip-markdown 文件... 修复标点，同时删除加粗/斜体标记和分节符行

处理范围（机械可判定的规则）:
  1. 直引号 ' " 按上下文转为方向性引号 ‘ ’ “ ”，撇号转 ’（所有语言段落都处理）
  2. 中文行（汉字多于拉丁字母且无假名）的半角标点转全角:
     , ; : ? ! . 转 ，；：？！。，成对括号内含汉字时 ( ) 转 （ ），
     三个以上的点或单个 … 转 ……，-- 或单个 — 转 ——
  3. 嵌入的英文原词、数字（如 3.14、1,000、soloent.ai）、行内代码、
     URL、邮箱、有序列表编号保留半角，代码块和 YAML frontmatter 整体跳过

不处理（需模型判断）: 顿号与逗号的区分、书名号、日文「」韩文标点、
Markdown 列表改写为纯文本段落。
"""

import argparse
import difflib
import re
import sys
from collections import Counter
from pathlib import Path

HAN = re.compile(r'[㐀-鿿豈-﫿]')
KANA = re.compile(r'[぀-ヿ]')
LATIN = re.compile(r'[A-Za-z]')

INLINE_CODE_RE = re.compile(r'`[^`]*`')
URL_RE = re.compile(r'(?:https?://|www\.)\S+')
EMAIL_RE = re.compile(r'[\w.+-]+@[\w-]+\.[\w.-]+')
LIST_NUM_RE = re.compile(r'^\s*\d{1,3}[.)]\s')

OPEN_BEFORE = '([{（【《‘“「『：:，,'
SIMPLE = {',': '，', ';': '；', ':': '：', '?': '？', '!': '！'}

BOLD_RE = re.compile(r'\*\*([^*\n]+)\*\*')
ITALIC_RE = re.compile(r'(?<!\*)\*([^*\n]+)\*(?!\*)')
HR_RE = re.compile(r'^\s*(?:-{3,}|\*{3,}|_{3,})\s*$')


def protected_mask(line):
    mask = [False] * len(line)
    for regex in (INLINE_CODE_RE, URL_RE, EMAIL_RE):
        for m in regex.finditer(line):
            for i in range(m.start(), m.end()):
                mask[i] = True
    m = LIST_NUM_RE.match(line)
    if m:
        for i in range(m.end()):
            mask[i] = True
    return mask


def is_ascii_word(ch):
    return bool(ch) and ch.isascii() and ch.isalnum()


def next_nonspace(s, i):
    j = i + 1
    while j < len(s) and s[j].isspace():
        j += 1
    return s[j] if j < len(s) else ''


def prev_nonspace(s, i):
    j = i - 1
    while j >= 0 and s[j].isspace():
        j -= 1
    return s[j] if j >= 0 else ''


def fix_quotes(line, mask, stats):
    out = list(line)
    for i, ch in enumerate(line):
        if mask[i]:
            continue
        if ch == '"':
            prev = out[i - 1] if i else ''
            if not prev or prev.isspace() or prev in OPEN_BEFORE:
                out[i] = '“'
            else:
                out[i] = '”'
            stats['引号'] += 1
        elif ch == "'":
            prev = out[i - 1] if i else ''
            nxt = line[i + 1] if i + 1 < len(line) else ''
            if is_ascii_word(prev) and nxt.isalpha():
                out[i] = '’'  # 撇号: it's / John's
            elif not prev or prev.isspace() or prev in OPEN_BEFORE:
                out[i] = '‘'
            else:
                out[i] = '’'
            stats['引号'] += 1
    return ''.join(out)


def is_chinese_line(line, mask):
    visible = ''.join(ch for i, ch in enumerate(line) if not mask[i])
    if KANA.search(visible):
        return False
    han = len(HAN.findall(visible))
    return han > 0 and han >= len(LATIN.findall(visible))


def fix_halfwidth(line, mask, stats):
    out = list(line)
    for i, ch in enumerate(line):
        if mask[i]:
            continue
        if ch in SIMPLE or ch == '.':
            prev = line[i - 1] if i else ''
            if is_ascii_word(prev) and is_ascii_word(next_nonspace(line, i)):
                continue  # 英文/数字内部: 3.14, 1,000, no, thanks
            out[i] = SIMPLE.get(ch, '。')
            stats['全角标点'] += 1
    return ''.join(out)


def fix_parens(line, mask, stats):
    out = list(line)
    stack = []
    for i, ch in enumerate(line):
        if mask[i]:
            continue
        if ch == '(':
            stack.append(i)
        elif ch == ')':
            if stack:
                j = stack.pop()
                if HAN.search(line[j + 1:i]):
                    out[j], out[i] = '（', '）'
                    stats['全角标点'] += 2
            elif HAN.search(prev_nonspace(line, i)):
                out[i] = '）'
                stats['全角标点'] += 1
    for j in stack:
        if HAN.search(next_nonspace(line, j)):
            out[j] = '（'
            stats['全角标点'] += 1
    return ''.join(out)


LENGTH_CHANGING = [
    (re.compile(r'(?:\.{3,}|。{3,})'), '……', '省略号'),
    (re.compile(r'(?<!…)…(?!…)'), '……', '省略号'),
    (re.compile(r'-{2,}'), '——', '破折号'),
    (re.compile(r'(?<!—)—(?!—)'), '——', '破折号'),
]


def sub_masked(pattern, repl, line, mask, stats, label):
    parts, last = [], 0
    for m in pattern.finditer(line):
        if any(mask[m.start():m.end()]):
            continue
        if line[m.start():m.end()] == repl:
            continue
        parts.append(line[last:m.start()])
        parts.append(repl)
        last = m.end()
        stats[label] += 1
    parts.append(line[last:])
    return ''.join(parts)


def process_text(text, strip_md, stats):
    lines = text.split('\n')
    out_lines = []
    in_fence = False
    in_front = False
    for idx, line in enumerate(lines):
        stripped = line.strip()
        if idx == 0 and stripped == '---':
            in_front = True
            out_lines.append(line)
            continue
        if in_front:
            out_lines.append(line)
            if stripped in ('---', '...'):
                in_front = False
            continue
        if stripped.startswith('```') or stripped.startswith('~~~'):
            in_fence = not in_fence
            out_lines.append(line)
            continue
        if in_fence:
            out_lines.append(line)
            continue
        if strip_md and HR_RE.match(line):
            stats['分节符删除'] += 1
            continue
        mask = protected_mask(line)
        line = fix_quotes(line, mask, stats)
        if is_chinese_line(line, mask):
            line = fix_halfwidth(line, mask, stats)
            line = fix_parens(line, mask, stats)
            for pattern, repl, label in LENGTH_CHANGING:
                mask = protected_mask(line)
                line = sub_masked(pattern, repl, line, mask, stats, label)
        if strip_md and not stripped.startswith('#'):
            before = line
            line = BOLD_RE.sub(r'\1', line)
            line = ITALIC_RE.sub(r'\1', line)
            if line != before:
                stats['格式标记删除'] += 1
        out_lines.append(line)
    return '\n'.join(out_lines)


def main():
    ap = argparse.ArgumentParser(description='按中文标点规范批量修复正文标点')
    ap.add_argument('files', nargs='+')
    ap.add_argument('--check', action='store_true', help='只检查并输出 diff，不写回')
    ap.add_argument('--strip-markdown', action='store_true',
                    help='同时删除加粗/斜体标记和分节符行')
    args = ap.parse_args()

    dirty = False
    for f in args.files:
        p = Path(f)
        text = p.read_text(encoding='utf-8')
        stats = Counter()
        new = process_text(text, args.strip_markdown, stats)
        if new == text:
            print(f'{f}: 无需修改')
            continue
        dirty = True
        summary = '，'.join(f'{k} {v} 处' for k, v in stats.items())
        if args.check:
            sys.stdout.writelines(difflib.unified_diff(
                text.splitlines(keepends=True), new.splitlines(keepends=True),
                fromfile=f, tofile=f + ' (修复后)'))
            print(f'\n{f}: 待修复 {summary}')
        else:
            p.write_text(new, encoding='utf-8')
            print(f'{f}: 已修复 {summary}')
    sys.exit(1 if (args.check and dirty) else 0)


if __name__ == '__main__':
    main()
