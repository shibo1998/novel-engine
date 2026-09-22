#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""把出图结果压成番茄要求的书封文件：600×800、jpg/png、≤5MB。

用法:
  python3 make_cover.py covers/原图.png --out "covers/书名-封面.jpg"
  python3 make_cover.py covers/原图.png --size 600x800 --format png

优先用 Pillow；没装 Pillow 时在 macOS 上回退到系统自带的 sips。
两者都不可用时会打印手动处理方式并以非零码退出。
"""

import argparse
import shutil
import subprocess
import sys
from pathlib import Path

MAX_BYTES = 5 * 1024 * 1024


def parse_size(text):
    w, _, h = text.lower().partition('x')
    return int(w), int(h)


def with_pillow(src, dst, size, fmt):
    from PIL import Image

    im = Image.open(src)
    im = im.convert('RGB' if fmt == 'jpg' else 'RGBA')

    target_w, target_h = size
    src_w, src_h = im.size
    # 先按目标比例居中裁剪，再缩放，避免拉伸变形
    if src_w * target_h != src_h * target_w:
        if src_w * target_h > src_h * target_w:
            new_w = round(src_h * target_w / target_h)
            left = (src_w - new_w) // 2
            im = im.crop((left, 0, left + new_w, src_h))
        else:
            new_h = round(src_w * target_h / target_w)
            top = (src_h - new_h) // 2
            im = im.crop((0, top, src_w, top + new_h))
    im = im.resize(size, Image.LANCZOS)

    if fmt == 'jpg':
        for quality in (92, 85, 78, 70, 60):
            im.save(dst, 'JPEG', quality=quality, optimize=True, subsampling=0)
            if dst.stat().st_size <= MAX_BYTES:
                return f'Pillow，JPEG 质量 {quality}'
        return 'Pillow，JPEG 质量 60'
    im.save(dst, 'PNG', optimize=True)
    return 'Pillow，PNG'


def with_sips(src, dst, size, fmt):
    target_w, target_h = size
    cmd = ['sips', '-s', 'format', 'jpeg' if fmt == 'jpg' else 'png',
           '-z', str(target_h), str(target_w), str(src), '--out', str(dst)]
    subprocess.run(cmd, check=True, capture_output=True)
    return 'sips（macOS 系统自带）'


def main():
    ap = argparse.ArgumentParser(description='生成番茄规格的书封文件')
    ap.add_argument('source', help='出图得到的原图')
    ap.add_argument('--out', required=True, help='输出文件路径')
    ap.add_argument('--size', default='600x800', help='目标尺寸，默认 600x800')
    ap.add_argument('--format', choices=['jpg', 'png'], default='jpg')
    args = ap.parse_args()

    src = Path(args.source)
    if not src.exists():
        print(f'找不到原图：{src}', file=sys.stderr)
        sys.exit(1)
    dst = Path(args.out)
    dst.parent.mkdir(parents=True, exist_ok=True)
    size = parse_size(args.size)

    try:
        how = with_pillow(src, dst, size, args.format)
    except ImportError:
        if not shutil.which('sips'):
            print('没有 Pillow，也没有 sips。请先 pip install Pillow，'
                  '或用任意图片工具把原图导出为 600×800 的 jpg（≤5MB）。', file=sys.stderr)
            sys.exit(1)
        how = with_sips(src, dst, size, args.format)

    mb = dst.stat().st_size / 1024 / 1024
    print(f'已生成 {dst}（{size[0]}×{size[1]}，{mb:.2f} MB，{how}）')
    if dst.stat().st_size > MAX_BYTES:
        print('文件仍超过 5MB，请降低质量或改用 jpg 格式重试', file=sys.stderr)
        sys.exit(1)


if __name__ == '__main__':
    main()
