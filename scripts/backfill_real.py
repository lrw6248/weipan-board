#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
用东方财富免费「历史估值明细」报表回填【真实】微盘 PB 序列。

这是真实历史截面数据，不是近似 / 推算序列：
  - 每一天都按【当天】全市场真实总市值重新排序，选出最小的 400 只；
  - 用这 400 只【当天】的真实市净率 PB_MRQ 做等权调和平均；
  - 每天都重新选成分股，不是固定用当前成分股、也不是用股价比例外推。

数据源：https://data.eastmoney.com/  报表 RPT_VALUEANALYSIS_DET
  免费、无需注册、无需 token、无需积分、无调用次数限制。
  覆盖 2018-01-02 至今全部交易日（实测 2148 天，超过笔记要求的 1800 日）。

产出：history_real.csv  列 = date,pb,avg_mv,median_mv,n_valid
  pb        微盘 PB（最小 400 只等权调和平均）
  avg_mv    这 400 只的平均总市值（亿元）
  median_mv 这 400 只的市值中位数（亿元）
  n_valid   当日清洗后有效股票数（用于核对）

用法：
  python backfill_real.py                 # 增量回填（跳过已完成的日期）
  python backfill_real.py --force        # 全量重算
  python backfill_real.py --start 20190101
  python backfill_real.py --workers 8
"""
import argparse
import csv
import json
import random
import sys
import time
from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import datetime
from pathlib import Path

import requests

ROOT = Path(__file__).resolve().parent.parent
DATA = ROOT / "data"
BASE = DATA  # 所有数据读写统一落在 data/
API = "https://datacenter-web.eastmoney.com/api/data/v1/get"
REPORT = "RPT_VALUEANALYSIS_DET"
COLS = "SECURITY_CODE,SECURITY_NAME_ABBR,PB_MRQ,TOTAL_MARKET_CAP,TRADE_DATE"
OUT = BASE / "history_real.csv"
DAYS_CACHE = BASE / ".trade_days.json"

HEADERS = {
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
                  "(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
    "Referer": "https://data.eastmoney.com/",
}
TOPN = 400          # 微盘 = 市值最小的 400 只
FETCH = 1500        # 按市值升序多取一些，保证过滤 ST/北交所后仍够 400 只


def log(msg):
    print(f"[{datetime.now().strftime('%H:%M:%S')}] {msg}", flush=True)


def _get(params, timeout=25):
    return requests.get(API, params=params, timeout=timeout, headers=HEADERS)


def get_trade_days(force=False):
    """取全市场真实交易日历。

    每次运行都实时查一次东财（单次请求，约 0.2 秒），保证能自动发现新交易日；
    缓存仅在实时查询失败时兜底，避免日历停留在旧日期导致增量补齐失效。
    """
    p = {
        "reportName": REPORT, "columns": "TRADE_DATE",
        "pageNumber": 1, "pageSize": 6000,
        "filter": '(SECURITY_CODE="000001")',
        "sortColumns": "TRADE_DATE", "sortTypes": "-1",
    }
    for i in range(2):
        try:
            r = _get(p, timeout=30)
            res = r.json().get("result") or {}
            days = sorted({x["TRADE_DATE"][:10] for x in (res.get("data") or [])})
            if days and len(days) > 100:
                DAYS_CACHE.write_text(json.dumps(days), encoding="utf-8")
                log(f"交易日历（东财实时）：{len(days)} 天，{days[0]} ~ {days[-1]}")
                return days
        except Exception as e:
            log(f"取交易日历重试 {i+1}: {e}")
            time.sleep(1.5)
    if DAYS_CACHE.exists():
        try:
            days = json.loads(DAYS_CACHE.read_text(encoding="utf-8"))
            if len(days) > 100:
                log(f"交易日历（本地缓存兜底）：{len(days)} 天，{days[0]} ~ {days[-1]}")
                return days
        except Exception:
            pass
    log("错误：无法获取交易日历")
    sys.exit(1)


def fetch_day(day):
    """取某一交易日按总市值升序的前 FETCH 只，返回当日真实微盘指标。"""
    p = {
        "reportName": REPORT, "columns": COLS,
        "pageNumber": 1, "pageSize": FETCH,
        "filter": f"(TRADE_DATE='{day}')",
        "sortColumns": "TOTAL_MARKET_CAP", "sortTypes": "1",
    }
    for attempt in range(4):
        try:
            time.sleep(random.uniform(0.02, 0.09))
            r = _get(p)
            res = r.json().get("result") or {}
            rows = res.get("data") or []
            if not rows:
                return None
            clean = []
            for x in rows:
                code = x.get("SECURITY_CODE") or ""
                name = x.get("SECURITY_NAME_ABBR") or ""
                # 剔除北交所(4/8/920/bj)、ST、退市
                if code.startswith(("4", "8", "920", "bj")):
                    continue
                if "ST" in name.upper() or "退" in name:
                    continue
                try:
                    pb = float(x.get("PB_MRQ") or 0)
                    mc = float(x.get("TOTAL_MARKET_CAP") or 0)
                except (TypeError, ValueError):
                    continue
                if 0.01 < pb < 100 and mc > 0:
                    clean.append((pb, mc))
            clean.sort(key=lambda y: y[1])
            if len(clean) < TOPN:
                return None
            top = clean[:TOPN]
            pb = TOPN / sum(1.0 / y[0] for y in top)
            avg_mv = sum(y[1] for y in top) / TOPN / 1e8
            med_mv = top[TOPN // 2][1] / 1e8
            return {
                "date": day, "pb": round(pb, 4),
                "avg_mv": round(avg_mv, 2), "median_mv": round(med_mv, 2),
                "n_valid": len(clean),
            }
        except Exception:
            time.sleep(0.4 * (attempt + 1))
    return None


def load_done():
    done = {}
    if OUT.exists():
        with OUT.open(encoding="utf-8") as f:
            for row in csv.DictReader(f):
                try:
                    done[row["date"]] = row
                except Exception:
                    pass
    return done


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--force", action="store_true", help="全量重算，忽略已有结果")
    ap.add_argument("--start", default="", help="起始日期 YYYYMMDD，如 20190101")
    ap.add_argument("--workers", type=int, default=7, help="并发线程数（默认 7，过大易被限流）")
    args = ap.parse_args()

    days = get_trade_days(force=args.force)
    if args.start:
        s = f"{args.start[:4]}-{args.start[4:6]}-{args.start[6:8]}"
        days = [d for d in days if d >= s]

    done = {} if args.force else load_done()
    todo = [d for d in days if d not in done]
    log(f"需处理 {len(todo)} 天（已完成 {len(days)-len(todo)} 天）")

    if not todo:
        log("已是最新，无需更新")
        return

    results = {}
    failed = []
    t0 = time.time()
    with ThreadPoolExecutor(max_workers=args.workers) as ex:
        futs = {ex.submit(fetch_day, d): d for d in todo}
        for i, fut in enumerate(as_completed(futs), 1):
            d = futs[fut]
            try:
                r = fut.result()
            except Exception as e:
                r = None
                log(f"{d} 异常 {e}")
            if r:
                results[d] = r
            else:
                failed.append(d)
            if i % 100 == 0 or i == len(todo):
                el = time.time() - t0
                log(f"进度 {i}/{len(todo)}  成功 {len(results)}  失败 {len(failed)}  "
                    f"用时 {el:.0f}s  预计剩余 {el/i*(len(todo)-i):.0f}s")

    # 失败的重试一轮（降低并发）
    if failed:
        log(f"重试失败的 {len(failed)} 天...")
        with ThreadPoolExecutor(max_workers=2) as ex:
            futs = {ex.submit(fetch_day, d): d for d in failed}
            for fut in as_completed(futs):
                d = futs[fut]
                try:
                    r = fut.result()
                    if r:
                        results[d] = r
                except Exception:
                    pass

    merged = {**done, **results} if not args.force else results
    rows = [merged[d] for d in sorted(merged) if d in merged]
    with OUT.open("w", newline="", encoding="utf-8") as f:
        w = csv.DictWriter(f, fieldnames=["date", "pb", "avg_mv", "median_mv", "n_valid"])
        w.writeheader()
        w.writerows(rows)

    log(f"完成：写出 {len(rows)} 天真实数据 -> {OUT.name}")
    if rows:
        log(f"区间：{rows[0]['date']} ~ {rows[-1]['date']}")
        log(f"最新一天 PB={rows[-1]['pb']}  平均市值={rows[-1]['avg_mv']} 亿")
    still = [d for d in todo if d not in results]
    if still:
        log(f"仍有 {len(still)} 天失败（多为该日无数据），可重跑脚本自动补齐：{still[:8]}")
    # 真实 25% 分位（近 1800 个交易日）
    vals = sorted(float(r["pb"]) for r in rows[-1800:])
    if vals:
        k = (len(vals) - 1) * 0.25
        lo, hi = int(k), min(int(k) + 1, len(vals) - 1)
        q = vals[lo] + (vals[hi] - vals[lo]) * (k - lo)
        log(f"真实近 {len(vals)} 日 25% 分位 = {q:.4f}")


if __name__ == "__main__":
    main()
