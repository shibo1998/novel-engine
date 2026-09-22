#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
章节字数统计（修复版）—— 替代 wuhang-long-all 插件内那份失效脚本。

修复了原版的四个问题：
  1. 硬编码作者 Mac 路径 /Users/wuhang/Desktop/都市穿越文豪/novel/4-正文 → 改为三级解析
  2. 平均字数与百分比写死 //44 → 改为按实际章数计算
  3. 只认「第001章」前缀，认不出 ch-01.md / ch-1.md → 两种命名都支持
  4. 只扫 range(1,200)，199 章之后静默截断 → 改为扫描目录，无上限

另加一道保险：一个 .md 都没匹配上时直接报错，不再打印「所有章节字数均达标」的假通过。

用法（章号与目录顺序任意）：
  python count_chinese_words.py                       # 统计全部（自动找章节目录）
  python count_chinese_words.py <章号>                 # 统计单章
  python count_chinese_words.py <章节目录>              # 统计该目录全部
  python count_chinese_words.py <章号> <章节目录>
  NOVEL_CHAPTER_DIR=<目录> python count_chinese_words.py
章节目录解析优先级：命令行目录 → 环境变量 NOVEL_CHAPTER_DIR → ./4-正文 → ./chapters
"""

import os
import re
import sys

MIN_WORDS = 2300
MAX_WORDS = 4000

# 两种命名约定：『第001章标题.md』『ch-01.md』『chapter_1.md』
PATTERNS = [
    re.compile(r'^第\s*0*(\d+)\s*章'),
    re.compile(r'^(?:ch|chapter)[\s._-]*0*(\d+)', re.IGNORECASE),
]


def count_chinese_words(text):
    """统计中文字数（含中文标点）；排除空白、英文、数字与 markdown 标记。"""
    text = re.sub(r'\s+', '', text)
    text = re.sub(r'[a-zA-Z0-9]+', '', text)
    text = re.sub(r'[#*_`\[\]\(\)]+', '', text)
    return len(text)


def parse_chapter_num(filename):
    """从文件名解析章号；识别不了返回 None。"""
    name = filename[:-3] if filename.lower().endswith('.md') else filename
    for pattern in PATTERNS:
        m = pattern.match(name)
        if m:
            return int(m.group(1))
    return None


def resolve_chapter_dir(cli_dir=None):
    """解析章节目录：命令行 → 环境变量 → ./4-正文 → ./chapters。"""
    if cli_dir:
        return cli_dir
    env = os.getenv("NOVEL_CHAPTER_DIR")
    if env:
        return env
    for candidate in ("4-正文", "chapters"):
        path = os.path.join(os.getcwd(), candidate)
        if os.path.isdir(path):
            return path
    return os.path.join(os.getcwd(), "4-正文")


def scan_chapters(chapter_dir):
    """扫描目录，返回 (按章号排序的 [(章号, 文件名)], 未识别的 .md 文件名)。"""
    if not os.path.isdir(chapter_dir):
        print(f"❌ 章节目录不存在：{chapter_dir}")
        print("   用第 2 个参数或环境变量 NOVEL_CHAPTER_DIR 指定章节目录。")
        return None, []

    found = {}
    unrecognized = []
    for filename in sorted(os.listdir(chapter_dir)):
        if not filename.lower().endswith('.md'):
            continue
        path = os.path.join(chapter_dir, filename)
        if not os.path.isfile(path):
            continue
        num = parse_chapter_num(filename)
        if num is None:
            unrecognized.append(filename)
        elif num not in found:  # 同号取先出现的，避免 ch-01 与 ch-1 重复计数
            found[num] = filename

    return sorted(found.items()), unrecognized


def read_word_count(chapter_dir, filename):
    path = os.path.join(chapter_dir, filename)
    with open(path, 'r', encoding='utf-8') as f:
        return count_chinese_words(f.read())


def count_single_chapter(chapter_num, chapter_dir):
    """统计单个章节的字数。"""
    chapters, _ = scan_chapters(chapter_dir)
    if chapters is None:
        return None

    match = [f for n, f in chapters if n == chapter_num]
    if not match:
        print(f"❌ 错误：未找到第 {chapter_num} 章（已识别 {len(chapters)} 章）")
        return None

    words = read_word_count(chapter_dir, match[0])
    print(f"=== 第{chapter_num}章字数统计 ===")
    print(f"文件: {match[0]}")
    print(f"字数: {words} 字")
    print()

    if words < MIN_WORDS:
        print(f"⚠️  字数不足：还需 {MIN_WORDS - words} 字才能达到最低标准 ({MIN_WORDS}字)")
    elif words > MAX_WORDS:
        print(f"✅ 字数充足：超出建议上限 {words - MAX_WORDS} 字 (可接受)")
    else:
        print(f"✅ 字数达标：符合标准范围 ({MIN_WORDS}-{MAX_WORDS}字)")

    return words


def count_all_chapters(chapter_dir):
    """统计所有章节的字数。"""
    print("=== 章节字数统计报告 (中文字数 + 标点) ===")
    print(f"目录: {chapter_dir}")
    print()

    chapters, unrecognized = scan_chapters(chapter_dir)
    if chapters is None:
        return

    if not chapters:
        print("❌ 没有匹配到任何章节文件 —— 未做统计。")
        if unrecognized:
            print(f"   目录里有 {len(unrecognized)} 个 .md 但文件名不符合命名约定：")
            for name in unrecognized[:10]:
                print(f"     - {name}")
            if len(unrecognized) > 10:
                print(f"     ...（共 {len(unrecognized)} 个）")
        print("   支持的命名：『第001章标题.md』『ch-01.md』『chapter_1.md』")
        return

    total_words = 0
    chapter_stats = []
    for num, filename in chapters:
        words = read_word_count(chapter_dir, filename)
        total_words += words
        chapter_stats.append((num, words))
        print(f"第{num:4d}章: {words:6d} 字")

    n_ch = len(chapter_stats)
    print()
    print("=== 统计汇总 ===")
    print(f"总字数: {total_words:,} 字")
    print(f"平均字数: {total_words // n_ch:,} 字/章")
    print(f"章节数: {n_ch} 章")
    if unrecognized:
        print(f"⚠️  另有 {len(unrecognized)} 个 .md 未识别为章节，未计入统计")

    print()
    print("=== 字数分布 ===")
    ranges = [
        (0, 1500, "< 1500"),
        (1500, 2000, "1500-2000"),
        (2000, 2500, "2000-2500"),
        (2500, 3000, "2500-3000"),
        (3000, float('inf'), "> 3000"),
    ]
    for min_w, max_w, label in ranges:
        count = sum(1 for _, w in chapter_stats if min_w <= w < max_w)
        if count > 0:
            print(f"{label:12s} 字: {count:2d} 章 ({count * 100 // n_ch:2d}%)")

    print()
    print(f"=== 字数不足章节 (< {MIN_WORDS} 字) ===")
    insufficient = [(i, w) for i, w in chapter_stats if 0 < w < MIN_WORDS]
    if insufficient:
        for i, w in insufficient:
            print(f"⚠️  第{i:3d}章: {w:5d} 字 (不足 {MIN_WORDS - w} 字)")
    else:
        print("✅ 所有章节字数均达标")

    print()
    print("=== 极值统计 ===")
    valid_stats = [(i, w) for i, w in chapter_stats if w > 0]
    if valid_stats:
        min_chapter = min(valid_stats, key=lambda x: x[1])
        max_chapter = max(valid_stats, key=lambda x: x[1])
        print(f"最短章节: 第{min_chapter[0]}章 ({min_chapter[1]} 字)")
        print(f"最长章节: 第{max_chapter[0]}章 ({max_chapter[1]} 字)")


def main():
    args = sys.argv[1:]
    chapter_num = None
    cli_dir = None

    for arg in args:
        if os.path.isdir(arg):
            cli_dir = arg
            continue
        try:
            chapter_num = int(arg)
        except ValueError:
            print(f"❌ 目录不存在：{arg}")
            print("用法：")
            print("  单章统计: python count_chinese_words.py 42 [章节目录]")
            print("  全部统计: python count_chinese_words.py [章节目录]")
            return

    chapter_dir = resolve_chapter_dir(cli_dir)
    if chapter_num is None:
        count_all_chapters(chapter_dir)
    else:
        count_single_chapter(chapter_num, chapter_dir)


if __name__ == "__main__":
    main()
