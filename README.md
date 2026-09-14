<div align="center">

# OpenCode Go · Model Pricing Guide

**Live dashboard: <https://axiryyyy.github.io/opencode-go-pricing/>**

[中文说明](README.zh-CN.md)

</div>

A zero-dependency, single-file web page that aggregates every [OpenCode Go](https://opencode.ai/docs/go/) model's per-1M-token prices and monthly quotas — sorted from cheap to expensive, color-coded by model series, and auto-synced from the official docs on every visit.

> Unofficial community tool — not affiliated with OpenCode. All data comes from the official docs; this page only aggregates and presents it.

## Features

- **Always current**: re-syncs the official docs on every visit, with a multi-level fallback chain (GitHub raw → jsDelivr → ghproxy / gh-proxy / ghfast mirrors)
- **Sort & search**: click any column header to sort (input price ascending by default); search across models, series and tiers
- **Series legend**: 11 color-coded model series; click to filter
- **DeepSeek peak/off-peak**: live billing-window badge with countdown, per-tier rows (Off-Peak / Peak, ≤200K / >200K), and a "live" marker on the tier currently in effect
- **Fee-equivalent mode**: list price ÷ monthly quota × $10 — the effective unit price when your full quota is used, directly comparable with pay-as-you-go platforms
- **USD / CNY toggle** with live FX rates — the conversion rate is labeled next to the toggle while CNY is active (cached fallback included)
- **Model ID column** with one-click copy (e.g. `deepseek-v4.1-flash`)
- **Privacy column**: training / retention info parsed from the official privacy table, plus privacy filters
- **Bilingual UI (EN / ZH)**: auto-detected from the browser, switchable in the header; force with `?lang=en` or `?lang=zh`
- **Offline-friendly**: localStorage cache + built-in snapshot; dark / light theme; responsive layout

## Usage page (`usage.html`)

A companion page that shows *your own* Go usage:

- Three quota rings (5-hour / weekly / monthly) + DeepSeek account balance
- The same DeepSeek peak/off-peak badge and countdown
- Keys live only in your browser's `localStorage` and are sent only to the official domains (via the local proxy where required)
- Pace warnings: daily budget vs. recent 24h speed, with the official limits folded in (weekly = 50% of monthly, 5h = 20% of monthly, $60 baseline) — warns when the remaining time can no longer fit a 100% quota, or when you're on track to exceed it
- Your Go key is in your local `auth.json` under `opencode-go`; any `sk-` key from the same DeepSeek account works for the balance (balance is account-level)

### Local proxy (required for the Go card)

The Go usage API returns no CORS headers, so the browser cannot call it directly — a local proxy is required. **Just double-click `start-proxy.bat`**: on first run it finds your Go key in `auth.json`, asks for your DeepSeek key, stores them in `usage-proxy.keys.json` (gitignored — never commit it), and starts the proxy. After that, a double-click is all it takes.

Proxy address: `http://127.0.0.1:8787` (localhost only). Keep the window open and refresh `usage.html` — the Go card should then show "updated · proxy".

Manual alternative: set `OPENCODE_GO_KEY` / `DEEPSEEK_API_KEY` and run `python usage-proxy.py`.

### Tampermonkey userscript (alerts on the official console)

`opencode-go-alerts.user.js` adds the same pace warnings (90% / depleted / stranded / speed thresholds) to the top of the official Go page (`opencode.ai/workspace/*/go`). It prefers the hydrated `rollingUsage/weeklyUsage/monthlyUsage` values on the page (exact percentages, second-level resets, status) with `data-slot` labels as a fallback. Read-only page injection — no API calls, no keys.

1. Install the Tampermonkey extension.
2. Open the raw `opencode-go-alerts.user.js` in this repo — Tampermonkey will offer to install it. Confirm.
3. Refresh the official Go page; a warning banner appears at the top (✕ hides it for the session).

Note: the alert logic and `analyzeGo` in `usage.html` are maintained as two copies — keep them in sync. If the official page changes and the numbers can't be read, the script hides itself; paste the usage-area HTML to fix the selectors.

## Usage

No build step — open `index.html` directly, or use the live link above.

## Data source

Parsed at runtime from the official docs source files:

- `https://raw.githubusercontent.com/anomalyco/opencode/dev/packages/web/src/content/docs/zh-cn/go.mdx`
- Mirror: `https://cdn.jsdelivr.net/gh/anomalyco/opencode@dev/...`

Prices and quotas follow the official docs; this page only aggregates and presents them.
