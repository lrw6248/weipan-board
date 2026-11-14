@echo off
chcp 65001 >nul
cd /d "%~dp0"
echo ==================================================
echo    微盘抄底信号看板 - 每日数据更新
echo ==================================================
echo.
python --version >nul 2>&1
if errorlevel 1 (
  echo [提示] 未检测到 Python。
  echo 请先到 https://www.python.org/downloads/ 下载安装 Python 3.9 以上版本，
  echo 安装时务必勾选 "Add Python to PATH"，然后重新双击本文件。
  echo.
  pause
  exit /b 1
)
python -c "import requests" >nul 2>&1
if errorlevel 1 (
  echo 首次运行，正在安装免费依赖（只需一次，约 1 分钟）...
  python -m pip install -r requirements.txt -q
)
echo 正在增量补齐真实历史截面（东财免费，通常 1-2 秒）...
python scripts\backfill_real.py --workers 5
echo.
if not exist data\extra_hist.json (
  echo 首次运行，正在回填扩散指数近一年，约 15 秒...
  python scripts\backfill_extra.py
  echo 正在回填成交额近 5 年历史，约 40 秒...
  python scripts\backfill_amount.py
  echo.
)
echo 正在拉取行情并计算四个指标，约 20 秒...
echo.
python scripts\update_data.py
if errorlevel 1 (
  echo.
  echo [失败] 更新未完成，通常是网络波动，稍后重试即可。
) else (
  echo.
  echo 正在刷新文章结论表的复核数据（首次约 2-3 分钟，之后约 10 秒）...
  python scripts\backtest_real.py --workers 5
  echo.
  echo 正在把样式、脚本、数据内联进 index.html ...
  python scripts\build_page.py
  echo.
  echo [完成] 看板已更新：index.html（含文章结论表）
  echo        index.html 已自包含：单独发到手机也能正常显示
  echo 页面开着的话按一下「刷新数据」即可重新读取。
)
echo.
pause
