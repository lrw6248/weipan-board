#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""一次性回填：微盘扩散指数最近一年历史 + 市值中位数历史。

扩散指数 = 400 只成分股中收盘价站上 20 日均线的比例。
口径说明：成分股取「当前时点市值最小的 400 只」，向历史回溯；
          真实历史上成分每日变动，故曲线为近似值，仅供观察位置。
运行：python3 backfill_extra.py
输出：extra_hist.json / extra_hist.js（页面读取）
"""
import json
import re
import sys
import time
import concurrent.futures
from pathlib import Path

import requests

sys.path.insert(0, str(Path(__file__).parent))
import update_data as U  # noqa: E402

ROOT = Path(__file__).resolve().parent.parent
DATA = ROOT / "data"
BASE = DATA  # 所有数据读写统一落在 data/
KLINE_URL = U.KLINE_URL
KLINE_H = U.KLINE_H
DAYS = 340          # 约一年 + 20 日均线预热
KEEP = 260          # 最终保留的交易日数


def one(x):
    for _ in range(3):
        try:
            r = requests.get(KLINE_URL, params={
                "symbol": x["symbol"], "scale": 240, "ma": 20, "datalen": DAYS
            }, timeout=15, headers=KLINE_H)
            m = re.search(r"var _\((\[.*?\])\)", r.text, re.S)
            if not m:
                continue
            arr = json.loads(m.group(1))
            out = []
            for k in arr:
                try:
                    c = float(k["close"]); ma = float(k.get("ma_price20") or 0)
                except (KeyError, TypeError, ValueError):
                    continue
                if ma > 0:
                    out.append((k["day"], c, ma))
            return out
        except Exception:
            time.sleep(0.4)
    return []


def main():
    U.log("拉取全市场快照，确定当前最小 400 只…")
    clean = U.fetch_market()
    micro = U.calc_micro(clean)
    stocks = micro["stocks"]
    U.log(f"成分股 {len(stocks)} 只，开始并发拉取日 K（约 1–2 分钟）")

    agg = {}          # day -> [above, total]
    done = 0
    with concurrent.futures.ThreadPoolExecutor(max_workers=12) as ex:
        for rows in ex.map(one, stocks):
            done += 1
            if done % 50 == 0:
                U.log(f"  已处理 {done}/{len(stocks)}")
            for day, c, ma in rows:
                a = agg.setdefault(day, [0, 0])
                a[1] += 1
                if c > ma:
                    a[0] += 1

    days = sorted(agg.keys())
    diff = [[d, round(agg[d][0] / agg[d][1] * 100, 1)] for d in days if agg[d][1] >= 200][-KEEP:]
    U.log(f"扩散指数聚合完成：{len(diff)} 个交易日（{diff[0][0]} → {diff[-1][0]}），"
          f"今日 {diff[-1][1]}%（{agg[diff[-1][0]][0]}/{agg[diff[-1][0]][1]}）")

    # 保留已有成交额，补中位数历史
    jp = BASE / "extra_hist.json"
    obj = {"meta": {}, "diff": [], "amount": [], "median": []}
    if jp.exists():
        try:
            obj = json.loads(jp.read_text(encoding="utf-8"))
        except Exception:
            pass
    obj["diff"] = diff

    rows = (BASE / "history_real.csv").read_text(encoding="utf-8").splitlines()
    med, avg = [], []
    for line in rows[1:]:
        c = line.split(",")
        if len(c) >= 4:
            try:
                m = float(c[3]); a = float(c[2])
            except ValueError:
                continue
            if m > 0:
                med.append([c[0], round(m, 2)])
            if a > 0:
                avg.append([c[0], round(a, 2)])
    if not obj.get("median"):
        obj["median"] = med
        U.log(f"市值中位数历史：{len(med)} 天（{med[0][0]} → {med[-1][0]}）")
    obj["avg"] = avg
    U.log(f"平均市值历史：{len(avg)} 天（{avg[0][0]} → {avg[-1][0]}）")

    if not obj.get("amount"):
        amt = micro.get("amount")
        obj["amount"] = [[diff[-1][0], round(amt, 1)]] if amt else []

    obj["meta"] = {
        "diff_from": diff[0][0], "diff_to": diff[-1][0],
        "diff_note": "按当前 400 只成分股回溯，成分变动存在轻微偏差",
        "amount_from": obj["amount"][0][0] if obj["amount"] else "",
        "updated": U.datetime.now().strftime("%Y-%m-%d %H:%M"),
    }
    jp.write_text(json.dumps(obj, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
    (BASE / "extra_hist.js").write_text(
        "window.EXTRA_HIST = " + json.dumps(obj, ensure_ascii=False, separators=(",", ":")) + ";\n",
        encoding="utf-8")
    U.log("已写出 extra_hist.json / extra_hist.js")


if __name__ == "__main__":
    main()
