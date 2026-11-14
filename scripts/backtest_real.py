#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
用【真实历史截面】独立复现「微盘星级信号」有效性回测。

参考：微信公众号「莱言维语」2026-09-20《微盘抄底看几颗星？》
      该文回测用的是万得微盘股指数（理论指数，2016.9-2026.9）。
本脚本不依赖该指数，完全用东方财富 RPT_VALUEANALYSIS_DET 报表的
每日全市场真实截面自行构造：

  1) 微盘 PB     —— 每日按真实总市值重选最小 400 只，真实 PB_MRQ 等权调和平均
  2) 8 指数 PB   —— 4 条宽基（沪深300/中证500/中证1000/中证2000，成分股来自
                    中证指数，经 cons_cache.json）+ 4 条按市值分组的自编指数
  3) 星级        —— 文章口径：低于自身近1800日25%分位 +1，低于每条宽基 +1，满分5
                    原版口径：纵向 +1，低于 8 指数每条 +0.5，满分5
  4) 价格序列    —— 用每日选出的最小 400 只成分股，取【次日】真实涨跌幅
                    CHANGE_RATE 的等权均值作为组合日收益，逐日累乘成净值。
                    这是「t 日收盘选股、t+1 日持有」，无前视偏差，且
                    CHANGE_RATE 已含除权处理，避免不复权价的跳空。

与原文口径差异（会在页面与文档中如实标注）：
  - 区间 2018-01-02 起（东财报表最早），原文 2016-09 起；
  - 价格用自建最小400只等权组合，原文用万得微盘股指数；
  - 近1800日分位在早期样本不足时使用扩展窗口；
  - 扩散指数需要逐日全市场 MA20，免费渠道无法回溯，故历史组合叠加
    部分只做「星级 + PB<2.0」，扩散相关结论引用原文。

用法：
  python backtest_real.py                 # 全量（已有缓存则秒级复算）
  python backtest_real.py --days 120      # 只取最近 N 天，调试用
  python backtest_real.py --force         # 忽略缓存重新拉行情
  python backtest_real.py --workers 7

输出：
  star_history.csv   逐日真实 PB / 分位 / 两套星级 / 净值 / 收益 / 8指数PB
  backtest.json      全部回测统计（供看板页面读取）
  .bt_cache/         每日原始截面缓存（gzip，可安全删除后重跑）
"""
import argparse
import concurrent.futures
import gzip
import json
import math
import sys
import time
from datetime import datetime
from pathlib import Path

import requests

ROOT = Path(__file__).resolve().parent.parent
DATA = ROOT / "data"
BASE = DATA  # 所有数据读写统一落在 data/
CACHE = BASE / ".bt_cache"
API = "https://datacenter-web.eastmoney.com/api/data/v1/get"
REPORT = "RPT_VALUEANALYSIS_DET"
COLS = ("SECURITY_CODE,SECURITY_NAME_ABBR,PB_MRQ,TOTAL_MARKET_CAP,"
        "CHANGE_RATE,CLOSE_PRICE,TRADE_DATE")
H = {
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
                  "(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
    "Referer": "https://data.eastmoney.com/",
}
TOP_N = 400
WIDE_NAMES = ["沪深300", "中证500", "中证1000", "中证2000"]
SELF_NAMES = ["巨盘300", "大盘500", "中盘1000", "小盘2000"]
HOLD_DAYS = [5, 10, 20, 60, 120]


def log(msg):
    print(f"[{datetime.now().strftime('%H:%M:%S')}] {msg}", flush=True)


def harmonic(vals):
    v = [x for x in vals if x and x > 0]
    return len(v) / sum(1 / x for x in v) if v else None


def get_trade_days():
    p = BASE / ".trade_days.json"
    if p.exists():
        return json.loads(p.read_text(encoding="utf-8"))
    # 兜底：用东财报表自身取交易日历
    r = requests.get(API, params={
        "reportName": REPORT, "columns": "TRADE_DATE",
        "pageNumber": 1, "pageSize": "5000",
        "filter": '(SECURITY_CODE="000001")',
        "sortColumns": "TRADE_DATE", "sortTypes": "1",
        "source": "WEB", "client": "WEB",
    }, timeout=25, headers=H)
    rows = (r.json().get("result") or {}).get("data") or []
    days = sorted({str(x["TRADE_DATE"])[:10] for x in rows})
    p.write_text(json.dumps(days), encoding="utf-8")
    return days


def get_cons():
    p = BASE / "cons_cache.json"
    if p.exists():
        return json.loads(p.read_text(encoding="utf-8"))["data"]
    # 兜底：akshare 中证指数成分股
    import akshare as ak
    out = {}
    for code, nm in [("000300", "沪深300"), ("000905", "中证500"),
                     ("000852", "中证1000"), ("932000", "中证2000")]:
        df = ak.index_stock_cons_csindex(symbol=code)
        out[nm] = list(df["成分券代码"].astype(str).str.zfill(6))
    return out


# ---------------- 阶段 1：逐日真实截面 ----------------
def fetch_day(day, cons, force=False):
    cp = CACHE / f"{day}.json.gz"
    if cp.exists() and not force:
        return day, "cached"
    params = {
        "reportName": REPORT, "columns": COLS,
        "pageNumber": "1", "pageSize": "6000",
        "filter": f"(TRADE_DATE='{day}')",
        "sortColumns": "TOTAL_MARKET_CAP", "sortTypes": "1",
        "source": "WEB", "client": "WEB",
    }
    last = None
    for attempt in range(3):
        try:
            r = requests.get(API, params=params, timeout=30, headers=H)
            rows = (r.json().get("result") or {}).get("data") or []
            if not rows:
                raise ValueError("空截面")
            break
        except Exception as e:
            last = e
            time.sleep(1 + attempt)
    else:
        raise RuntimeError(f"{day} 拉取失败: {last}")

    clean = []
    for x in rows:
        code = str(x.get("SECURITY_CODE") or "")
        name = str(x.get("SECURITY_NAME_ABBR") or "")
        if code.startswith(("4", "8", "920", "bj")):
            continue
        if "ST" in name.upper() or "退" in name:
            continue
        try:
            pb = float(x.get("PB_MRQ") or 0)
            mv = float(x.get("TOTAL_MARKET_CAP") or 0)
            ch = float(x.get("CHANGE_RATE") or 0)
        except (TypeError, ValueError):
            continue
        if 0.01 < pb < 100 and mv > 0:
            clean.append((code, pb, mv, ch))
    clean.sort(key=lambda z: z[2])
    if len(clean) < TOP_N:
        raise ValueError(f"{day} 有效股票仅 {len(clean)} 只")

    top = clean[:TOP_N]
    desc = clean[::-1]                      # 市值从大到小
    segs = [desc[:300], desc[300:800], desc[800:1800], desc[1800:3800]]
    self_pb = {nm: harmonic([z[1] for z in seg]) for nm, seg in zip(SELF_NAMES, segs)}

    code_pb = {z[0]: z[1] for z in clean}
    wide_pb = {}
    for nm in WIDE_NAMES:
        ps = [code_pb[c] for c in cons.get(nm, []) if c in code_pb]
        wide_pb[nm] = harmonic(ps) if ps else None

    mvs = sorted(z[2] / 1e8 for z in top)
    payload = {
        "date": day,
        "micro_pb": round(harmonic([z[1] for z in top]), 4),
        "avg_mv": round(sum(mvs) / TOP_N, 2),
        "median_mv": round(mvs[TOP_N // 2], 2),
        "n_valid": len(clean),
        "wide_pb": {k: (round(v, 4) if v else None) for k, v in wide_pb.items()},
        "self_pb": {k: (round(v, 4) if v else None) for k, v in self_pb.items()},
        "top_codes": [z[0] for z in top],
        "cr": {z[0]: z[3] for z in clean},     # 全市场当日真实涨跌幅，供次日配对
    }
    with gzip.open(cp, "wt", encoding="utf-8") as f:
        json.dump(payload, f, ensure_ascii=False, separators=(",", ":"))
    return day, "ok"


def load_day(day):
    with gzip.open(CACHE / f"{day}.json.gz", "rt", encoding="utf-8") as f:
        return json.load(f)


# ---------------- 阶段 2：星级 + 净值 ----------------
def percentile25(vals):
    v = sorted(vals)
    if not v:
        return None
    k = (len(v) - 1) * 0.25
    lo, hi = int(k), min(int(k) + 1, len(v) - 1)
    return v[lo] + (v[hi] - v[lo]) * (k - lo)


def build_series(days):
    pbs = [load_day(d)["micro_pb"] for d in days]
    series = []
    nav, prev_codes = 1.0, None
    for i, d in enumerate(days):
        o = load_day(d)
        pb = o["micro_pb"]
        q25 = percentile25(pbs[max(0, i - 1799):i + 1])
        long_score = 1 if (q25 and pb < q25) else 0
        wide = [v for v in o["wide_pb"].values() if v]
        selfv = [v for v in o["self_pb"].values() if v]
        star_article = long_score + sum(1 for v in wide if pb < v)
        star_original = long_score + 0.5 * sum(1 for v in wide + selfv if pb < v)

        # t-1 日选出的 400 只，持有到 t 日，收益 = 这些股票 t 日真实涨跌幅均值
        ret = None
        if prev_codes is not None:
            cr = o["cr"]
            rates = [cr[c] for c in prev_codes if c in cr]
            if rates:
                ret = sum(rates) / len(rates) / 100.0
                nav *= (1 + ret)
        series.append({
            "date": d, "pb": pb, "q25": round(q25, 4) if q25 else None,
            "star": star_article, "star_orig": star_original,
            "nav": round(nav, 6), "ret": ret,
            "avg_mv": o["avg_mv"], "n_valid": o["n_valid"],
            "wide_pb": o["wide_pb"], "self_pb": o["self_pb"],
        })
        prev_codes = o["top_codes"]
    return series


# ---------------- 阶段 3：回测统计 ----------------
def mean(xs):
    return sum(xs) / len(xs) if xs else None


def pct(x):
    return None if x is None else round(x * 100, 2)


def fwd_table(series, n):
    """返回每天持有 n 个交易日的未来收益（None 表示窗口未满）。"""
    out = [None] * len(series)
    for i in range(len(series) - n):
        a, b = series[i]["nav"], series[i + n]["nav"]
        if a and b:
            out[i] = b / a - 1
    return out


def stat_block(vals, base):
    v = [x for x in vals if x is not None]
    if not v:
        return {"n": 0, "avg": None, "win": None, "excess": None}
    return {
        "n": len(v),
        "avg": pct(mean(v)),
        "win": round(100 * sum(1 for x in v if x > 0) / len(v), 1),
        "excess": pct(mean(v) - base) if base is not None else None,
    }


def first_rise(series, level, key="star"):
    """首次升破 level 星（前一日低于 level）。"""
    out = []
    for i in range(1, len(series)):
        if series[i - 1][key] < level <= series[i][key]:
            out.append(i)
    return out


def spearman(xs, ys):
    """Spearman 秩相关（并列取平均秩）。"""
    def ranks(a):
        order = sorted(range(len(a)), key=lambda i: a[i])
        r = [0.0] * len(a)
        i = 0
        while i < len(order):
            j = i
            while j + 1 < len(order) and a[order[j + 1]] == a[order[i]]:
                j += 1
            avg = (i + j) / 2 + 1
            for k in range(i, j + 1):
                r[order[k]] = avg
            i = j + 1
        return r
    pairs = [(x, y) for x, y in zip(xs, ys) if y is not None]
    if len(pairs) < 10:
        return None
    rx, ry = ranks([p[0] for p in pairs]), ranks([p[1] for p in pairs])
    mx, my = mean(rx), mean(ry)
    num = sum((a - mx) * (b - my) for a, b in zip(rx, ry))
    den = math.sqrt(sum((a - mx) ** 2 for a in rx) * sum((b - my) ** 2 for b in ry))
    return round(num / den, 4) if den else None


def run_backtest(series):
    n = len(series)
    fwds = {h: fwd_table(series, h) for h in HOLD_DAYS}
    base = {h: mean([x for x in v if x is not None]) for h, v in fwds.items()}

    by_star = {}
    for s in range(0, 6):
        idx = [i for i, x in enumerate(series) if x["star"] == s]
        by_star[str(s)] = {
            "days": len(idx),
            "share": round(100 * len(idx) / n, 1),
            **{f"h{h}": stat_block([fwds[h][i] for i in idx], base[h]) for h in HOLD_DAYS},
        }

    # 四档触发（升破口径，天然去重）
    def trig_stat(indices, label):
        return {
            "label": label, "times": len(indices),
            **{f"h{h}": stat_block([fwds[h][i] for i in indices], base[h]) for h in HOLD_DAYS},
            "detail": [
                {"date": series[i]["date"],
                 "h20": pct(fwds[20][i]), "h60": pct(fwds[60][i]),
                 "h120": pct(fwds[120][i])}
                for i in indices
            ],
        }

    t3 = first_rise(series, 3)
    t4 = first_rise(series, 4)
    t5 = first_rise(series, 5)
    t3pb = [i for i in t3 if series[i]["pb"] < 2.0]
    triggers = [
        trig_stat(t3, "升破3星"),
        trig_stat(t4, "升破4星"),
        trig_stat(t5, "首次升至5星"),
        trig_stat(t3pb, "升破3星且PB<2.0"),
    ]

    # 组合叠加（以星级>=3 为基础）
    ge3 = [i for i, x in enumerate(series) if x["star"] >= 3]
    combos = [
        {"label": "仅星级≥3", "days": len(ge3),
         **{f"h{h}": stat_block([fwds[h][i] for i in ge3], base[h]) for h in [20, 60, 120]}},
        {"label": "叠加 PB<2.0", "days": len([i for i in ge3 if series[i]["pb"] < 2.0]),
         **{f"h{h}": stat_block([fwds[h][i] for i in ge3 if series[i]["pb"] < 2.0], base[h])
            for h in [20, 60, 120]}},
        {"label": "三灯全亮(星级≥3+PB<2.0)", "days": None,
         "note": "历史扩散指数需逐日全市场MA20，免费渠道无法回溯；本项引用原文结论"},
    ]

    # Spearman：星级 vs 未来 N 日收益
    stars = [x["star"] for x in series]
    corr = {str(h): spearman(stars, fwds[h]) for h in HOLD_DAYS}

    # 0 星防守
    zero = [i for i, x in enumerate(series) if x["star"] == 0]

    return {
        "meta": {
            "start": series[0]["date"], "end": series[-1]["date"],
            "days": n,
            "source": "东方财富 RPT_VALUEANALYSIS_DET 每日全市场真实截面",
            "price": "自建最小400只等权组合（t日选股、t+1日持有，CHANGE_RATE真实涨跌幅）",
            "star_rule_article": "纵向低于近1800日25%分位+1；低于4条宽基每条+1；满分5",
            "star_rule_original": "纵向+1；低于8指数每条+0.5；满分5",
            "diffusion_history": False,
            "caveats": [
                "区间自 2018-01-02 起（东财报表最早），原文自 2016-09 起，样本区间不同",
                "价格用自建最小400只等权组合，原文用万得微盘股指数（理论指数）",
                "近1800日分位在早期样本不足时使用扩展窗口，早期星级稳定性较低",
                "宽基成分股按当前名单回溯匹配，未还原历史调样",
                "信号窗口大量重叠，胜率与显著性会被高估；2026年部分窗口未满",
            ],
        },
        "baseline": {str(h): pct(base[h]) for h in HOLD_DAYS},
        "by_star": by_star,
        "triggers": triggers,
        "combos": combos,
        "spearman": corr,
        "zero_defense": {
            "days": len(zero),
            **{f"h{h}": stat_block([fwds[h][i] for i in zero], base[h]) for h in [20, 60, 120]},
        },
        "five_star_days": [x["date"] for x in series if x["star"] == 5],
        "star_distribution_orig": {
            str(s): sum(1 for x in series if int(round(x["star_orig"])) == s) for s in range(6)
        },
    }


def main():
    ap = argparse.ArgumentParser(description="真实截面复现微盘星级信号回测")
    ap.add_argument("--workers", type=int, default=7)
    ap.add_argument("--days", type=int, default=0, help="只取最近 N 天，调试用")
    ap.add_argument("--force", action="store_true", help="忽略缓存重新拉取行情")
    args = ap.parse_args()

    CACHE.mkdir(exist_ok=True)
    days = get_trade_days()
    if args.days:
        days = days[-args.days:]
    cons = get_cons()
    log(f"交易日 {len(days)} 天：{days[0]} ~ {days[-1]}")

    todo = [d for d in days if args.force or not (CACHE / f"{d}.json.gz").exists()]
    log(f"需拉取 {len(todo)} 天（缓存命中 {len(days)-len(todo)} 天）")
    if todo:
        t0 = time.time()
        failed = []
        with concurrent.futures.ThreadPoolExecutor(max_workers=args.workers) as ex:
            futs = {ex.submit(fetch_day, d, cons, args.force): d for d in todo}
            for i, fut in enumerate(concurrent.futures.as_completed(futs), 1):
                d = futs[fut]
                try:
                    fut.result()
                except Exception as e:
                    failed.append((d, str(e)[:110]))
                if i % 300 == 0:
                    log(f"  进度 {i}/{len(todo)}，失败 {len(failed)}，耗时 {time.time()-t0:.0f}s")
        if failed:
            log(f"拉取失败 {len(failed)} 天：" + str(failed[:5]))
            log("请重跑（会自动补齐失败日期）")
            return 1
        log(f"截面拉取完成，耗时 {time.time()-t0:.0f}s")

    log("计算星级序列与自建净值…")
    series = build_series(days)
    # 输出逐日序列
    with (BASE / "star_history.csv").open("w", encoding="utf-8", newline="") as f:
        f.write("date,pb,q25,star_article,star_original,nav,ret,avg_mv,n_valid\n")
        for x in series:
            f.write(f"{x['date']},{x['pb']},{x['q25']},{x['star']},{x['star_orig']},"
                    f"{x['nav']},{'' if x['ret'] is None else round(x['ret'],6)},"
                    f"{x['avg_mv']},{x['n_valid']}\n")

    log("跑回测统计…")
    bt = run_backtest(series)
    # 附上逐日精简序列，供页面画曲线（日期/PB/分位/星级/净值）
    # s = 原文口径星级（4 个宽基各 1 分，整数）；o = 本看板口径（1 个时序项 + 8 个对象各 0.5 星）
    # 页面上的星级、档位表、做多信号曲线全部用 o，s 只留给「原文口径对照」
    bt["series"] = [
        {"d": x["date"], "p": x["pb"], "q": x["q25"], "s": x["star"],
         "o": x["star_orig"], "n": x["nav"]}
        for x in series
    ]
    bt_json = json.dumps(bt, ensure_ascii=False, separators=(",", ":"))
    (BASE / "backtest.json").write_text(bt_json, encoding="utf-8")
    # 供看板页面以 file:// 双击方式读取（避免 fetch 的跨域限制）
    (BASE / "bt_data.js").write_text("window.BT_DATA=" + bt_json + ";", encoding="utf-8")
    log(f"完成 → star_history.csv（{len(series)} 行）、backtest.json、bt_data.js")
    log(f"  基准 20/60/120日: " + " / ".join(f"{bt['baseline'][str(h)]}%" for h in [20, 60, 120]))
    log(f"  星级分布(文章口径): " + str({k: v["days"] for k, v in bt["by_star"].items()}))
    for t in bt["triggers"]:
        log(f"  {t['label']}: {t['times']}次, 120日均值 {t['h120']['avg']}%, 胜率 {t['h120']['win']}%")
    return 0


if __name__ == "__main__":
    sys.exit(main())
