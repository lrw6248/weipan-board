# 微盘抄底信号看板

一个纯静态的数据看板：每天收盘后自动抓取东财真实截面，算出三条信号（微盘 PB / 做多信号 / 扩散指数），画在一张全景图上，并给出「今天是不是抄底时刻」的状态判断。

**只报状态，不给动作。** 不构成投资建议。

---

## 怎么打开

| 方式 | 操作 |
|---|---|
| 本地 | 双击 `index.html`（Chrome / Edge / Safari 均可，无需服务器） |
| 线上 | 推到 GitHub 仓库并开启 Pages，访问 `https://<用户名>.github.io/<仓库名>/` |
| 手机 / 微信 | 直接把 `index.html` 这一个文件发过去，点开即可 |

`index.html` 是**自包含**的：样式、脚本、数据全部内联在这一个文件里，约 520 KB。
所以它不依赖同目录的任何文件，复制到哪、发给谁都能正常显示。
`assets/` 与 `data/` 是**源码与原始数据**，供维护用；页面里的内联副本由
`python scripts/build_page.py` 生成（`run.sh` / GitHub Actions 每天自动跑一次）。

> 不要手工改 `index.html` 里 `<!--INLINE:xxx-->` 那三块内容，下次构建会被覆盖。
> 改样式去 `assets/css/style.css`，改逻辑去 `assets/js/app.js`，改完跑一次 `build_page.py`。

页面打开后，数据每天自动更新；本地文件需运行更新脚本（见下）。

## 目录结构

```
.
├── index.html                  # 唯一页面：样式 + 逻辑 + 数据全部内联（可单独传播）
├── assets/                     # 源码（改这里，再跑 build_page.py 内联进 index.html）
│   ├── css/style.css           # 全部样式
│   └── js/app.js               # 全部交互与绘图
├── data/                       # 数据（脚本生成，勿手改）
│   ├── data.js / data.json     # 当日指标 + 逐日 PB 历史
│   ├── bt_data.js              # 星级回测序列与统计
│   ├── extra_hist.js / .json   # 扩散指数、成交额、市值历史
│   ├── backtest.json           # 回测统计（bt_data.js 的同源 JSON）
│   ├── star_history.csv        # 逐日 两套星级 / 净值 / 收益
│   ├── history_real.csv        # 逐日微盘 PB（东财真实截面）
│   ├── history.csv             # 每日运行累积的 PB
│   ├── cons_cache.json         # 四只宽基成分股名单缓存
│   └── .trade_days.json        # 交易日历缓存
├── scripts/                    # 数据管线（Python）
│   ├── update_data.py          # 抓当日行情，算四个指标 → data.js
│   ├── backtest_real.py        # 星级有效性回测 → bt_data.js
│   ├── backfill_real.py        # 补齐历史 PB 截面 → history_real.csv
│   ├── backfill_extra.py       # 补齐扩散指数 / 市值 → extra_hist.json
│   ├── backfill_amount.py      # 补齐成交额 → extra_hist.json
│   ├── build_page.py           # 把样式/脚本/数据内联进 index.html
│   └── backfill_akshare.py     # 备用数据源（AkShare）
├── docs/
│   ├── 使用说明.md              # 给使用者：每个位置怎么看、怎么更新
│   └── AI_HANDOFF.md           # 给 AI / 开发者：数据契约、算法、雷区
├── .github/workflows/daily.yml # 每个交易日 16:00 自动更新并发布
├── run.sh / 一键更新.bat        # 本地一键更新（Mac/Linux / Windows）
├── requirements.txt
└── config.example.json         # 微信推送配置样例（复制为 config.json）
```

## 每天怎么更新

**Windows**：双击 `一键更新.bat`
**Mac / Linux**：`./run.sh`

约 20 秒完成（首次需装依赖、回填历史，约 2–3 分钟）。也可以让 GitHub Actions 每天自动跑，见 `.github/workflows/daily.yml`。

## 三条信号

| 条件 | 判定 | 含义 |
|---|---|---|
| 微盘 PB | PB < 2.0 | 绝对估值低 |
| 做多信号 | ≥ 3 星（满分 5，半星一档） | 相对估值低（纵向 + 横向共 9 个参照系） |
| 扩散指数 | < 20% | 情绪冰点（站上 20 日均线的成分股占比） |

三项全亮 = 原作者定义的「抄底时刻」。

## 数据来源

全部为免费公开接口：东方财富历史估值明细、中证指数成分股、新浪财经行情。微盘 PB 为「最小 400 只等权调和平均」口径，与行情软件直接给出的指数 PB 不同。

## 免责声明

仅为数据展示工具，不构成任何投资建议。历史回测不代表未来表现；微盘股波动大，请独立判断。
