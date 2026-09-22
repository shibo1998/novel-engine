#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""计算「热梗周报」的活跃观察期时间窗（GMT+8 / Asia/Shanghai）。

本 skill 的时间窗是「活跃观察期」——用来组织检索与标题，不是梗的「首发时间过滤器」。
默认给本周一 00:00 ~ 本周日 22:00；可按需拉长。

用法:
    python week_window.py                                   # 默认：本周窗口
    python week_window.py YYYY-MM-DD                        # 以指定日期所在周为准
    python week_window.py --weeks 4                         # 拉长到最近 4 周（含本周）
    python week_window.py --start YYYY-MM-DD --end YYYY-MM-DD   # 任意起止
    python week_window.py --month                           # 输出当前年月（检索词用，如「2026年8月」）

输出时间窗起止、ISO 区间，以及（若指定了 end 且在未来）距截止的剩余时间。
注意：不要把此窗口当作「梗必须本周首发」的硬约束；首发早但评论区 NOW 仍在玩的活梗也应纳入。
"""
import sys

# 跨平台兜底：Windows 控制台默认 GBK 编码，中文 print 可能报 UnicodeEncodeError。
# 强制 UTF-8 输出（Python 3.7+ 支持 reconfigure；旧版本无此属性则跳过）。
if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8")
    sys.stderr.reconfigure(encoding="utf-8")

from datetime import datetime, timedelta, date

try:
    from zoneinfo import ZoneInfo
    TZ = ZoneInfo("Asia/Shanghai")
except Exception:
    TZ = None  # 退回无时区模式（本地时间假定为 GMT+8）


def week_window(ref: date):
    # Python 中 Monday 的 weekday() == 0
    monday = ref - timedelta(days=ref.weekday())
    start = datetime(monday.year, monday.month, monday.day, 0, 0, 0, tzinfo=TZ)
    sunday = monday + timedelta(days=6)
    end = datetime(sunday.year, sunday.month, sunday.day, 22, 0, 0, tzinfo=TZ)
    return start, end


def _label(dt: datetime) -> str:
    if TZ is not None:
        return dt.strftime("%Y-%m-%d %H:%M %Z (%A)")
    return dt.strftime("%Y-%m-%d %H:%M (本地时间，假定 GMT+8) (%A)")


def _parse_date(s: str) -> date:
    try:
        return date.fromisoformat(s)
    except ValueError:
        print(f"日期格式错误: {s}（应为 YYYY-MM-DD）")
        sys.exit(2)


def main():
    args = sys.argv[1:]

    # 模式 0：输出当前年月（供检索词动态使用，避免写死年月）
    if "--month" in args:
        now = datetime.now(TZ) if TZ else datetime.now()
        print(f"{now.year}年{now.month}月")
        return

    # 模式 A：任意起止
    if "--start" in args or "--end" in args:
        start_s = end_s = None
        if "--start" in args:
            start_s = args[args.index("--start") + 1]
        if "--end" in args:
            end_s = args[args.index("--end") + 1]
        if not start_s or not end_s:
            print("错误：--start 与 --end 必须同时提供（YYYY-MM-DD）")
            sys.exit(2)
        start_d = _parse_date(start_s)
        end_d = _parse_date(end_s)
        start = datetime(start_d.year, start_d.month, start_d.day, 0, 0, 0, tzinfo=TZ)
        end = datetime(end_d.year, end_d.month, end_d.day, 23, 59, 59, tzinfo=TZ)
        print(f"模式: 自定义起止（活跃观察期）")
        print(f"起始: {_label(start)}")
        print(f"结束: {_label(end)}")
        print(f"时间窗: {start.isoformat()}  ~  {end.isoformat()}")
        print("提示: 此窗口仅用于组织检索/标题；首发早但评论区 NOW 仍在玩的活梗也应纳入。")
        return

    # 模式 B：最近 N 周
    if "--weeks" in args:
        n = int(args[args.index("--weeks") + 1])
        ref = datetime.now(TZ).date() if TZ else date.today()
        monday_this = ref - timedelta(days=ref.weekday())
        start_d = monday_this - timedelta(weeks=n - 1)
        start = datetime(start_d.year, start_d.month, start_d.day, 0, 0, 0, tzinfo=TZ)
        sunday_this = monday_this + timedelta(days=6)
        end = datetime(sunday_this.year, sunday_this.month, sunday_this.day, 22, 0, 0, tzinfo=TZ)
        print(f"模式: 最近 {n} 周（活跃观察期）")
        print(f"起始({(n-1)}周前周一): {_label(start)}")
        print(f"结束(本周日22点): {_label(end)}")
        print(f"时间窗: {start.isoformat()}  ~  {end.isoformat()}")
        return

    # 模式 C：指定某周 / 默认本周
    if args:
        ref = _parse_date(args[0])
    else:
        ref = datetime.now(TZ).date() if TZ else date.today()

    start, end = week_window(ref)
    now = datetime.now(TZ) if TZ else datetime.now()
    print(f"模式: 单周窗口（默认/指定周）")
    print(f"本周一: {_label(start)}")
    print(f"本周日: {_label(end)}")
    print(f"时间窗: {start.isoformat()}  ~  {end.isoformat()}")
    print(f"当前年月（检索用）: {now.year}年{now.month}月")

    if now < end:
        remain = end - now
        days = remain.days
        hours = remain.seconds // 3600
        minutes = (remain.seconds % 3600) // 60
        print(f"距截止(本周日22点)还剩: {days}天{hours}小时{minutes}分")
        print("提示: 时间窗未关闭，实际可覆盖『当前时刻』；同时允许纳入窗口外但评论区仍在玩的活梗。")
    else:
        print("提示: 当前已晚于本周日22点，时间窗已关闭；如需上一周数据请改用上周任一日期。")


if __name__ == "__main__":
    main()
