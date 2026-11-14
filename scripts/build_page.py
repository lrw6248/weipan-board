#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
把样式、脚本、数据内联进 index.html，让这一个文件走到哪都能正常显示。

为什么必须内联（别改成外链）：
  index.html 会被拿来「单独打开」——对话框里点开预览、微信发到手机、
  拖进浏览器窗口。这些场景下只有 index.html 本体过去，同一目录下的
  assets/ 与 data/ 并不一定跟着走。一旦样式和脚本是外链（<link> / <script src>），
  拿不到就成了「一屏没有排版的纯文字」——2026-11-14 就是这么翻车的。
  所以：页面必须自包含。

源文件与产物的关系（重要）：
  · 权威源是 assets/css/style.css、assets/js/app.js、data/*.js —— 改东西改这里。
  · index.html 里的三个 <!--INLINE:xxx--> 块是**产物**，每次构建都会被覆盖，
    不要手工改块里的内容，改了下一次构建就没了。
  · 本脚本幂等：可以反复运行，块内容整段替换，不会嵌套、不会重复。

用法：
  python scripts/build_page.py            # 就地更新 index.html
  python scripts/build_page.py --check    # 只检查有没有外链残留，不写文件
"""

import argparse
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
PAGE = ROOT / "index.html"

CSS = "assets/css/style.css"
DATA = ["data/data.js", "data/bt_data.js", "data/extra_hist.js"]
APP = "assets/js/app.js"

EXTERNAL = re.compile(r'<link[^>]+stylesheet[^>]*>|<script[^>]+\bsrc=')


def read(rel: str) -> str:
    p = ROOT / rel
    if not p.exists():
        sys.exit(f"缺少文件：{p}")
    return p.read_text(encoding="utf-8")


def esc(code: str) -> str:
    """'</script' 会提前闭合标签，必须转义。"""
    return code.replace("</script", "<\\/script")


def fill(html: str, key: str, body: str) -> str:
    start, end = f"<!--INLINE:{key}-->", f"<!--/INLINE:{key}-->"
    if start not in html or end not in html:
        sys.exit(f"index.html 里找不到 {start} … {end} 这对标记，页面结构可能被改坏了。")
    i = html.index(start) + len(start)
    j = html.index(end)
    return html[:i] + "\n" + body + "\n" + html[j:]


def build(html: str) -> str:
    css = read(CSS)
    html = fill(html, "css", f"<style>\n{css}\n</style>")

    data = "<script>window.__INLINE_DATA__=true;</script>\n" + "".join(
        f'<script>/* {rel} */\n{esc(read(rel))}\n</script>\n' for rel in DATA
    )
    html = fill(html, "data", data.rstrip())

    html = fill(html, "app", f"<script>/* {APP} */\n{esc(read(APP))}\n</script>")
    return html


def main() -> None:
    ap = argparse.ArgumentParser(description="内联构建 index.html")
    ap.add_argument("--check", action="store_true", help="只检查，不写文件")
    args = ap.parse_args()

    html = PAGE.read_text(encoding="utf-8")

    if args.check:
        left = EXTERNAL.findall(html)
        if left:
            print(f"⚠️ 存在 {len(left)} 处外部引用，单独打开会丢样式/脚本：")
            for x in left[:5]:
                print("   ", x[:90])
            sys.exit(1)
        print("✅ 自包含，无外部引用")
        return

    out = build(html)
    PAGE.write_text(out, encoding="utf-8")

    kb = PAGE.stat().st_size / 1024
    left = EXTERNAL.findall(out)
    print(f"已更新：{PAGE}")
    print(f"体积：{kb:.0f} KB   " + ("✅ 自包含" if not left else f"⚠️ 仍有外部引用 {left}"))


if __name__ == "__main__":
    main()
