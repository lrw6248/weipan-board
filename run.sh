#!/usr/bin/env bash
cd "$(dirname "$0")" || exit 1
echo "=================================================="
echo "   微盘抄底信号看板 - 每日数据更新"
echo "=================================================="
if ! command -v python3 >/dev/null 2>&1; then
  echo "[提示] 未检测到 Python 3，请先安装：https://www.python.org/downloads/"
  read -r -p "按回车键退出..." _; exit 1
fi
if ! python3 -c "import requests" >/dev/null 2>&1; then
  echo "首次运行，正在安装免费依赖（只需一次，约 1 分钟）..."
  python3 -m pip install -r requirements.txt -q
fi
echo "正在增量补齐真实历史截面（东财免费，通常 1-2 秒）..."
python3 scripts/backfill_real.py --workers 5 || echo "[提示] 历史补齐跳过，不影响当日数据（可稍后重跑）"
echo
if [ ! -f data/extra_hist.json ]; then
  echo "首次运行，正在回填扩散指数近一年（约 15 秒）..."
  python3 scripts/backfill_extra.py || echo "[提示] 回填跳过，看板仍可使用（扩散曲线暂缺）"
  echo "正在回填成交额近 5 年历史（约 40 秒）..."
  python3 scripts/backfill_amount.py || echo "[提示] 成交额回填跳过，看板仍可使用"
  echo
fi
echo "正在拉取行情并计算四个指标，约 20 秒..."
python3 scripts/update_data.py "$@"
echo
echo "正在刷新文章结论表的复核数据（首次约 2-3 分钟，之后约 10 秒）..."
python3 scripts/backtest_real.py --workers 5 || echo "[提示] 星级回测跳过，不影响主看板数据"
echo
echo "正在把样式、脚本、数据内联进 index.html（约 1 秒）..."
python3 scripts/build_page.py || echo "[提示] 内联跳过，index.html 可能是旧数据，可稍后重跑"
echo
echo "[完成] 看板已更新：index.html（含文章结论表）"
echo "       index.html 已自包含：单独发到手机 / 在对话框里点开都能正常显示"
read -r -p "按回车键退出..." _
