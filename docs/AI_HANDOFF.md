# AI 交接文档 · 微盘抄底信号看板

> 用途：让下一个接手的人或模型，在不读 2400 行代码的情况下，能安全地改这个看板。
> 阅读顺序：§0 速览 → §5 口径雷区（最容易改错的地方）→ §6 改动流程。
> 当前版本：**v26.8**（页头右上角 `版本 v26.8` 就是它）。

---

## 0. 30 秒速览

- 纯静态单页：`index.html` + `assets/css/style.css` + `assets/js/app.js`，无框架、无构建、无 npm。
- 数据由 Python 脚本生成成 `data/*.js`（`window.XXX = {...}`），页面用 `<script src>` 直接读，`file://` 双击即可打开。
- 页面只有四张卡：**今日信号**（三条条件 + 两个折叠面板）、**全景图**（六个面板的 SVG）、**信号提醒**（浏览器通知）、**数据与更新**（手动录入 / 导入导出）。
- 三条信号：`微盘PB < 2.0`、`做多信号 ≥ 3 星`、`扩散指数 < 20%`。
- 只有一个刻度：**星**（0–5，半星一档）。历史上曾同时存在「分」，已废弃，不要再引入。

---

## 1. 目录与数据流

```
东财/中证/新浪 免费接口
   │
   ├─ scripts/backfill_real.py   → data/history_real.csv        逐日微盘 PB（2018 起）
   ├─ scripts/backfill_extra.py  → data/extra_hist.json         扩散指数/市值（约 260 天）
   ├─ scripts/backfill_amount.py → data/extra_hist.json         成交额（约 5 年）
   │
   ├─ scripts/update_data.py     → data/data.js + data/data.json 当日四指标 + 逐日 PB
   │                              → data/extra_hist.js           （由 json 转 js）
   └─ scripts/backtest_real.py   → data/bt_data.js + data/backtest.json + data/star_history.csv
                                    逐日星级序列 + 分档统计

index.html ──读──> data/data.js, data/bt_data.js, data/extra_hist.js
     └─ assets/js/app.js
```

运行顺序（`run.sh` / `一键更新.bat` / `daily.yml` 都是这个顺序）：

1. `backfill_real.py`（增量补历史 PB）
2. `backfill_extra.py` / `backfill_amount.py`（**仅当 data/extra_hist.json 不存在**时）
3. `update_data.py`（算当日，写 data.js）
4. `backtest_real.py`（重算逐日星级与回测，写 bt_data.js）

脚本里的路径约定：`ROOT = scripts/..`，`DATA = ROOT/"data"`，`BASE = DATA`。**新增文件请写进 `data/`，不要写回仓库根目录。**

---

## 2. 数据契约

### 2.1 `BOARD_DATA`（data/data.js）

| 字段 | 类型 | 说明 |
|---|---|---|
| `date` | `"YYYY-MM-DD"` | 行情日期，页面「数据日期」 |
| `updated_at` | `"YYYY-MM-DD HH:mm"` | 脚本运行时间 |
| `micro_pb` | number | 微盘 PB（400 只等权调和平均） |
| `signal` | number | 做多信号星级，**自有口径**，0.5 步进 |
| `diffusion` | number | 扩散指数 %（0–100） |
| `avg_mv` / `median_mv` | number | 平均 / 中位市值（亿） |
| `amount` | number | 成交额（亿） |
| `q25` | number | 近 1800 日 PB 的 25% 分位线 |
| `thresholds` | `{pb,signal,diffusion}` | 2.0 / 3.0 / 20.0 |
| `signal_detail` | object | 9 个参照系：`{名称:{value, ok}}`。`ok=true` 表示「微盘 PB 低于它」，得星 |
| `lights` | `{pb,signal,diffusion}` | 三条是否成立（布尔） |
| `light_count` | 0–3 | 成立条数 |
| `verdict` | `{title,...}` | 结论卡文案 |
| `history` | `[{date,pb,source}]` | 逐日 PB，**到 date 当天**（2149 条） |

`signal_detail` 的 9 个键（顺序即页面三列顺序）：
`纵向(近1800日25%分位)`、`巨盘(1-300)`、`大盘(301-800)`、`中盘(801-1800)`、`小盘(1801-3800)`、`沪深300`、`中证500`、`中证1000`、`中证2000`。
分组规则：`纵向` → Ⅰ 列；含`巨/大/中/小盘` → Ⅱ 列；其余 → Ⅲ 列。
得星：纵向 1 星，其余每个 0.5 星。**微盘 400 只不在 Ⅱ 的四段里**（四段只覆盖最大的 3800 只）。

### 2.2 `BT_DATA`（data/bt_data.js）

| 字段 | 说明 |
|---|---|
| `meta` | `{start,end,days,source,price,star_rule_article,star_rule_original,caveats[]}`；`end` 通常比 `BOARD_DATA.date` 早一天 |
| `series` | 逐日 `[{d,p,q,s,o,n}]`，2148 条 |
| `by_star` | 原文口径分档统计，键 `0`–`5`，`{days,share,h5..h120:{n,avg,win,excess}}` |
| `triggers` | 四档触发（升破口径）：`[{label,times,h5..h120,detail[]}]` |
| `combos` | 组合条件（仅星级≥3 / 叠加 PB<2 / 叠加扩散） |
| `spearman` | 星级与未来涨幅的秩相关 `{5,10,20,60,120}` |
| `zero_defense` | 0 星对照 `{days,h20,h60,h120}` |
| `five_star_days` | 5 星日期列表（32 天） |
| `star_distribution_orig` | **原版口径**（0.5 步进）按 `round()` 分桶，**不是** `by_star` 的天数，两者不可比 |

`series` 每行：

| 键 | 含义 |
|---|---|
| `d` | 日期 |
| `p` | 当日微盘 PB |
| `q` | 当日 1800 日 25% 分位线 |
| `s` | **原文口径**星级：纵向 +1，低于 8 个指数各 +0.5，满分 5；整数/半星 |
| `o` | **本看板口径**星级：纵向 +1，低于 8 个对象各 +0.5（同 `s`，但由本仓库逐日重算，含半星） |
| `n` | 自建 400 只等权组合净值（t 日选股、t+1 持有，累乘） |

> `s` 与 `o` 在多数日子相同，但**不要当成同一个字段**。页面主表（档位历史）用 `o`；`by_star`、`triggers`、`star_distribution_orig` 用 `s`（原文口径）。混用会导致天数对不上。

### 2.3 `EXTRA_HIST`（data/extra_hist.js）

| 字段 | 说明 |
|---|---|
| `diff` | `[[date, pct], ...]`，扩散指数，约 260 条 |
| `median` / `avg` | `[[date, 亿], ...]`，市值中位/平均 |
| `amount` | `[[date, 亿], ...]`，成交额 |

---

## 3. 核心算法

### 3.1 星级与档位键

```js
// 0.5 步进四舍五入
function sr(r){ return Math.round((r.o!=null?r.o:r.s)*2)/2; }

// 档位键：把连续星级映射到 8 个表格行
function tierKey(v, pb){
  var x=Math.round((v==null?0:v)*2)/2;
  if(x>=5) return "5";
  if(x>=4) return String(x);            // 4 / 4.5
  if(x>=3) return x===3 ? ((pb!=null&&pb<2)?"3pb":"3") : String(x); // 3 / 3.5
  if(x>=2.5) return "2.5";
  return "low";                          // 0–2 星合并
}
```

八行：`0–2 星` / `2.5` / `3` / `3 星+PB<2`（子集，缩进，不参与合计）/ `3.5` / `4` / `4.5` / `5`。
`3pb` 与 `3` **重叠**，只是筛出 PB<2 的那部分，任何时候都不要把它加进总数。

### 3.2 档位历史（`starRows` / `starCalc`）

对每一档，遍历 `series`，命中日 `i` 记 1 天；再取 `i+20 / i+60 / i+120` 的净值算收益：

```js
r = (S[i+h].n / S[i].n - 1) * 100;
```

样本不足（窗口未走完）不计入分母。所以「天数」与「120 日样本数」不同，这是正常的（如 0–2 星 1551 天、120 日样本 1477）。

结果缓存在 `STAR_ROWS`，**数据更新后必须置空**（`applyData` 里已处理）。

### 3.3 「当前状态」的连续天数（v26 修正点）

```js
var over = (cv >= 3);   // 状态行写的是 ≥3 星 / <3 星
var dstar = countBack(S, function(x){
  return (((x.o!=null?x.o:x.s) >= 3) === over);   // 数「同侧于 3 星线」
});
```

**不要**改成 `tierKey(...) === ck`（数「同一档」）。v25 就是数了同档，当天 2.0 星、前一天 2.5 星，于是显示「已连续 1 个交易日」，而图上明明已经 64 天低于 3 星——用户一眼看出矛盾。
条件 1（PB）和条件 3（扩散）本来就是「数同侧」，一直是对的。

### 3.4 深跌（`deepLows`）

基于 `series.n` 净值回撤：

- 回撤 ≤ **−16%** 起算一段；
- 回撤收窄回 **−7%** 以内，该段结束；
- 段内最低点为 `trough`，记录 `mdd`、后续 20/60/120 日收益；
- 最后一段未收窄 = `open`，页面显示「深跌修复期 · 距低点 +x%」。

### 3.5 星级构成（`renderBreakdown`）

Ⅰ 列 1 项（1 星）+ Ⅱ 列 4 项（各 0.5）+ Ⅲ 列 4 项（各 0.5），合计 = `d.signal`。
每列标题「N 项 · X 星」**由数据现算**（`bhItemA/B/C`），v25 曾写死「4 项 · 2 星」，与实际 0.5 星矛盾。

---

## 4. 页面结构与关键 DOM

| 区块 | 关键 id | 说明 |
|---|---|---|
| 条件行 | `cs1/cs2/cs3`、`cs1v/cs2v/cs3v`、`cs1d/cs2d/cs3d` | 状态值 + 连续天数 |
| 条件 2 星级按钮 | `val2` > `val2st` | 标题行右侧五颗星，点开构成面板 |
| 构成面板 | `sigPanel`、`sgKpi`、`bgA/bgB/bgC`、`bhItemA/B/C`、`sgSum` | 默认收起 |
| 档位面板 | `histPanel`、`stblRange`、`starTable`、`smNote` | 默认收起，与构成面板互斥；`stblRange` 写数据区间（取 `BT_DATA.meta.start/end/days`，故不要写死） |
| 打开入口 | `val2`、`cs2s`（状态行）→ 构成；`cs2w`（胜率小表）→ 档位 | `app.js` 末尾绑事件 |
| 全景图 | `pano`、`panoNow`、`.pr-btn[data-range]` | SVG 由 `PANO` 即时生成 |
| 深跌 | `ddNote`、`ddBody`、`ddRule` | |
| 数据区 | `fileState`、`btnRefresh`、`btnImport`、`btnExport` | |

`render()` 是总入口，依次调用：`renderStatus` → `renderBreakdown` → `renderStar` → `renderLadder` → `renderDeep` → `renderTriggers` → `PANO`。
新增渲染函数要挂进 `render()`，否则数据更新后不刷新。

---

## 5. 口径雷区（改之前必读）

| # | 错误做法 | 正确做法 |
|---|---|---|
| 1 | 写「2 星」「2.5 星」这种「数字+星」文字 | 画五颗星图标（`starHTML`），一个数字只出现一次 |
| 2 | 用 `tierKey` 同档天数当「<3 星」的天数 | 用「同侧于 3 星线」判定（§3.3） |
| 3 | 把 `by_star` 的天数当自有口径 | `by_star` 是原文口径（0/1/2 星分开）；自有口径是 `starRows()` 现算（0–2 合并 1551 天） |
| 4 | 把 0–2 星 1551 天与原文 1628 天互相核对 | 两套口径，永远不相等；页面上已注明「不要互相核对」 |
| 5 | 写「情绪冰点 < 20%」 | 「扩散指数 < 20% · 情绪冰点」：20% 是扩散指数的阈值，冰点是跌破后的叫法 |
| 6 | 写「高出 21.3%」 | 「高出 21.3 **个百分点**」：两个百分数相减是 pp，不是相对变化 |
| 7 | 把 `ART_ORIG`（原文 19 次 / +32.5%）与自建（10 次 / +47.3%）混在一句 | 原文数字只出现在「原文结论表」，并标注「原文口径」；quote 用 `btTrig()` 现取 |
| 8 | 文案里的统计数字写死 | 一律从 `BT_DATA` 取（`zero_defense`、`triggers`、`baseline`） |
| 9 | 认为 `series` 与 `BOARD_DATA.date` 同一天 | `series` 通常早一天（回测截面入库晚一天）；页面已在「数据与更新」注明 |
| 10 | 用 `#` 十六进制给板块标题上色 | 标题不用彩色竖条；用卡片顶部浅底标题带（`#EDF3FC`），不与数据色抢 |
| 11 | 在三张卡的标题行旁写阈值或状态（「绝对估值达标」「< 2.0 达标线」「目标 < 2.0」） | 标题行那句灰字**只解释指标本身**：`绝对估值 · 市净率` / `相对估值 · 分档评分` / `市场情绪 · 均线占比`。理由：右侧已有当前值、下方已有「当前状态」，标题行再写阈值/结论必然重复；而「达标线」是生造名词，既不是规则也不是状态，读者读不出想表达什么。阈值信息的落点是——① 脚下「高出阈值 0.011」；② 当前状态行「PB > 2.0」；③ 进度条上的达标刻度。 |
| 12 | 调 `#pano` 的 SVG 绘制顺序 | 面板白底 `<rect fill="#FDFEFF" fill-opacity=".72">` 必须画在**深跌紫带之前**。白底在上面会把紫带压掉 72%，深跌区间就"消失"了（v26.4 修过） |

**颜色语义（不要挪用）**：橙 `#E9611F` = 微盘 PB；蓝 `#2D6BE4` = 做多信号/星；绿 `#0E9F6E` = 扩散指数；灰蓝 `#5C6B80` = 成交额；棕 `#92400E` = 市值；紫 = 深跌。

---

## 6. 改动工作流

### 6.1 只改文案
改 `index.html`（结构/静态文案）或 `assets/js/app.js`（动态文案）。
**改完必须核对文案里的数字是否来自数据**（§5-8）。

### 6.2 改样式
只动 `assets/css/style.css`。断点：`1120 / 900 / 700 / 560 / 420`（媒体查询），主要测 1280 / 768 / 390 / 360。

### 6.3 改算法
动 `app.js` 的 `starRows / tierKey / starCalc / deepLows` 之一时：

1. 先用 Node 独立复算一遍（不要只信页面）；
2. 改完清 `STAR_ROWS` 缓存；
3. 跑 §7 的回归；
4. 在本文档 §8 记一条版本历史。

### 6.4 发版
1. 改 `index.html` 的 `<span id="verChip">` 版本号 + `title`（一句话说明这版改了什么）；
2. 同步 `docs/使用说明.md` 里的「版本 vXX」两处；
3. 重打压缩包（文件清单见 §9）；
4. 交付：`index.html`、压缩包、使用说明。

---

## 7. 测试（必跑）

环境：`/usr/bin/chromium` + `puppeteer-core`（沙箱已装）。

```js
// /tmp/pp/regress.js —— 六档宽度 + 交互 + 报错
const puppeteer=require('puppeteer-core');
(async()=>{
  const b=await puppeteer.launch({executablePath:'/usr/bin/chromium',args:['--no-sandbox','--disable-gpu']});
  for(const w of [1280,1024,900,768,390,360]){
    const p=await b.newPage(); const err=[];
    p.on('pageerror',e=>err.push(e.message));
    p.on('console',m=>{if(m.type()==='error')err.push(m.text())});
    p.on('requestfailed',r=>err.push('404 '+r.url()));
    await p.setViewport({width:w,height:1000});
    await p.goto('file:///workspace/index.html',{waitUntil:'load'});
    await new Promise(r=>setTimeout(r,1200));
    const a=await p.evaluate(()=>({
      sw:document.documentElement.scrollWidth, iw:innerWidth,
      s2:document.getElementById('cs2v').textContent+' '+document.getElementById('cs2d').textContent,
      kpi:document.querySelector('#sgKpi .v').textContent.trim(),
      paths:document.querySelectorAll('#pano svg path').length
    }));
    await p.evaluate(()=>document.getElementById('val2').click());
    await new Promise(r=>setTimeout(r,350));
    const open=await p.evaluate(()=>document.getElementById('sigPanel').classList.contains('open'));
    console.log(w,JSON.stringify({...a,open,err}));
    await p.close();
  }
  await b.close();
})();
```

**通过标准**：`err` 为空；`sw === iw`（无横向溢出）；`open === true`；`paths > 0`；`s2` 与 KPI 与数据一致。

必须人工看的三张截图：1280 卡片、390 卡片、390 档位表（表头 + 8 行不错位）。

**改了 `assets/` 下的 CSS 或 JS 后，必须重跑 `python scripts/build_page.py`**，
否则 index.html 里还是旧的内联副本（`build_page.py --check` 能查出残留外链）。

**自包含验收（每次发版必做）**：把 `index.html` 单独拷到**空目录**（如 `/tmp/onlyone/`），
以 `file://` 打开。若还依赖外部文件，立刻退化成纯文字。检查项：
`err` 为空、`requestfailed` 为空、资源请求只有 `index.html` 一条、
`.card` 的 `padding` 不为 0（CSS 生效）、`#ringN` 有数值（JS 生效）、
`#pano svg path` = 12、`document.body.scrollWidth === clientWidth`。

---

## 8. 版本历史（只记改了什么，不记过程）

| 版本 | 改动 |
|---|---|
| v17 | 全页统一为「星」（半星一档），历史表按新口径重算 |
| v18 | 两个折叠面板拆开；状态行去掉重复星级 |
| v19 | 星级挪回标题行右侧（图标）；箭头改 SVG；历史表现加标题 |
| v20 | 三个条件名改专有名词；`pp` 改「个百分点」 |
| v21–v23 | 板块标题：竖条 → 石墨 → 文字 → 浅底标题带（最终方案） |
| v24 | 当前状态去掉重复数值，只写判定关系 |
| v25 | 灰字改「判定式 · 含义」；条件 2 加 `<3 星`；六面板细框；默认近 6 个月 |
| **v26** | **修 3 处数据错**：①连续天数改「同侧于 3 星线」（1 天→64 天）；②「4 项 · 2 星」写死→现算（实为 0.5 星）；③`−4.24%` / `t=−8.6` / `+32.5%` / `19 次` 等旧静态数字→取 `BT_DATA`。另：深跌面板 `% %` 重复、顶部「2 星」改星级图标、**目录按静态站点规范重组（assets/data/scripts/docs）** |
| **v26.1** | ~~新增单文件版打包~~（已废弃：多造了一份要维护的文件，方向错了） |
| **v26.2** | **修 v26 的回归**：CSS 与 app.js 曾被拆成外链，导致单独打开 index.html 只剩纯文字。现由 `build_page.py` 内联成自包含页面（520 KB），删除 `看板-单文件版.html` 与 `build_single.py` |
| **v26.3** | `#histPanel` 档位表顶部加「数据区间 2018-01-02 → 2026-11-11 · 逐日 2148 个交易日 · 末端不足 N 天不计入」，区间取 `BT_DATA.meta`（缺失时回落到 series 首末）；`0–2 星合计 N 天` 改为现算（`by_star` 0+1+2） |
| **v26.4** | ①档位表区间行改浅底小条（原来 8.3px 灰字太弱，看不见）；②深跌紫带移到面板白底**之上**、不透明度 5.5%→13%；③三张卡的「绝对估值达标 / 相对估值达标 / 情绪冰点」改为「达标线 / 冰点线」，避免读成当前状态（数据：PB 2.011、2 星、扩散 41.3%，三项均未成立） |
| **v26.5** | 三张卡标题行灰字由「< 2.0 达标线 / ≥ 3 星 达标线 / < 20% 冰点线」改为解释指标的短语（`绝对估值 · 市净率` / `相对估值 · 分档评分` / `市场情绪 · 均线占比`），并加 `title` 写全阈值规则；星级面板刻度「3 星 达标线」→「3 星 达标」。全页不再出现「达标线」 |
| **v26.6** | ①文档纠错：Pages 实际用「分支发布」，`使用说明.md` 里仍写着「必须选 GitHub Actions」，与线上配置矛盾（改文档，并在 9.2 记录）；②桌面端整体放大 `zoom:1.2`（版式按 1x 屏排，7.4–9px 的刻度/表头/口径说明在实机上偏小），手机端不受影响；③微信推送标题改为 `微盘信号 N/3 · 结论文案`，正文重排为「已满足 / 未满足」两组并逐条写明差距；④推送数值改用 HALF_UP 舍入，与页面 `toFixed(1)` 一致（原先 41.25 会推 41.25/差 21.2，页面却是 41.3/差 21.3） |
| **v26.7** | 字号整体上调：`font-size` 全量重算（≤8.4px 档 ×1.16 且下限 9.4px，≤11.5px 档 ×1.10，≤16px 档 ×1.05，大标题不动）；桌面 `body{zoom}` 按屏宽分档 1.26 / 1.34 / 1.46 / 1.60；窄屏补 `.c-line{flex-wrap:wrap}` 与 `.tbl-wrap{overflow-x:auto}` 防溢出 |
| **v26.8** | 新增**飞书自定义机器人**推送：`feishu_card()` 生成卡片（顶部色条随灯数变红/橙/灰，正文分「已满足 / 未满足」并逐条写差距），`push_feishu()` 支持签名校验；`config.example.json` 加 `feishu_webhook` / `feishu_secret`，`daily.yml` 注入同名 Secrets；`使用说明.md` 补飞书接入 6 步 |

---

## 9. 打包清单（zip 内保持同一结构）

```
index.html  README.md  run.sh  一键更新.bat  requirements.txt  config.example.json  .gitignore
assets/css/style.css
assets/js/app.js
data/{data.js,data.json,bt_data.js,extra_hist.js,extra_hist.json,backtest.json,
      star_history.csv,history_real.csv,history.csv,cons_cache.json,.trade_days.json,.last_state.json}
scripts/{update_data.py,backtest_real.py,backfill_real.py,backfill_extra.py,backfill_amount.py,build_page.py,backfill_akshare.py}
docs/{使用说明.md,AI_HANDOFF.md}
.github/workflows/daily.yml
```

`data/.last_state.json` **必须入库**（否则每天重复推送）；`config.json` 与 `data/.bt_cache/` **不能入库**。

### 9.1 index.html 必须自包含（硬约束，别改回去）

`index.html` 会被**单独打开**：在对话框里点开预览、发到微信、拖进浏览器窗口。
这些场景只有 html 本体过去，同目录的 `assets/`、`data/` 不一定跟走。
所以样式、脚本、数据必须内联在这一个文件里（约 520 KB）。

**2026-11-14 事故**：v26 为了"目录规范"把 CSS 与 app.js 拆成
`<link rel="stylesheet" href="assets/css/style.css">` 与 `<script src="assets/js/app.js">`，
index.html 从 138 KB 掉到 25 KB。结果页头、卡片、圆环、曲线全部消失，
只剩一屏没有排版的文字（`.card` 的 padding 变成 0、`h1` 回到 32px 默认值）。
同一个 html 在 `file://` 下用 Chromium 打开是好的，所以自动化测试没抓到。

**现行做法**：源码仍在 `assets/` 与 `data/`，由 `scripts/build_page.py` 内联成 `index.html`。
页面里有三对标记，构建时整段替换，脚本幂等可反复跑：

```
<!--INLINE:css-->    ← assets/css/style.css
<!--INLINE:data-->   ← data/data.js + bt_data.js + extra_hist.js（前面注入 __INLINE_DATA__）
<!--INLINE:app-->    ← assets/js/app.js
```

> **不要手改这三个块里的内容**，下次构建会被覆盖。改 `assets/`，再跑 `python scripts/build_page.py`。

`app.js` 里三处读 `window.__INLINE_DATA__`（构建时注入的标记），改代码时别破坏：

| 位置 | 行为 |
|---|---|
| `pollData()` 开头 | 直接 return，不发 `data/*.js` 请求（单文件打开必 404） |
| `btnRefresh` | 改为 `location.reload()`，重新读取已内联的数据 |
| 顶层 IIFE | 隐藏「检查信号」按钮（没有联网检查这回事了） |

**验收方式**：把 `index.html` 拷到**空目录**，`file://` 打开。
只要还依赖任何外部文件，立刻退化成纯文字。检查 `window.performance.getEntriesByType('resource')`
只应有 `index.html` 一条；`.card` 的 padding 非 0；`#ringN` 有数值；`#pano svg path` = 12。

---

### 9.2 线上部署：Pages 走「分支发布」，不是 Actions 发布

仓库 `lrw6248/weipan-board`（public），默认分支 `main`。
Pages 配置：`Settings → Pages → Source = Deploy from a branch`、`Branch = main`、目录 `/ (root)`。

**发布链路**：Actions 每天跑完 → `build_page.py` 重新内联 → commit `index.html` → push `main` → Pages 检测到新提交 → 约 1 分钟重建。

为什么不用 `actions/deploy-pages`：

- 它要求 `configure-pages` + `upload-pages-artifact` + `deploy-pages` 三步全绿，任一数据脚本失败整条 job 就失败，站点停在旧版本；首次运行失败直接 404。
- 分支发布只要 `index.html` 进了 `main` 就上线，数据抓取失败也照旧在线（只是数据慢一天）。
- 少两层权限配置（`environment`、`id-token`）。

**坑**：用 `GITHUB_TOKEN` 推送的提交，Pages 不一定会自动重建。所以 workflow 末尾有一句显式
`POST /repos/{repo}/pages/builds`（`continue-on-error`，Pages 未开启时 404，不影响数据提交）。

> ❌ 不要在文档里写「Source 必须选 GitHub Actions」。那是 2026-11 之前的老方案，已废弃；
> 改回去会和 `daily.yml` 里的 push 步骤打架，也会要求工作流每一步都不能失败。

---

## 10. 已知问题 / 待办

1. **序列晚一天**：`bt_data` 的 `end` 通常比 `BOARD_DATA.date` 早一天（回测截面入库晚）。深跌天数、连续星级天数都少 1 天。页面已注明，未强行补数（补一天需要重算 400 只组合当日收益，成本高、易错）。
2. **扩散指数只有约 260 天**：免费接口无法回溯全市场 MA20，所以 2025-10 之前为空；全景图那行留白并标「无历史数据」。
3. **`star_distribution_orig` 与 `by_star` 天数不同**：前者按 `round(star_orig)` 分桶（0.5 会被银行家舍入），后者按文章口径整数星。前者目前未在页面使用，保留作审计。
4. **`ART_ORIG` 是原文静态数字**（19 次 / +32.5% 等），与自建复核不同，只用于「原文结论表」，勿混。
5. 手机端档位表用 grid 显式定位 7 个单元格；改列数必须同步 `style.css` 里 `@media(max-width:700px)` 的 `.stbl tbody tr` 规则，否则会错行。

---

## 11. 字号与缩放规范（改字前先读）

版式按 **1200px 设计宽度**排，原始字号最小只到 6.8px，在实机上读不清。现规则：

| 屏幕宽度 | `body{zoom}` | 说明 |
|---|---|---|
| < 900 | 1 | 手机/平板，靠媒体查询适配，不缩放 |
| 900–1199 | 1.26 | 小笔记本 |
| 1200–1599 | 1.34 | 主流笔记本（1280 / 1440） |
| 1600–1999 | 1.46 | 大显示器 |
| ≥ 2000 | 1.60 | 宽屏 |

字号本身的换算（`assets/css/style.css` 里 189 处 `font-size`）：

```
原始值 ≤ 8.4px  →  max(原值 × 1.16, 9.4px)   刻度 / 表头 / 口径说明，硬下限 9.4
原始值 ≤ 11.5px →  原值 × 1.10                小字与正文
原始值 ≤ 16px   →  原值 × 1.05                小标题
其余            →  不动                        大标题（24 / 25 / 34 / 41）
```

**两条硬约束**：

1. **不要出现小于 9.4px 的 `font-size`**。再往下在 1440 笔记本上就是 12px 以下物理像素，用户已经提过两次看不清。
2. **改字号后必须复测 320 / 360 / 390 三档**。字号是全局的，桌面放大同时会挤压手机端。窄屏当前靠两处兜底：
   - `.c-line{flex-wrap:wrap}`（≤560px）—— 标题行挤不下时折行，不横向溢出
   - `.tbl-wrap{overflow-x:auto}` —— 折叠面板里的表格在容器内横滚，不撑破页面

> 改完跑：`python scripts/build_page.py`，然后 `node /tmp/pp/mob.js`（四档窄屏）+ `node /tmp/pp/zoom2.js`（八档桌面）。

---

## 12. 推送渠道（飞书 / 微信 / 邮件）

`scripts/update_data.py::push_notify()` 一处分发，三个渠道互不依赖，**填了哪个就走哪个**。

| 渠道 | 函数 | 凭据 | 形态 |
|---|---|---|---|
| 飞书 | `push_feishu()` / `feishu_card()` | `feishu_webhook`、`feishu_secret`（可选） | 消息卡片 |
| 微信 | 内联 | `serverchan_sendkey` | markdown |
| 邮件 | 内联 | `email.{smtp,port,user,password,to}` | 纯文本 |

**触发条件**（`push_notify` 开头）：`prev is None`，或任一灯状态发生变化，或 `light_count >= 3`。状态没变不推。

**飞书卡片要点（改之前必读）**

- 只用 `header.template` + `body.elements[].tag = "markdown"` 两种能力，**不碰** `hr` / `fields` / `note` / `column_set`。卡片 1.0 与 2.0 客户端都能渲染，不会因 schema 差异变成空白卡片。
- `header.template` 按灯数取色：3 → `red`、1–2 → `orange`、0 → `grey`。
- 签名算法：`HMAC-SHA256(key = f"{timestamp}\n{secret}", msg = "")` 再 base64 —— **消息体为空**，不是对卡片 JSON 签名。本实现已与飞书文档 Python 示例逐字节比对一致（`secret=demo, ts=1599360473 → l1N0gAcBjdwBvGm1xMjOF0XSyaLRpR7tuO5dHfhAYc8=`）。
- 成功判定看 `code == 0`（`StatusCode` 是兼容旧逻辑的冗余字段）。签名过期返回 `19021`，`timestamp` 超过 1 小时即失效。
- 请求体上限 20 KB，当前卡片约 1 KB。

**不要做的**

- ❌ 不要把 `feishu_webhook` 写进任何入库文件（`config.json` 已在 `.gitignore`）。线上走 Secrets：`FEISHU_WEBHOOK` / `FEISHU_SECRET` / `SERVERCHAN_SENDKEY`，由 `daily.yml` 的「写入推送密钥」步骤拼成 `config.json`。
- ❌ 不要在飞书卡片里塞 HTML 表格或超长段落——客户端宽度不可控，窄屏会挤成一团。

---

## 13. 禁止事项

- ❌ 不要删除 `data/` 下任何文件；不要手改 `data/*.js`（下次更新会被覆盖）。
- ❌ 不要引入构建工具 / 框架 / npm 依赖——这个项目要在 `file://` 下双击能开。
- ❌ 不要写出小于 **9.4px** 的 `font-size`；加字号后必须复测 320 / 360 / 390（见第 11 节）。
- ❌ 不要在文案里写死统计数字（除 `ART_ORIG` 这类明确标注「原文口径」的引用）。
- ❌ 不要恢复「分」这个第二套刻度。
- ❌ 不要给板块标题加彩色竖条 / 色块（会与数据色语义冲突）。
- ❌ 不要把 CSS / JS / 数据改回 `<link>` 或 `<script src>` 外链——index.html 必须自包含，违者页面在对话框与手机上会退化成纯文字（见 9.1）。
- ❌ 不要在未确认的情况下推翻用户明确说过的偏好（如「不要数字+星」「不要竖条」）；有更好的方案先问。
