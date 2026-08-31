# OpenCode Go 模型价格速查

一个零依赖的单文件网页，自动整理 [OpenCode Go](https://opencode.ai/docs/zh-cn/go/) 全部模型每 1M tokens 的价格与每月使用额度，按价格从便宜到贵排序，并用不同颜色区分模型系列。

**在线使用：<https://axiryyyy.github.io/opencode-go-pricing/>**

## 功能

- 每次打开自动同步官方最新数据（GitHub raw → jsDelivr 镜像 → CORS 代理，多级兜底）
- 默认按输入单价升序，点击任意列头切换排序
- 11 个模型系列各一色，图例可点击筛选；支持搜索
- 统计概览（档位数 / 系列数 / 最低 / 最高输入价）
- DeepSeek 高峰/低峰档自动标色，多档价（≤ 200K / > 200K 等）逐行展示
- localStorage 缓存 + 内置快照，断网也能查看最近数据
- 深色 / 浅色主题切换，响应式布局

## 使用

无需构建，直接打开 `index.html` 即可；或使用上方在线地址。

## 数据来源

页面运行时实时解析 OpenCode Go 官方文档源文件：

- `https://raw.githubusercontent.com/anomalyco/opencode/dev/packages/web/src/content/docs/zh-cn/go.mdx`
- 镜像：`https://cdn.jsdelivr.net/gh/anomalyco/opencode@dev/...`

价格与额度以官方文档为准，本页面仅做聚合展示。
