#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""推送连通性测试：拿当前 data/data.json 的数值，按真实格式发一条消息。

只验证「webhook / SendKey 有没有配对」，不抓数据、不动 .last_state.json。

    python scripts/test_push.py             # 读 config.json，真的发
    python scripts/test_push.py --dry-run   # 只把飞书卡片 JSON 打印出来，不发送

为什么要它：正式推送的规则是「状态变化或三灯全亮才推」，
配好之后如果当天状态没变，你收不到消息，会误以为没配成功。
这个脚本把 prev 置空，绕过该规则强发一条。
"""

import argparse
import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "scripts"))

import update_data as U  # noqa: E402


def main():
    ap = argparse.ArgumentParser(description="推送连通性测试")
    ap.add_argument("--dry-run", action="store_true", help="只打印卡片 JSON，不发送")
    args = ap.parse_args()

    payload = json.loads((ROOT / "data" / "data.json").read_text(encoding="utf-8"))
    cfg_path = ROOT / "config.json"
    cfg = json.loads(cfg_path.read_text(encoding="utf-8")) if cfg_path.exists() else {}

    ch = []
    if (cfg.get("feishu_webhook") or "").strip():
        ch.append("飞书")
    if (cfg.get("serverchan_sendkey") or "").strip():
        ch.append("微信")
    if (cfg.get("email", {}) or {}).get("smtp"):
        ch.append("邮件")

    print("数据日期：", payload["date"], "｜ 灯数：", payload["light_count"], "/3")
    print("已配置渠道：", "、".join(ch) if ch else "（无）")
    if not ch:
        print("\nconfig.json 里 feishu_webhook / serverchan_sendkey 都是空的，先把地址填上。")
        return

    if args.dry_run:
        print("\n--- 飞书卡片 JSON（不会发送）---")
        print(json.dumps(U.feishu_card(payload), ensure_ascii=False, indent=2))
        return

    print("\n开始发送（忽略「状态没变不推」的规则，强制发一条）…")
    U.push_notify(payload, None, cfg)
    print("\n判读：日志出现「飞书推送成功」即为配好。")
    print("  19001 → webhook 地址不对（复制时少了几位）")
    print("  19021 → 签名不对或手机/服务器时间偏差超过 1 小时")
    print("  9499  → 请求体格式问题，把 --dry-run 的输出贴给我")


if __name__ == "__main__":
    main()
