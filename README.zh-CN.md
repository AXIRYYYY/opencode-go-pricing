<div align="center">

# OpenCode Go · 模型价格速查

**在线使用：<https://axiryyyy.github.io/opencode-go-pricing/>**

[English](README.md)

</div>

一个零依赖的单文件网页，自动整理 [OpenCode Go](https://opencode.ai/docs/zh-cn/go/) 全部模型每 1M tokens 的价格与每月使用额度，按价格从便宜到贵排序，并用不同颜色区分模型系列。

> 非官方社区工具，与 OpenCode 无关。数据全部来自官方文档，本页面仅做聚合展示。

## 功能

- 每次打开自动同步官方最新数据（GitHub raw → jsDelivr 镜像 → ghproxy/gh-proxy/ghfast 镜像，多级兜底）
- 默认按输入单价升序，点击任意列头切换排序；支持搜索
- 11 个模型系列各一色，图例可点击筛选
- DeepSeek 高峰/低峰档自动标色，多档价（≤ 200K / > 200K 等）逐行展示；顶部实时显示当前生效档、倒计时，并在价格档上标注「当前」
- 月费折算模式：单价 ÷ 每月额度 × $10（Go 月费），衡量「用满额度时的等效单价」，可与按量付费平台直接比价
- 美元 / 人民币切换，人民币模式下在切换按钮旁标注换算汇率；汇率实时拉取（带缓存兜底）
- 模型 ID 列，一键复制（如 `deepseek-v4.1-flash`）
- 隐私列：训练 / 留存信息从官方隐私表解析，支持按隐私筛选
- 中英双语（默认跟随浏览器语言，顶部按钮或用 `?lang=en`、`?lang=zh` 强制切换）
- localStorage 缓存 + 内置快照，断网也能查看最近数据；深色 / 浅色主题，响应式布局

## 用量页（`usage.html`）

独立页面，展示*你自己*的 Go 用量：

- OpenCode Go 三档限额（5 小时 / 周 / 月，大圆环 Hero 展示）+ DeepSeek 账号余额
- 同款 DeepSeek 高低峰徽章与倒计时
- Key 只存浏览器 `localStorage`、只直发官方域名（Go 卡经本地代理）
- 配速预警：圆环下显示日预算与近 24h 速度；临界值按官方限制折算（周=月 50%，5h=月 20%，月基数 $60）——最后一周开始时月需 ≥50%、最后 5h 开始时月需 ≥80%，否则即使打满也注定浪费；太快按月外推超 100% 报警
- Go Key 见本机 `auth.json` 的 `opencode-go` 项；DeepSeek 任取一个同账号 `sk-` Key 即可（余额为账号级）

### 本地代理（Go 卡必需）

Go 用量接口不返回 CORS 头，浏览器无法直连，必须经本地代理。**双击 `start-proxy.bat` 即可**：第一次它会自动从本机 `auth.json` 找 Go Key，再问你要 DeepSeek Key，存到本机 `usage-proxy.keys.json`（已 gitignore，切勿提交），然后启动代理；以后双击直接启动。

代理地址 `http://127.0.0.1:8787`（仅本机），窗口不要关，再去浏览器刷新 `usage.html`，Go 卡会显示「已更新 · 代理」。

手动方式（可选）：设环境变量 `OPENCODE_GO_KEY` / `DEEPSEEK_API_KEY` 后运行 `python usage-proxy.py`。

### 油猴脚本（官方控制台页预警）

`opencode-go-alerts.user.js`：在官方 Go 页面（`opencode.ai/workspace/*/go`）顶部显示与 `usage.html` 同套的配速预警（90%/用完/搁浅/快慢临界值）。优先读页面水合数据里的 `rollingUsage/weeklyUsage/monthlyUsage`（精确百分比 + 秒级重置 + 状态），`data-slot` 语义标签兜底；只读页面，不调接口、不需 Key。

1. 浏览器装 Tampermonkey 扩展。
2. 打开本仓库的 `opencode-go-alerts.user.js` 原始文件（GitHub 点 Raw），Tampermonkey 会提示安装，确认。
3. 刷新官方 Go 页面，顶部出现预警横幅即生效（✕ 可本次隐藏）。

注意：告警逻辑与 `usage.html` 内 `analyzeGo` 二选一维护，改动请两边同步；官方改版导致读不到数字时脚本自动隐藏，此时把用量区的 HTML 贴过来修选择器。

## 使用

无需构建，直接打开 `index.html` 即可；或使用上方在线地址。

## 数据来源

页面运行时实时解析 OpenCode Go 官方文档源文件：

- `https://raw.githubusercontent.com/anomalyco/opencode/dev/packages/web/src/content/docs/zh-cn/go.mdx`
- 镜像：`https://cdn.jsdelivr.net/gh/anomalyco/opencode@dev/...`

价格与额度以官方文档为准，本页面仅做聚合展示。
