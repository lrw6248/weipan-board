#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
微盘抄底信号看板 —— 数据自动更新脚本（全免费数据源）

数据来源（全部免费、无需注册、无需 Token）：
  1. 新浪财经 全市场 A 股快照：市净率 PB、总市值  -> 微盘PB / 平均市值 / 8 个对比指数
  2. 新浪财经 日 K 接口：直接返回 ma_price20       -> 微盘扩散指数
  3. 中证指数 成分股列表（经 akshare）              -> 4 个宽基指数的调和 PB

输出：
  data.js    供 index.html 直接读取（双击打开即可看到最新数据）
  data.json  结构化数据
  history.csv 每日微盘PB序列，用于自动积累近1800交易日25%分位

可选：配置 config.json 里的 sendkey / 邮箱，信号变化时推送到微信或邮件。
"""

import json
import re
import sys
import time
import warnings
import argparse
import concurrent.futures
from pathlib import Path
from datetime import datetime, timezone, timedelta
from collections import Counter

import requests

warnings.filterwarnings("ignore")

ROOT = Path(__file__).resolve().parent.parent
DATA = ROOT / "data"
BASE = DATA  # 所有数据读写统一落在 data/
UA = {
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
                  "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"
}
SINA_H = {**UA, "Referer": "https://vip.stock.finance.sina.com.cn/"}
KLINE_H = {**UA, "Referer": "https://finance.sina.com.cn/"}
EM_H = {**UA, "Referer": "https://data.eastmoney.com/"}
EM_URL = "https://datacenter-web.eastmoney.com/api/data/v1/get"
EM_REPORT = "RPT_VALUEANALYSIS_DET"
EM_COLS = "SECURITY_CODE,SECURITY_NAME_ABBR,PB_MRQ,TOTAL_MARKET_CAP,TRADE_DATE"

# 阈值（来自《微盘抄底，胜率极高》）
TH_PB = 2.0        # 条件1：微盘PB < 2.0
TH_SIGNAL = 3.0    # 条件2：做多信号 >= 3.0（满格5.0）
TH_DIFF = 20.0     # 条件3：扩散指数 < 20%
# 25% 分位线现由「东财真实历史截面」序列（history_real.csv，2018 至今 2148 个交易日）
# 按近 1800 个交易日滚动计算。下面的值仅为真实样本不足时的兜底（原作者 2026-07-24 参考线）。
Q25_FALLBACK = 2.087
MIN_HISTORY_FOR_Q25 = 200

MKT_URL = "https://vip.stock.finance.sina.com.cn/quotes_service/api/json_v2.php/Market_Center.getHQNodeData"
KLINE_URL = "https://quotes.sina.cn/cn/api/jsonp_v2.php/var%20_/CN_MarketDataService.getKLineData"
WIDE_INDICES = [("000300", "沪深300"), ("000905", "中证500"),
                ("000852", "中证1000"), ("932000", "中证2000")]


def log(msg):
    print(f"[{datetime.now().strftime('%H:%M:%S')}] {msg}", flush=True)


def is_intraday():
    """是否处于 A 股连续竞价时段（北京时间，工作日 9:30–15:00）。"""
    n = datetime.now(timezone(timedelta(hours=8)))
    hm = n.hour * 60 + n.minute
    return n.weekday() < 5 and 9 * 60 + 30 <= hm < 15 * 60


def fetch_market():
    """拉取全市场 A 股快照，返回清洗后的列表。盘中自动折算回收盘口径。"""
    adjust = is_intraday()
    if adjust:
        log("检测到盘中时段，行情将折算为上一交易日收盘口径（建议收盘后 15:30 再运行）")
    rows = []
    for page in range(1, 80):
        for attempt in range(3):
            try:
                r = requests.get(MKT_URL, params={
                    "page": page, "num": 100, "sort": "symbol", "asc": 1,
                    "node": "hs_a", "symbol": "", "_s_r_a": "page"
                }, timeout=20, headers=SINA_H)
                data = r.json()
                break
            except Exception as e:
                if attempt == 2:
                    log(f"第 {page} 页拉取失败：{e}")
                    data = []
                time.sleep(0.6)
        if not data:
            break
        rows.extend(data)
    clean = []
    for x in rows:
        sym = str(x.get("symbol") or "")
        code = str(x.get("code") or "")
        name = str(x.get("name") or "")
        if sym.startswith("bj") or re.match(r"^(4|8|920)", code):
            continue  # 剔除北交所
        if "ST" in name.upper() or "退" in name:
            continue  # 剔除 ST / 退市
        try:
            pb = float(x.get("pb") or 0)
            mc = float(x.get("mktcap") or 0)   # 单位：万元
            amt = float(x.get("amount") or 0)  # 单位：元
            if adjust:
                # 盘中 pb / 市值基于实时价，按「昨收 / 现价」折算回上一交易日收盘口径，
                # 保证与日 K（最新收盘日）的日期和数值完全一致。
                trade = float(x.get("trade") or 0)
                prev_close = float(x.get("settlement") or 0)
                if trade > 0 and prev_close > 0:
                    ratio = prev_close / trade
                    pb *= ratio
                    mc *= ratio
        except (TypeError, ValueError):
            continue
        if 0.01 < pb < 100 and mc > 0:
            clean.append({"symbol": sym, "code": code, "name": name, "pb": pb, "mc": mc, "amount": amt})
    log(f"全市场 {len(rows)} 只，过滤后 {len(clean)} 只")
    if len(clean) < 3000:
        raise RuntimeError("行情数据量异常，可能网络受限，请稍后重试")
    return clean


def probe_trade_day():
    """探测新浪日 K 中最新已收盘交易日。

    扩散指数必须依赖日 K（MA20），因此以「日 K 最新日」为唯一权威交易日，
    让东财截面、日 K、页面日期标签三者严格对齐同一天，避免跨日混算。
    """
    for sym in ("sh600000", "sz000001", "sh601398", "sz000002"):
        for attempt in range(2):
            try:
                r = requests.get(KLINE_URL, params={
                    "symbol": sym, "scale": 240, "ma": 20, "datalen": 1
                }, timeout=12, headers=KLINE_H)
                m = re.search(r"var _\((\[.*?\])\)", r.text, re.S)
                if m:
                    arr = json.loads(m.group(1))
                    if arr and arr[-1].get("day"):
                        return arr[-1]["day"]
            except Exception:
                time.sleep(0.4)
    return None


def em_latest_day():
    """东财历史估值明细中最新一个已收盘交易日（仅作 probe 失败时的兜底）。"""
    r = requests.get(EM_URL, params={
        "reportName": EM_REPORT, "columns": "TRADE_DATE",
        "pageNumber": 1, "pageSize": 1,
        "filter": '(SECURITY_CODE="000001")',
        "sortColumns": "TRADE_DATE", "sortTypes": "-1",
    }, timeout=20, headers=EM_H)
    res = r.json().get("result") or {}
    data = res.get("data") or []
    return data[0]["TRADE_DATE"][:10] if data else None


def fetch_market_em(day=None):
    """按交易日拉取东财全市场真实收盘截面（真实 PB_MRQ + 真实总市值）。

    与历史回填脚本 backfill_real.py 使用同一数据源、同一清洗口径，
    保证「当日读数 / 历史序列 / 25% 分位」三者口径完全一致，且不受盘中实时价漂移影响。
    day 由主流程传入（= 日K最新收盘日），确保所有指标同日。
    返回 (clean, trade_date)；失败返回 (None, None)，由主流程回退到新浪实时快照。
    """
    if not day:
        for attempt in range(3):
            try:
                day = em_latest_day()
                if day:
                    break
            except Exception as e:
                log(f"取东财最新交易日重试 {attempt+1}: {e}")
                time.sleep(1)
    if not day:
        return None, None
    rows = []
    for page in range(1, 10):
        for attempt in range(3):
            try:
                r = requests.get(EM_URL, params={
                    "reportName": EM_REPORT, "columns": EM_COLS,
                    "pageNumber": page, "pageSize": 2000,
                    "filter": f"(TRADE_DATE='{day}')",
                    "sortColumns": "SECURITY_CODE", "sortTypes": "1",
                }, timeout=25, headers=EM_H)
                res = r.json().get("result") or {}
                batch = res.get("data") or []
                pages = res.get("pages") or 1
                break
            except Exception as e:
                if attempt == 2:
                    log(f"东财第 {page} 页拉取失败：{e}")
                    batch, pages = [], 1
                time.sleep(0.6)
        rows.extend(batch)
        if page >= pages or not batch:
            break
    clean = []
    for x in rows:
        code = str(x.get("SECURITY_CODE") or "")
        name = str(x.get("SECURITY_NAME_ABBR") or "")
        # 剔除北交所、ST / 退市（与历史回填及新浪口径保持一致）
        if code.startswith(("4", "8", "920")):
            continue
        if "ST" in name.upper() or "退" in name:
            continue
        try:
            pb = float(x.get("PB_MRQ") or 0)
            mc = float(x.get("TOTAL_MARKET_CAP") or 0) / 10000  # 元 → 万元
        except (TypeError, ValueError):
            continue
        if 0.01 < pb < 100 and mc > 0:
            sym = ("sh" if code.startswith("6") else "sz") + code
            clean.append({"symbol": sym, "code": code, "name": name, "pb": pb, "mc": mc})
    log(f"东财真实收盘截面 {day}：{len(rows)} 只，过滤后 {len(clean)} 只")
    if len(clean) < 3000:
        return None, None
    return clean, day


def harmonic(pbs):
    """等权调和平均（原作者口径）。"""
    vals = [p for p in pbs if p and p > 0]
    return len(vals) / sum(1 / p for p in vals) if vals else None


def calc_micro(clean):
    """微盘 = 市值最小 400 只。"""
    asc = sorted(clean, key=lambda x: x["mc"])
    top = asc[:400]
    amt_sum = sum((x.get("amount") or 0) for x in top)
    return {
        "stocks": top,
        "pb": harmonic([x["pb"] for x in top]),
        "avg_mv": sum(x["mc"] for x in top) / len(top) / 10000,      # 亿元
        "median_mv": sorted(x["mc"] for x in top)[200] / 10000,       # 亿元
        "amount": (amt_sum / 1e8) if amt_sum > 0 else None,           # 亿元
    }


def calc_self_indices(clean):
    """4 个自编市值分组指数（按收盘市值从大到小排序）。"""
    desc = sorted(clean, key=lambda x: -x["mc"])
    return {
        "巨盘(1-300)": harmonic([x["pb"] for x in desc[:300]]),
        "大盘(301-800)": harmonic([x["pb"] for x in desc[300:800]]),
        "中盘(801-1800)": harmonic([x["pb"] for x in desc[800:1800]]),
        "小盘(1801-3800)": harmonic([x["pb"] for x in desc[1800:3800]]),
    }


def load_cons_cache():
    """宽基成分股半年调样一次，缓存到本地避免每天重复请求。"""
    p = BASE / "cons_cache.json"
    if p.exists():
        try:
            obj = json.loads(p.read_text(encoding="utf-8"))
            ts = datetime.fromisoformat(obj.get("_cached_at", "2000-01-01"))
            if datetime.now() - ts < timedelta(days=30):
                return obj["data"]
        except Exception:
            pass
    try:
        import akshare as ak
        data = {}
        for code, name in WIDE_INDICES:
            df = ak.index_stock_cons_csindex(symbol=code)
            data[name] = [str(c).zfill(6) for c in df["成分券代码"].tolist()]
            log(f"获取 {name} 成分股 {len(data[name])} 只")
        p.write_text(json.dumps({"_cached_at": datetime.now().isoformat(), "data": data},
                                ensure_ascii=False), encoding="utf-8")
        return data
    except Exception as e:
        log(f"宽基成分股获取失败（{e}），将只用 4 个自编指数计算做多信号")
        return {}


def calc_wide_indices(clean, cons):
    pbmap = {x["code"]: x["pb"] for x in clean}
    return {name: harmonic([pbmap.get(c) for c in codes]) for name, codes in cons.items()}


def calc_diffusion(stocks):
    """扩散指数 = 400 只成分股中收盘价站上 20 日均线的比例。"""
    def one(x):
        for attempt in range(3):
            try:
                r = requests.get(KLINE_URL, params={
                    "symbol": x["symbol"], "scale": 240, "ma": 20, "datalen": 5
                }, timeout=12, headers=KLINE_H)
                m = re.search(r"var _\((\[.*?\])\)", r.text, re.S)
                if not m:
                    continue
                arr = json.loads(m.group(1))
                if not arr:
                    continue
                last = arr[-1]
                ma20 = float(last.get("ma_price20") or 0)
                close = float(last["close"])
                if ma20 <= 0:
                    continue
                return {"day": last["day"], "close": close, "ma20": ma20}
            except Exception:
                time.sleep(0.4)
        return None

    results, days = [], []
    with concurrent.futures.ThreadPoolExecutor(max_workers=12) as ex:
        for res in ex.map(one, stocks):
            if res:
                results.append(res)
                days.append(res["day"])
    if not results:
        raise RuntimeError("日K数据获取失败，无法计算扩散指数")
    above = sum(1 for r in results if r["close"] > r["ma20"])
    trade_day = Counter(days).most_common(1)[0][0]
    log(f"扩散指数：{above}/{len(results)} = {above / len(results) * 100:.2f}%，交易日 {trade_day}")
    return {"value": round(above / len(results) * 100, 2),
            "above": above, "total": len(results), "date": trade_day}


def read_history():
    """读取真实历史序列，同一天按「每日真实积累 > 东财真实回填」优先级去重。

    只读取真实数据文件，全部为每日真实截面 / 真实行情计算，无任何近似或代理数据：
      history.csv        —— 每日运行本脚本，用当日真实行情算出的 PB（逐日积累）
      history_real.csv   —— 东财历史估值明细回填的 2018 至今 2148 个交易日真实截面
    """
    merged = {}
    sources = [("history.csv", 3),
               ("history_real.csv", 2)]
    for fname, rank in sources:
        p = BASE / fname
        if not p.exists():
            continue
        for line in p.read_text(encoding="utf-8").splitlines()[1:]:
            parts = line.split(",")
            if len(parts) < 2:
                continue
            try:
                d, pb = parts[0].strip(), float(parts[1])
            except ValueError:
                continue
            if d not in merged or rank > merged[d][1]:
                merged[d] = (pb, rank)
    return [{"date": d, "pb": v[0], "source": "real"} for d, v in sorted(merged.items())]


def percentile25(vals):
    s = sorted(vals)
    if not s:
        return None
    k = (len(s) - 1) * 0.25
    lo, hi = int(k), min(int(k) + 1, len(s) - 1)
    return round(s[lo] + (s[hi] - s[lo]) * (k - lo), 4)


def get_q25(history):
    """用东财真实历史截面序列，按近 1800 个交易日计算 25% 分位。"""
    real = [h["pb"] for h in history[-1800:]]
    if len(real) >= MIN_HISTORY_FOR_Q25:
        return percentile25(real), f"东财真实历史截面 · 近 {len(real)} 个交易日"
    return Q25_FALLBACK, f"原作者 2026-07-24 参考线 · 已积累 {len(real)} 天"


def judge(micro_pb, signal, diffusion):
    """三盏灯 + 综合结论（分档参考原作者与公开回测）。"""
    lights = {
        "pb": micro_pb < TH_PB,
        "signal": signal >= TH_SIGNAL,
        "diffusion": diffusion < TH_DIFF,
    }
    n = sum(lights.values())
    levels = {
        3: ("抄底时刻", "三灯全亮：PB<2.0、做多信号≥3.0、扩散指数<20%，历史罕见，可考虑分批重仓", "danger"),
        2: ("重点关注", "两盏灯亮，接近击球区。若 PB 与做多信号同时满足，性价比最高", "warn"),
        1: ("保持观察", "仅一盏灯亮，信号不足，继续等待，管住手", "calm"),
        0: ("管住手", "三灯全灭，估值不便宜。历史上 0–1 星区间后续 60 日超额收益为负", "mute"),
    }
    title, desc, tone = levels[n]
    return lights, n, {"title": title, "desc": desc, "tone": tone}


def _r(x, n):
    """四舍五入到 n 位，用 HALF_UP——与页面 JS 的 toFixed 一致。
    Python 内置 round 是银行家舍入（41.25 → 41.2），会和看板显示的 41.3 打架。"""
    from decimal import Decimal, ROUND_HALF_UP
    return float(Decimal(str(x)).quantize(Decimal(1).scaleb(-n), rounding=ROUND_HALF_UP))


def push_body(payload, md=True):
    """把「今天哪几个信号成立」拆开写清楚，而不是把四个参数并排堆在一行。

    md=True 给 Server酱（微信）用，它按 markdown 渲染；
    md=False 给邮件用，纯文本，避免把 ** 和 ### 原样发出去。
    """
    pb, sg, df = payload["micro_pb"], payload["signal"], payload["diffusion"]
    L = payload["lights"]
    b = (lambda s: f"**{s}**") if md else (lambda s: s)
    pbv, sgv, dfv = _r(pb, 3), _r(sg, 1), _r(df, 1)   # 与页面显示精度对齐
    items = [
        ("微盘 PB", f"{pbv:.3f}", L["pb"],
         f"需低于 {TH_PB:.1f}，当前高 {_r(pbv - TH_PB, 3):g}",
         f"低于 {TH_PB:.1f}，成立"),
        ("做多信号", f"{sgv:g} 星", L["signal"],
         f"需 {TH_SIGNAL:g} 星以上，当前差 {_r(TH_SIGNAL - sgv, 1):g} 星",
         f"达到 {TH_SIGNAL:g} 星，成立"),
        ("扩散指数", f"{dfv:.1f}%", L["diffusion"],
         f"需低于 {TH_DIFF:g}%，当前高 {_r(dfv - TH_DIFF, 1):g} 个百分点",
         f"低于 {TH_DIFF:g}%，成立"),
    ]
    ok = [i for i in items if i[2]]
    no = [i for i in items if not i[2]]
    v = payload["verdict"]
    d = payload["date"].replace("-", "/")
    out = [f"### {d} · {len(ok)}/3 项成立" if md else f"{d} · {len(ok)}/3 项成立", ""]
    out.append(f"{b(v['title'])}｜{v['desc']}")
    out.append("")
    out.append(f"{b('已满足')}（{len(ok)} 项）")
    out += ([f"- {b(a + ' ' + x)}：{y}" if md else f"· {a} {x}：{y}" for a, x, _, _, y in ok]
            or [("- 无" if md else "· 无")])
    out.append("")
    out.append(f"{b('未满足')}（{len(no)} 项）")
    out += ([f"- {b(a + ' ' + x)}：{y}" if md else f"· {a} {x}：{y}" for a, x, _, y, _ in no]
            or [("- 无" if md else "· 无")])
    out.append("")
    out.append(f"平均市值 {payload['avg_mv']:.2f} 亿（只描述结构，不参与判定）")
    out.append("三项全亮才是「抄底时刻」。" if len(ok) < 3
               else "三项全亮，这就是原作者定义的「抄底时刻」。")
    return "\n".join(out)


def push_notify(payload, prev, cfg):
    """可选的免费提醒：Server酱（微信） / SMTP 邮件。"""
    if not cfg:
        return
    cur = payload["lights"]
    changed = prev is None or any(cur[k] != prev.get(k) for k in cur)
    n = payload["light_count"]
    if not changed and n < 3:
        return  # 状态没变化且未到三灯，不打扰
    d = payload["date"]
    text_md = push_body(payload, md=True)      # Server酱 支持 markdown
    text_tx = push_body(payload, md=False)     # 邮件只发纯文本，别露出 ** 和 ###
    sendkey = cfg.get("serverchan_sendkey", "").strip()
    if sendkey:
        try:
            url = f"https://sctapi.ftqq.com/{sendkey}.send"
            r = requests.post(url, data={"title": f"微盘信号 {n}/3 · {payload['verdict']['title']}",
                                         "desp": text_md}, timeout=15, headers=UA)
            log(f"微信推送：{r.status_code} {r.text[:80]}")
        except Exception as e:
            log(f"微信推送失败：{e}")
    mail = cfg.get("email", {})
    if mail.get("smtp") and mail.get("to"):
        try:
            import smtplib
            from email.mime.text import MIMEText
            msg = MIMEText(text_tx, "plain", "utf-8")
            msg["Subject"] = f"微盘信号 {n}/3 · {payload['verdict']['title']} · {d}"
            msg["From"] = mail["user"]
            msg["To"] = mail["to"]
            s = smtplib.SMTP_SSL(mail["smtp"], int(mail.get("port", 465)), timeout=20)
            s.login(mail["user"], mail["password"])
            s.sendmail(mail["user"], [mail["to"]], msg.as_string())
            s.quit()
            log("邮件推送成功")
        except Exception as e:
            log(f"邮件推送失败：{e}")


def update_extra(payload):
    """维护 extra_hist.json / extra_hist.js：
    扩散指数（按当前 400 只成分回溯+每日追加）、微盘成交额、市值中位数。
    这几个指标只用于观察结构，不参与信号判定。
    """
    jp = BASE / "extra_hist.json"
    obj = {"meta": {}, "diff": [], "amount": [], "median": [], "avg": []}
    if jp.exists():
        try:
            obj = json.loads(jp.read_text(encoding="utf-8"))
            obj.setdefault("meta", {}); obj.setdefault("diff", [])
            obj.setdefault("amount", []); obj.setdefault("median", []); obj.setdefault("avg", [])
        except Exception:
            log("extra_hist.json 读取失败，将重建")

    # 市值中位数：首次运行时从 history_real.csv 补齐历史
    if not obj["median"] and (BASE / "history_real.csv").exists():
        rows = (BASE / "history_real.csv").read_text(encoding="utf-8").splitlines()
        for line in rows[1:]:
            c = line.split(",")
            if len(c) >= 4:
                try:
                    obj["median"].append([c[0], round(float(c[3]), 2)])
                except ValueError:
                    pass
        log(f"市值中位数历史已载入 {len(obj['median'])} 天")

    d = payload.get("date")
    if d:
        def upsert(key, v):
            if v is None:
                return
            arr = [x for x in obj[key] if x[0] != d]
            arr.append([d, round(float(v), 2) if key != "amount" else round(float(v), 1)])
            arr.sort(key=lambda x: x[0])
            obj[key] = arr

        upsert("diff", payload.get("diffusion"))
        upsert("median", payload.get("median_mv"))
        upsert("amount", payload.get("amount"))

    # 控制体积：中位数保留近 1600 个交易日，扩散保留近 400 个交易日
    obj["median"] = obj["median"][-1600:]
    obj["diff"] = obj["diff"][-400:]
    obj["meta"] = {
        "diff_from": obj["diff"][0][0] if obj["diff"] else "",
        "diff_to": obj["diff"][-1][0] if obj["diff"] else "",
        "diff_note": "按当前 400 只成分股回溯，成分变动存在轻微偏差",
        "amount_from": obj["amount"][0][0] if obj["amount"] else "",
        "updated": payload.get("updated_at", ""),
    }
    jp.write_text(json.dumps(obj, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
    (BASE / "extra_hist.js").write_text(
        "window.EXTRA_HIST = " + json.dumps(obj, ensure_ascii=False, separators=(",", ":")) + ";\n",
        encoding="utf-8")
    log(f"extra_hist 已更新：扩散 {len(obj['diff'])} 天 / 成交额 {len(obj['amount'])} 天 / 中位数 {len(obj['median'])} 天")


def main():
    ap = argparse.ArgumentParser(description="微盘抄底信号看板 - 数据更新")
    ap.add_argument("--no-notify", action="store_true", help="不发送提醒")
    args = ap.parse_args()

    log("开始更新数据…")
    # 先确定唯一权威交易日（日K最新收盘日），所有数据源都按这一天取数，避免跨日混算。
    trade_day = probe_trade_day()
    if trade_day:
        log(f"权威交易日（日K最新收盘）：{trade_day}")
    # 优先用东财「按交易日的真实收盘截面」：口径与历史序列、25% 分位完全一致，
    # 且不受盘中实时价漂移影响；若东财临时不可用，回退到新浪实时快照。
    clean, em_day = fetch_market_em(trade_day)
    market_src = "东方财富真实收盘截面"
    if clean is None:
        log("东财截面不可用，回退到新浪实时行情快照")
        clean = fetch_market()
        market_src = "新浪财经实时行情"
    micro = calc_micro(clean)
    if not micro.get("amount"):
        # 东财估值截面不含成交额，补拉一次新浪实时快照，仅用于成交额统计；失败不影响主流程。
        try:
            snap = fetch_market()
            amt_map = {x["code"]: (x.get("amount") or 0) for x in snap}
            tot = sum(amt_map.get(s["code"], 0) for s in micro["stocks"])
            if tot > 0:
                micro["amount"] = round(tot / 1e8, 1)
                log(f"微盘成交额（新浪快照补取）：{micro['amount']:.1f} 亿")
        except Exception as e:
            log(f"成交额补取失败（{e}），本次不统计成交额")
    self_idx = calc_self_indices(clean)
    cons = load_cons_cache()
    wide_idx = calc_wide_indices(clean, cons)
    diff = calc_diffusion(micro["stocks"])

    history = read_history()
    q25, q25_src = get_q25(history)

    # ---- 微盘做多信号：纵向1分 + 横向8个指数各0.5分，满分5 ----
    pb = micro["pb"]
    detail = {"纵向(近1800日25%分位)": {"value": q25, "ok": pb < q25}}
    score = 1.0 if pb < q25 else 0.0
    for name, val in {**self_idx, **wide_idx}.items():
        if val is None:
            continue
        ok = pb < val
        detail[name] = {"value": round(val, 4), "ok": ok}
        if ok:
            score += 0.5
    score = round(score, 1)

    lights, n, verdict = judge(pb, score, diff["value"])

    payload = {
        "date": diff["date"],
        "updated_at": datetime.now(timezone(timedelta(hours=8))).strftime("%Y-%m-%d %H:%M"),
        "micro_pb": round(pb, 4),
        "signal": score,
        "diffusion": diff["value"],
        "avg_mv": round(micro["avg_mv"], 2),
        "median_mv": round(micro["median_mv"], 2),
        "amount": round(micro["amount"], 1) if micro.get("amount") else None,
        "q25": q25,
        "q25_source": q25_src,
        "market_source": market_src,
        "history_source": "东方财富历史估值明细（每日真实截面重算最小400只）",
        "history_days": len(history),
        "history_from": history[0]["date"] if history else "",
        "history_to": history[-1]["date"] if history else "",
        "thresholds": {"pb": TH_PB, "signal": TH_SIGNAL, "diffusion": TH_DIFF},
        "indices": {**{k: round(v, 4) for k, v in self_idx.items() if v},
                    **{k: round(v, 4) for k, v in wide_idx.items() if v}},
        "signal_detail": detail,
        "diff_detail": {"above": diff["above"], "total": diff["total"]},
        "lights": lights,
        "light_count": n,
        "verdict": verdict,
        "history": history[-2200:],
    }

    # 写真实历史：以 history.csv 自身判断是否已有该日记录
    hp = BASE / "history.csv"
    real_dates = set()
    if hp.exists():
        for line in hp.read_text(encoding="utf-8").splitlines()[1:]:
            if line.strip():
                real_dates.add(line.split(",")[0])
    if payload["date"] not in real_dates:
        if not hp.exists():
            hp.write_text("date,pb\n", encoding="utf-8")
        with hp.open("a", encoding="utf-8") as f:
            f.write(f"{payload['date']},{pb:.4f}\n")
        merged = read_history()
        payload["history"] = merged[-2200:]
        payload["history_days"] = len(merged)
        payload["history_from"] = merged[0]["date"] if merged else ""
        payload["history_to"] = merged[-1]["date"] if merged else ""

    (BASE / "data.json").write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")
    (BASE / "data.js").write_text("window.BOARD_DATA = " + json.dumps(payload, ensure_ascii=False) + ";\n",
                                  encoding="utf-8")
    try:
        update_extra(payload)
    except Exception as e:
        log(f"extra_hist 写入失败：{e}")

    log(f"完成：{payload['date']}  PB={pb:.4f}  信号={score}  扩散={diff['value']}%  "
        f"平均市值={micro['avg_mv']:.2f}亿  => {verdict['title']}（{n}/3 灯）")

    if not args.no_notify:
        cfg_path = ROOT / "config.json"
        cfg = json.loads(cfg_path.read_text(encoding="utf-8")) if cfg_path.exists() else {}
        state_path = DATA / ".last_state.json"
        prev = json.loads(state_path.read_text(encoding="utf-8")) if state_path.exists() else None
        push_notify(payload, prev, cfg)
        state_path.write_text(json.dumps(payload["lights"]), encoding="utf-8")


if __name__ == "__main__":
    try:
        main()
    except Exception as e:
        log(f"更新失败：{type(e).__name__}: {e}")
        sys.exit(1)
