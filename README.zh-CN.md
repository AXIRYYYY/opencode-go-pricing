<div align="center">

# OpenCode Go · 模型价格速查

**在线使用：<https://axiryyyy.github.io/opencode-go-pricing/>**

[English](README.md)

</div>

一个零依赖的单文件网页，自动整理 [OpenCode Go](https://opencode.ai/docs/zh-cn/go/) 全部模型每 1M tokens 的价格与每月使用额度，按价格从便宜到贵排序，并用不同颜色区分模型系列。

> 非官方社区工具，与 OpenCode 无关。数据全部来自官方文档，本页面仅做聚合展示。

## 功能

- 每次打开自动同步官方最新数据（GitHub raw → jsDelivr 镜像 → ghproxy/gh-proxy/ghfast 镜像，多级兜底）
- **默认按「输出列的月费折算价」从小到大排**（单价 ÷ 每月额度 × $10）；手动切过的会记住你的选择
- 点击任意列头切换排序；支持搜索
- 13 个模型系列各一色，图例可点击筛选
- DeepSeek 高峰/低峰档自动标色，多档价（≤ 200K / > 200K 等）逐行展示；顶部实时显示当前生效档、倒计时，并在价格档上标注「当前」
- 月费折算模式：单价 ÷ 每月额度 × $10（Go 月费），衡量「用满额度时的等效单价」，可与按量付费平台直接比价
- 美元 / 人民币切换，人民币模式下在切换按钮旁标注换算汇率；汇率实时拉取（带缓存兜底）
- 模型 ID 列，一键复制（如 `deepseek-v4.1-flash`）
- 隐私列：训练 / 留存信息从官方隐私表解析，支持按隐私筛选
- 中英双语（默认跟随浏览器语言，顶部按钮或用 `?lang=en`、`?lang=zh` 强制切换）
- localStorage 缓存 + 内置快照，断网也能查看最近数据；深色 / 浅色主题，响应式布局

## Zen 免费模型页（`zen.html`）

独立页面，**只列当前限时的免费模型**，重点是隐私情况：

- **免费 ≠ 隐私安全**：按官方隐私章节把 13 个免费模型分成四档，**零留存在最前**排序
  - 🟢 零留存不训练（2 个）——未被列入官方例外清单，适用默认零保留政策
  - 🔵 不训练但按厂商政策留存（1 个，Jev）
  - 🟠 厂商试用端点，会记录使用、官方明确「请勿提交机密数据」（2 个 Nemotron）
  - 🔴 **免费期内收集的数据可能被用于训练改进**（8 个）
- 模型 ID 一键复制 + **调用端点**（13 个里有 2 个不走 `chat/completions`：Muse Spark 走 `/responses`、Jev 走 `/systemone`，照抄 chat 会失败）
- 顶部固定警示条；每档都可点击筛选，也可搜索模型名 / 模型 ID
- 「隐私条款原文」折叠区展示官方原话，中英双语各自取对应语言版本的官方文档
- 可选的实时可用性校验：本地代理运行时，额外拿官方 `/zen/v1/models` 对比，标出「文档在列但接口已不再提供」（如 `mimo-v2.5-free`）与「接口有、文档未列、因此没有任何隐私条款」（如 `muse-spark-1.2-contributor-free`）；代理没起就静默跳过这一列

## 用量页（`usage.html`）

独立页面，展示*你自己*的 Go 用量：

- OpenCode Go 三档限额（5 小时 / 周 / 月，大圆环 Hero 展示）+ DeepSeek 账号余额
- 同款 DeepSeek 高低峰徽章与倒计时
- Key 只存浏览器 `localStorage`、只直发官方域名（本地代理可选）
- 配速预警：圆环下显示日预算与近 24h 速度；临界值按官方限制折算（周=月 50%，5h=月 20%，月基数 $60）——最后一周开始时月需 ≥50%、最后 5h 开始时月需 ≥80%，否则即使打满也注定浪费；太快按月外推超 100% 报警
- Go Key 见本机 `auth.json` 的 `opencode-go` 项；DeepSeek 任取一个同账号 `sk-` Key 即可（余额为账号级）

### 本地代理（可选）

Go / DeepSeek 两个主卡片都支持浏览器直连：Go 用量接口现在会返回 CORS 头（2026-10-18 实测），DeepSeek 余额接口本来就支持。Key 只存在浏览器 `localStorage`，直接发往官方域名，所以整页可以完全跑在 GitHub Pages 上，不需要本机开任何进程。

本地代理保留着，但只有两个可选功能需要它：

- **分模型明细**：Console 导出接口（`/console/api/v1/usage/export`）只允许 `https://opencode.ai` 自己跨域，GitHub Pages 读不到。
- **Zen 实时可用性校验**：`/zen/v1/models` 没有可用的 CORS 头。

要用这两项时，双击 `start-proxy.bat`（第一次会从本机 `auth.json` 找 Go Key，再问你要其它 Key，存到本机 `usage-proxy.keys.json`，已 gitignore，切勿提交），或设环境变量 `OPENCODE_GO_KEY` / `OPENCODE_SERVICE_KEY` / `DEEPSEEK_API_KEY` 后运行 `python usage-proxy.py`；然后在页面的「本地代理（可选）」栏填 `http://127.0.0.1:8787`。代理里的 Go Key 现在也是可选的——只在直连失败时兜底。

服务账号 Key（`oc_sk-` 开头，在 Console 里创建）只供「分模型明细」面板使用：代理的 `/api/go/records` 路由用它调官方 Usage API（`/console/api/v1/usage/export`）；不用明细面板可以不填。

代理还有一条**免 Key** 路由 `/api/zen/models`（转发官方 `https://opencode.ai/zen/v1/models`），专门给 `zen.html` 的实时可用性校验用——那个接口本身不要 Key，但上游不返回 CORS 头，浏览器只能经代理读。

### 油猴脚本（官方控制台页预警）

`opencode-go-alerts.user.js`：在官方 Go 页面（`opencode.ai/workspace/*/go`）顶部显示与 `usage.html` 同套的配速预警（90%/用完/搁浅/快慢临界值）。优先读页面水合数据里的 `rollingUsage/weeklyUsage/monthlyUsage`（精确百分比 + 秒级重置 + 状态），`data-slot` 语义标签兜底；只读页面，不调接口、不需 Key。

1. 浏览器装 Tampermonkey 扩展。
2. 打开本仓库的 `opencode-go-alerts.user.js` 原始文件（GitHub 点 Raw），Tampermonkey 会提示安装，确认。
3. 刷新官方 Go 页面，顶部出现预警横幅即生效（✕ 可本次隐藏）。

注意：告警逻辑与 `usage.html` 内 `analyzeGo` 二选一维护，改动请两边同步；官方改版导致读不到数字时脚本自动隐藏，此时把用量区的 HTML 贴过来修选择器。

## 使用

无需构建，直接打开 `index.html` 即可；或使用上方在线地址。

## 数据来源

页面运行时实时解析官方文档源文件：

- Go 价格页：`.../services/www/src/docs/content/console/go.mdx`
- Zen 免费模型页：`.../services/www/src/docs/content/console/models.mdx`（2026-10-13 文档迁移后单文件、全英文，无中英之分）
- 镜像：`https://cdn.jsdelivr.net/gh/anomalyco/opencode@dev/...`

`models.mdx` 包含模型 ID 表（`模型 | 模型 ID | 端点 | AI SDK 包`）、定价表（`模型 | 输入 | 输出 | 缓存读取 | 缓存写入`，**没有额度列**）、免费模型列表与隐私章节。因此 `zen.html` 的解析器不能复用 `index.html` 那个靠「每月限制」定位表头的函数。

价格、额度与隐私条款以官方文档为准，本页面仅做聚合展示。
