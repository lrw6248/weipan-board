#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""回填微盘成交额历史（约近 5 年，1200 个交易日）。

口径：当前市值最小的 400 只（与每日 update_data 的成分一致），逐个拉日 K，
      用「成交量 × 当日均价」近似当日成交额，再按日加总。
      均价取 (最高 + 最低 + 收盘) / 3，与真实成交额通常相差 1–5%。
      成分股每日实际会变动，历史回溯用当前成分，属近似口径。

运行：python3 backfill_amount.py
输出：写回 extra_hist.json / extra_hist.js 的 amount 字段
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
DAYS = 1200          # 新浪接口单次上限附近，约 5 年
MIN_VALID = 300      # 当日有数据的成分股少于这个数，视为样本不足


def one(x):
    for _ in range(3):
        try:
            r = requests.get(KLINE_URL, params={
                "symbol": x["symbol"], "scale": 240, "ma": "no", "datalen": DAYS
            }, timeout=25, headers=KLINE_H)
            m = re.search(r"var _\((\[.*?\])\)", r.text, re.S)
            if not m:
                continue
            arr = json.loads(m.group(1))
            out = []
            for k in arr:
                try:
                    c = float(k["close"]); h = float(k["high"]); l = float(k["low"])
                    v = float(k["volume"])
                except (KeyError, TypeError, ValueError):
                    continue
                if c <= 0 or v <= 0:
                    continue
                avg = (h + l + c) / 3 if h > 0 and l > 0 else c
                out.append((k["day"], v * avg))
            return out
        except Exception:
            time.sleep(0.5)
    return []


def main():
    U.log("拉取全市场快照，确定当前最小 400 只…")
    clean = U.fetch_market()
    micro = U.calc_micro(clean)
    stocks = micro["stocks"]
    U.log(f"成分股 {len(stocks)} 只，开始并发拉取日 K（{DAYS} 天，约 1–2 分钟）")

    amt = {}
    cnt = {}
    done = 0
    with concurrent.futures.ThreadPoolExecutor(max_workers=12) as ex:
        for rows in ex.map(one, stocks):
            done += 1
            if done % 50 == 0:
                U.log(f"  已处理 {done}/{len(stocks)}")
            for day, a in rows:
                amt[day] = amt.get(day, 0.0) + a
                cnt[day] = cnt.get(day, 0) + 1

    # 以主数据的交易日为截止，避免把盘中半天数据算进来
    cutoff = ""
    try:
        cutoff = json.loads((BASE / "data.json").read_text(encoding="utf-8")).get("date", "")
    except Exception:
        pass

    days = sorted(d for d in amt if cnt[d] >= MIN_VALID and (not cutoff or d <= cutoff))
    if not days:
        U.log("未取到可用成交额数据")
        return
    series = [[d, round(amt[d] / 1e8, 1)] for d in days]
    U.log(f"成交额聚合完成：{len(series)} 个交易日（{series[0][0]} → {series[-1][0]}），"
          f"最新 {series[-1][1]} 亿（有效成分 {cnt[series[-1][0]]} 只）")

    jp = BASE / "extra_hist.json"
    obj = json.loads(jp.read_text(encoding="utf-8")) if jp.exists() else {"meta": {}, "diff": [], "amount": []}
    old_last = obj.get("amount")[-1] if obj.get("amount") else None
    # 回填序列覆盖早期，保留原先更晚的单点（若有）
    merged = {d: v for d, v in series}
    for d, v in (obj.get("amount") or []):
        if d > series[-1][0]:
            merged[d] = v
    obj["amount"] = [[d, merged[d]] for d in sorted(merged)]
    obj.setdefault("meta", {})
    obj["meta"].update({
        "amount_from": obj["amount"][0][0],
        "amount_to": obj["amount"][-1][0],
        "amount_note": "按当前 400 只成分回溯，成交额 = 成交量 × 当日均价，为近似口径",
        "updated": U.datetime.now().strftime("%Y-%m-%d %H:%M"),
    })
    jp.write_text(json.dumps(obj, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
    (BASE / "extra_hist.js").write_text(
        "window.EXTRA_HIST = " + json.dumps(obj, ensure_ascii=False, separators=(",", ":")) + ";",
        encoding="utf-8")
    U.log(f"已写回 extra_hist.json / extra_hist.js：成交额 {len(obj['amount'])} 天")
    if old_last:
        U.log(f"原最后一条 {old_last}")


if __name__ == "__main__":
    main()
