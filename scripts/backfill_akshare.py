#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
用 akshare 获取「微盘 PB」的真实历史序列（免费、无需注册、无需 Token）。

数据来源：akshare 官方接口 stock_value_em 所封装的东方财富「估值分析」报表
          RPT_VALUEANALYSIS_DET，字段 PB_MRQ（真实市净率）与
          TOTAL_MARKET_CAP（真实总市值）。本脚本与 akshare 使用完全相同的
          报表、字段与清洗口径，只是把过滤维度从「单只股票的全部历史」
          换成「某个交易日的全市场截面」。

为什么必须按交易日取截面：
  微盘 PB 要求每一天都按【当天】真实总市值重新排序，选出最小的 400 只，
  再用这 400 只【当天】的真实 PB 做等权调和平均。akshare 的
  stock_value_em(symbol) 是「一只股票 × 全历史」维度，纯靠它拼截面需要
  遍历约 5400 只股票、每只一次请求；按交易日取只需 1 次请求 / 天。

用法：
  python backfill_akshare.py                    # 增量补齐到最新交易日
  python backfill_akshare.py --force            # 全量重算（约 90 秒 / 2148 天）
  python backfill_akshare.py --start 20240101   # 只回填该日期之后
  python backfill_akshare.py --check            # 抽样 8 天，只校验不写文件
  python backfill_akshare.py --output my.csv    # 指定输出文件

输出：与 history_real.csv 同格式的 CSV
  date,pb,avg_mv,median_mv,n_valid
  pb       —— 当日最小 400 只的等权调和平均 PB（真实截面重算）
  avg_mv   —— 这 400 只的平均总市值（亿元）
  median_mv—— 这 400 只的总市值中位数（亿元）
  n_valid  —— 当日清洗后的有效股票数（用于自检，正常应 > 400）
"""
import argparse
import concurrent.futures
import csv
import sys
import time
from datetime import date, datetime
from pathlib import Path

import akshare as ak
from akshare.request import make_request_with_retry_json

ROOT = Path(__file__).resolve().parent.parent
DATA = ROOT / "data"
BASE = DATA  # 所有数据读写统一落在 data/
API = "https://datacenter-web.eastmoney.com/api/data/v1/get"
REPORT = "RPT_VALUEANALYSIS_DET"
HEADERS = {
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
                  "(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
    "Referer": "https://data.eastmoney.com/",
}
PAGE_SIZE = 1500      # 按总市值升序取前 1500 只，过滤后足以覆盖最小 400 只
TOP_N = 400           # 微盘定义：最小市值 400 只
FIELDS = ["date", "pb", "avg_mv", "median_mv", "n_valid"]


def log(msg):
    print(f"[{datetime.now().strftime('%H:%M:%S')}] {msg}", flush=True)


def get_trade_days():
    """用 akshare 取真实交易日历（与东财报表同源同口径）。

    优先用官方接口 stock_value_em("000001")：平安银行 2018 年至今每个交易日
    都有估值记录，其日期列即报表的真实交易日序列。若本地 akshare 版本较旧、
    没有该接口，则退化为用 akshare 请求层直接访问同一报表取日期列。
    """
    if hasattr(ak, "stock_value_em"):
        df = ak.stock_value_em(symbol="000001")
        days = [str(x) for x in df["数据日期"].tolist()]
        src = "akshare stock_value_em"
    else:
        params = {
            "reportName": REPORT, "columns": "TRADE_DATE",
            "pageNumber": "1", "pageSize": "5000",
            "filter": '(SECURITY_CODE="000001")',
            "sortColumns": "TRADE_DATE", "sortTypes": "1",
            "source": "WEB", "client": "WEB",
        }
        data = make_request_with_retry_json(
            API, params=params, headers=HEADERS, max_retries=3, retry_delay=1
        )
        rows = (data.get("result") or {}).get("data") or []
        days = sorted({str(x["TRADE_DATE"])[:10] for x in rows})
        src = "akshare 请求层（兼容旧版）"
    if not days:
        raise RuntimeError("未能取得交易日历，请检查网络或升级 akshare")
    log(f"{src} 取得真实交易日 {len(days)} 天：{days[0]} ~ {days[-1]}")
    return days


def fetch_section(day):
    """按交易日拉取东财全市场真实收盘截面（按总市值升序）。"""
    params = {
        "reportName": REPORT,
        "columns": "ALL",
        "pageNumber": "1",
        "pageSize": str(PAGE_SIZE),
        "filter": f"(TRADE_DATE='{day}')",
        "sortColumns": "TOTAL_MARKET_CAP",
        "sortTypes": "1",
        "source": "WEB",
        "client": "WEB",
    }
    data = make_request_with_retry_json(
        API, params=params, headers=HEADERS, max_retries=3, retry_delay=1
    )
    res = data.get("result") or {}
    return res.get("data") or []


def calc_day(day):
    """用当日真实 PB + 真实总市值，重选最小 400 只并计算调和平均 PB。"""
    rows = fetch_section(day)
    clean = []
    for x in rows:
        code = str(x.get("SECURITY_CODE") or "")
        name = str(x.get("SECURITY_NAME_ABBR") or "")
        # 剔除北交所 / ST / 退市 / PB 异常（与 update_data.py 口径一致）
        if code.startswith(("4", "8", "920", "bj")):
            continue
        if "ST" in name.upper() or "退" in name:
            continue
        try:
            pb = float(x.get("PB_MRQ") or 0)
            mv = float(x.get("TOTAL_MARKET_CAP") or 0)
        except (TypeError, ValueError):
            continue
        if 0.01 < pb < 100 and mv > 0:
            clean.append((pb, mv))
    clean.sort(key=lambda z: z[1])
    if len(clean) < TOP_N:
        raise ValueError(f"{day} 有效股票仅 {len(clean)} 只，不足 {TOP_N} 只")
    top = clean[:TOP_N]
    pb = TOP_N / sum(1 / z[0] for z in top)
    mvs = sorted(z[1] / 1e8 for z in top)
    return {
        "date": day,
        "pb": round(pb, 4),
        "avg_mv": round(sum(mvs) / TOP_N, 2),
        "median_mv": round(mvs[TOP_N // 2], 2),
        "n_valid": len(clean),
    }


def read_existing(path):
    if not path.exists():
        return {}
    out = {}
    with path.open(encoding="utf-8", newline="") as f:
        for r in csv.DictReader(f):
            out[r["date"]] = r
    return out


def write_csv(path, rows):
    rows.sort(key=lambda r: r["date"])
    tmp = path.with_suffix(path.suffix + ".tmp")
    with tmp.open("w", encoding="utf-8", newline="") as f:
        w = csv.DictWriter(f, fieldnames=FIELDS)
        w.writeheader()
        w.writerows(rows)
    tmp.replace(path)


def main():
    ap = argparse.ArgumentParser(description="用 akshare 回填真实微盘 PB 历史序列")
    ap.add_argument("--force", action="store_true", help="全量重算，忽略已有结果")
    ap.add_argument("--start", default="", help="起始日期 YYYYMMDD，如 20240101")
    ap.add_argument("--workers", type=int, default=7, help="并发线程数（默认 7）")
    ap.add_argument("--output", default="history_real.csv", help="输出 CSV 文件名")
    ap.add_argument("--check", action="store_true", help="抽样 8 天校验，不写文件")
    args = ap.parse_args()

    out_path = BASE / args.output
    days = get_trade_days()
    if args.start:
        s = f"{args.start[:4]}-{args.start[4:6]}-{args.start[6:8]}"
        days = [d for d in days if d >= s]

    if args.check:
        # 抽样校验：与现有真实序列逐点比对，证明两条实现完全等价
        existing = read_existing(BASE / "history_real.csv")
        samples = [days[0], days[len(days) // 7], days[len(days) // 4],
                   days[len(days) // 2], days[-len(days) // 5],
                   days[-50], days[-2], days[-1]]
        log("抽样校验（akshare 版 vs 现有 history_real.csv）：")
        ok, extra = True, 0
        for d in samples:
            r = calc_day(d)
            ref = existing.get(d, {}).get("pb")
            if ref is None:
                extra += 1
                log(f"  {d}  pb={r['pb']}  现有序列尚无此日（新增真实交易日）"
                    f"  有效={r['n_valid']}只")
                continue
            same = str(ref) == str(r["pb"])
            ok &= same
            log(f"  {d}  pb={r['pb']}  现有={ref}  {'一致' if same else '不一致'}"
                f"  有效={r['n_valid']}只")
        log("结论：" + ("重叠日期全部一致，akshare 版可完全替代" if ok else "存在偏差，请检查口径")
            + (f"；另有 {extra} 天为新增真实交易日" if extra else ""))
        return 0 if ok else 1

    existing = {} if args.force else read_existing(out_path)
    todo = [d for d in days if d not in existing]
    log(f"待计算 {len(todo)} 天（已有 {len(existing)} 天）")
    if not todo:
        log("已是最新，无需更新。用 --force 可全量重算。")
        return 0

    t0 = time.time()
    results, failed = [], []
    with concurrent.futures.ThreadPoolExecutor(max_workers=args.workers) as ex:
        futs = {ex.submit(calc_day, d): d for d in todo}
        for i, fut in enumerate(concurrent.futures.as_completed(futs), 1):
            d = futs[fut]
            try:
                results.append(fut.result())
            except Exception as e:
                failed.append((d, str(e)[:100]))
            if i % 200 == 0:
                log(f"  进度 {i}/{len(todo)}，成功 {len(results)}，失败 {len(failed)}，"
                    f"耗时 {time.time()-t0:.0f}s")

    merged = {**existing, **{r["date"]: r for r in results}}
    write_csv(out_path, list(merged.values()))
    log(f"完成：新增 {len(results)} 天，失败 {len(failed)} 天，"
        f"总 {len(merged)} 天，耗时 {time.time()-t0:.0f}s → {out_path.name}")
    if failed:
        for d, e in failed[:10]:
            log(f"  失败 {d}: {e}")
        log("失败日期会在下次运行时自动重试（增量模式）")
    return 0 if not failed else 1


if __name__ == "__main__":
    sys.exit(main())
