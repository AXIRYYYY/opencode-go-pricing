<div align="center">

# OpenCode Go · Model Pricing Guide

**Live dashboard: <https://axiryyyy.github.io/opencode-go-pricing/>**

[中文说明](README.zh-CN.md)

</div>

A zero-dependency, single-file web page that aggregates every [OpenCode Go](https://opencode.ai/docs/go/) model's per-1M-token prices and monthly quotas — sorted from cheap to expensive, color-coded by model series, and auto-synced from the official docs on every visit.

> Unofficial community tool — not affiliated with OpenCode. All data comes from the official docs; this page only aggregates and presents it.

## Features

- **Always current**: re-syncs the official docs on every visit, with a multi-level fallback chain (GitHub raw → jsDelivr → ghproxy / gh-proxy / ghfast mirrors)
- **Sorted by the output column's fee-equivalent price (cheap → expensive) by default** (list price ÷ monthly quota × $10); a manual switch is remembered
- **Sort & search**: click any column header to sort; search across models, series and tiers
- **Series legend**: 13 color-coded model series; click to filter
- **DeepSeek peak/off-peak**: live billing-window badge with countdown, per-tier rows (Off-Peak / Peak, ≤200K / >200K), and a "live" marker on the tier currently in effect
- **Fee-equivalent mode**: list price ÷ monthly quota × $10 — the effective unit price when your full quota is used, directly comparable with pay-as-you-go platforms
- **USD / CNY toggle** with live FX rates — the conversion rate is labeled next to the toggle while CNY is active (cached fallback included)
- **Model ID column** with one-click copy (e.g. `deepseek-v4.1-flash`)
- **Privacy column**: training / retention info parsed from the official privacy table, plus privacy filters
- **Bilingual UI (EN / ZH)**: auto-detected from the browser, switchable in the header; force with `?lang=en` or `?lang=zh`
- **Offline-friendly**: localStorage cache + built-in snapshot; dark / light theme; responsive layout

## Zen free models page (`zen.html`)

A companion page listing **only the current limited-time free models**, focused on privacy:

- **Free is not private**: the 13 free models are split into four tiers taken from the official privacy section, sorted **zero-retention first**
  - 🟢 Zero retention, no training (2) — not listed among the official exceptions, so the default zero-retention policy applies
  - 🔵 Not trained, but retained per vendor policy (1 — Jev)
  - 🟠 Vendor trial endpoints that log usage; the docs explicitly say "do not submit confidential data" (2 — Nemotron)
  - 🔴 **Data collected during the free period may be used to improve the model** (8)
- One-click model-ID copy plus the **calling endpoint** — 2 of the 13 do *not* use `chat/completions` (Muse Spark uses `/responses`, Jev uses `/systemone`), so copying chat/completions fails
- A fixed warning banner at the top; every tier is clickable as a filter; search by model name or model ID
- A collapsible "official privacy wording" section showing the source text verbatim, each language pulled from its own official doc version
- Optional live-availability cross-check: with the local proxy running, the page also compares against the official `/zen/v1/models` and flags models the docs still list but the API has retired (e.g. `mimo-v2.5-free`), plus models the API serves that the docs omit entirely (e.g. `muse-spark-1.2-contributor-free`, which therefore has **no privacy terms at all**). With the proxy down, that column is silently skipped.

## Usage page (`usage.html`)

A companion page that shows *your own* Go usage:

- Three quota rings (5-hour / weekly / monthly) + DeepSeek account balance
- The same DeepSeek peak/off-peak badge and countdown
- Keys live only in your browser's `localStorage` and are sent only to the official domains (the local proxy is optional and only used for model breakdown / Zen check)
- Pace warnings: daily budget vs. recent 24h speed, with the official limits folded in (weekly = 50% of monthly, 5h = 20% of monthly, $60 baseline) — warns when the remaining time can no longer fit a 100% quota, or when you're on track to exceed it
- Your Go key is in your local `auth.json` under `opencode-go`; any `sk-` key from the same DeepSeek account works for the balance (balance is account-level)

### Local proxy (optional)

Both main cards run directly in the browser: the Go usage API now returns CORS headers (verified 2026-10-18) and the DeepSeek balance API already supports CORS. Keys stay in your browser's `localStorage` and are sent straight to the official domains, so the page works entirely on GitHub Pages — no local process is needed.

The local proxy is still available, but only two optional features need it:

- **Model breakdown**: the Console export endpoint (`/console/api/v1/usage/export`) only allows `https://opencode.ai` as its CORS origin, so a GitHub Pages page cannot read it.
- **Zen live-availability check**: `/zen/v1/models` has no usable CORS header.

To use those, double-click `start-proxy.bat` (on first run it reads the Go key from `auth.json`, asks for the other keys, stores them in `usage-proxy.keys.json` — gitignored, never commit it — and starts the proxy), or set `OPENCODE_GO_KEY` / `OPENCODE_SERVICE_KEY` / `DEEPSEEK_API_KEY` and run `python usage-proxy.py`. Then enter `http://127.0.0.1:8787` in the page's "Local proxy" field. The Go key is optional for the proxy now — it is only a fallback if direct access fails.

The service-account key (`oc_sk-`, created in the Console) is only needed by the "Model breakdown" tab: the proxy `/api/go/records` route calls the official Usage API (`/console/api/v1/usage/export`) with it. Leave it empty if you do not use that panel.

The proxy also exposes one **keyless** route, `/api/zen/models`, which forwards the official `https://opencode.ai/zen/v1/models` for `zen.html`'s live-availability check. That endpoint needs no credentials, but it sends no CORS header, so the browser can only read it through the proxy.

### Tampermonkey userscript (alerts on the official console)

`opencode-go-alerts.user.js` adds the same pace warnings (90% / depleted / stranded / speed thresholds) to the top of the official Console Go page (`opencode.ai/console/*/go`; legacy `/workspace/*/go` kept). The old hydration block is gone in the new Console, so it reads the "Go usage limits" cards (progressbar `aria-valuenow` + absolute reset timestamp in the `title` attribute), with a same-origin probe of `opencode.ai/inference/go/v1/usage` for higher precision when cookie auth allows.

1. Install the Tampermonkey extension.
2. Open the raw `opencode-go-alerts.user.js` in this repo — Tampermonkey will offer to install it. Confirm.
3. Refresh the official Go page; a warning banner appears at the top (✕ hides it for the session).

Note: the alert logic and `analyzeGo` in `usage.html` are maintained as two copies — keep them in sync. If the official page changes and the numbers can't be read, the script hides itself; paste the usage-area HTML to fix the selectors.

## Usage

No build step — open `index.html` directly, or use the live link above.

## Data source

Parsed at runtime from the official docs source files:

- Go pricing page: `.../services/www/src/docs/content/console/go.mdx`
- Zen free models page: `.../services/www/src/docs/content/console/models.mdx` (single file, English only since the 2026-10-13 docs migration)
- Mirror: `https://cdn.jsdelivr.net/gh/anomalyco/opencode@dev/...`

`models.mdx` contains the model ID table (`Model | Model ID | Endpoint | AI SDK Package`), the pricing table (`Model | Input | Output | Cached Read | Cached Write`, with **no quota column**), a free-models bullet list, and the privacy section. So `zen.html` cannot reuse `index.html`'s parser, which locates its table by a "monthly limit" header.

Prices, quotas and privacy terms follow the official docs; these pages only aggregate and present them.
