// ==UserScript==
// @name         OpenCode Go 配速预警
// @name:zh-CN   OpenCode Go 配速预警
// @namespace    https://github.com/axiryyyy/opencode-go-pricing
// @version      1.3.0
// @description  在官方 Go 控制台页面顶部显示配速预警：90%/用完提醒、周重置晚于月重置的搁浅分析、快慢配速临界值。官方已改版为 /console：优先同源 fetch Go 用量接口 /inference/go/v1/usage（精确数据），失败再读新版用量卡片 DOM；同步支持 /console activity 页（月额度 DOM 兜底）。
// @description:zh-CN 在官方 Go 控制台页面顶部显示配速预警：90%/用完提醒、周重置晚于月重置的搁浅分析、快慢配速临界值。官方已改版为 /console：优先同源 fetch Go 用量接口 /inference/go/v1/usage（精确数据），失败再读新版用量卡片 DOM；同步支持 /console activity 页（月额度 DOM 兜底）。
// @author        axiryyyy
// @license      MIT
// @match        https://opencode.ai/console/*/go*
// @match        https://opencode.ai/workspace/*/go*
// @match        https://opencode.ai/console/*/activity*
// @run-at       document-idle
// @grant        GM_xmlhttpRequest
// @connect      127.0.0.1
// ==/UserScript==

'use strict';

/* 说明：
 * - 数据来源（按优先级）：① 同源 fetch /inference/go/v1/usage（官方 JSON 接口，带
 *   cookie 同源请求，拿得到精确百分比 + ISO reset 时间；拿不到就静默降级）；
 *   ② 新版 /console Go 页 DOM 兜底：section[aria-label="Go usage limits"] 的
 *   progressbar aria-valuenow（整数百分比）+ reset 时间的 title 绝对日期；
 *   ③ 旧版 data-slot 语义标签再兜底。
 * - 告警逻辑 analyzeGo 与仓库 usage.html 内同名函数保持一致，改动时请两边同步。
 * - 官方改版导致读不到数字时自动隐藏，不打扰。
 */

const WARN_AT = 90;
// 临界值（官方基础限制 $12/$30/$60：5h=月20%，周=月50%）
const F_WEEK = 0.5, F_5H = 0.2, CRIT_WEEK = 50, CRIT_5H = 80, MONTHLY_DOLLARS = 60;
const WIN_MS = { rolling: 5 * 3600e3, weekly: 7 * 86400e3 };
const LS_HISTORY = 'opengo-tm-history-v1';
const HIST_KEEP_MS = 7 * 86400e3;
const VEL_LOOKBACK_MS = 24 * 3600e3;
const VEL_MIN_SPAN_MS = 6 * 3600e3;
const BANNER_ID = 'opengo-tm-alerts';
// 采样历史推送目标（可选）：没开代理/连不上就静默失败，不影响原有抓取和横幅
const SYNC_URL = 'http://127.0.0.1:8788/api/history';
const SYNC_BACKOFF_MS = 10 * 60e3;
let syncLastT = 0, syncFailAt = 0, syncBusy = false;

const WINDOWS = [
  { key: 'rolling', label: '5 小时', en: 'rolling' },
  { key: 'weekly', label: '周', en: 'weekly' },
  { key: 'monthly', label: '月', en: 'monthly' }
];
// DOM 兜底用的中文/英文 label 匹配
const SLOT_LABEL = [
  { key: 'rolling', re: /5\s*小时|rolling|5\s*hour/i },
  { key: 'weekly', re: /每周|weekly/i },
  { key: 'monthly', re: /每月|monthly/i }
];

/* ---------- history & velocity（存本源 localStorage，失败则降级） ---------- */
function loadHistory() {
  try {
    const d = JSON.parse(localStorage.getItem(LS_HISTORY) || '[]');
    return Array.isArray(d) ? d.filter(p => p && Number.isFinite(p.t)) : [];
  } catch (e) { return []; }
}
function recordHistory(data) {
  try {
    const h = loadHistory();
    const now = Date.now();
    const pt = { t: now };
    for (const { key } of WINDOWS) {
      const w = data && data[key];
      pt[key] = w && Number.isFinite(w.percent) ? w.percent : null;
    }
    const last = h[h.length - 1];
    if (!last || now - last.t >= 5 * 60e3) h.push(pt);
    const cutoff = now - HIST_KEEP_MS;
    localStorage.setItem(LS_HISTORY, JSON.stringify(h.filter(p => p.t >= cutoff).slice(-3000)));
  } catch (e) { /* 存储不可用时静默跳过，静态规则照常工作 */ }
}
// 把本轮采样历史增量推送到本地代理（可选）。没开代理/连不上时静默失败，10 分钟内不重试。
// 用 GM_xmlhttpRequest 而不是 fetch：opencode.ai 的 CSP/CORS 可能拦本机请求，用户脚本请求不受限。
function syncHistory() {
  if (syncBusy) return;
  if (Date.now() - syncFailAt < SYNC_BACKOFF_MS) return;
  const points = loadHistory().filter(p => p.t > syncLastT).slice(-3000);
  if (!points.length) return;
  syncBusy = true;
  try {
    GM_xmlhttpRequest({
      method: 'POST',
      url: SYNC_URL,
      headers: { 'Content-Type': 'application/json' },
      data: JSON.stringify({ source: 'tampermonkey', points }),
      timeout: 3000,
      onload: r => {
        syncBusy = false;
        if (r.status === 200) {
          syncLastT = points.reduce((m, p) => Math.max(m, p.t), syncLastT);
        } else {
          syncFailAt = Date.now();
        }
      },
      onerror: () => { syncBusy = false; syncFailAt = Date.now(); },
      ontimeout: () => { syncBusy = false; syncFailAt = Date.now(); }
    });
  } catch (e) {
    syncBusy = false;
    syncFailAt = Date.now();
  }
}
// ---- 两本采样账合并（服务器可用时）----
// remotePoints 是服务器上 usage.html 记的点；服务器没开时为空，mergedHistory() 等同本地。
let remotePoints = [];
let remoteAt = 0, remoteFailAt = 0, remoteBusy = false;
let lastData = null;

function mergeHistories(usagePts, tmPts) {
  const map = new Map();
  for (const p of usagePts) map.set(Math.floor(p.t / 60000), p);
  for (const p of tmPts) map.set(Math.floor(p.t / 60000), p);
  return [...map.values()].sort((a, b) => a.t - b.t);
}

function mergedHistory() {
  // 官网（本地油猴）优先：本地跨度够就直接用；不够才用服务器上的 usage 点补齐
  const local = loadHistory();
  const span = local.length >= 2 ? local[local.length - 1].t - local[0].t : 0;
  if (span >= VEL_MIN_SPAN_MS) return local;
  return mergeHistories(remotePoints, local);
}

function fetchRemoteHistory() {
  if (remoteBusy) return;
  if (Date.now() - remoteFailAt < SYNC_BACKOFF_MS) return;
  if (remoteAt && Date.now() - remoteAt < 5 * 60e3) return;
  remoteBusy = true;
  try {
    GM_xmlhttpRequest({
      method: 'GET',
      url: 'http://127.0.0.1:8788/api/history/points',
      timeout: 2500,
      onload: r => {
        remoteBusy = false;
        if (r.status !== 200) { remoteFailAt = Date.now(); return; }
        try {
          const j = JSON.parse(r.responseText);
          if (j && Array.isArray(j.usage)) {
            remotePoints = j.usage.filter(p => p && Number.isFinite(p.t));
            remoteAt = Date.now();
            // 合并后的点更全，立刻重算一次横幅
            if (lastData) renderBanner(analyzeGo(lastData));
          }
        } catch (e) { remoteFailAt = Date.now(); }
      },
      onerror: () => { remoteBusy = false; remoteFailAt = Date.now(); },
      ontimeout: () => { remoteBusy = false; remoteFailAt = Date.now(); }
    });
  } catch (e) {
    remoteBusy = false;
    remoteFailAt = Date.now();
  }
}

function velocity(key) {
  const h = mergedHistory().filter(p => p[key] != null);
  if (h.length < 2) return null;
  const now = Date.now();
  let start = 0;
  for (let i = h.length - 1; i > 0; i--) {
    if (h[i - 1][key] - h[i][key] > 5) { start = i; break; }
  }
  const seg = h.slice(start);
  const target = now - VEL_LOOKBACK_MS;
  let ai = 0;
  for (let i = 0; i < seg.length; i++) { if (seg[i].t <= target) ai = i; else break; }
  const points = seg.slice(ai);
  // 最小二乘回归：接口百分比取整到整数，多点拟合可抵消取整量化误差
  const n = points.length;
  if (n < 2) return null;
  const t0 = points[0].t;
  let sx = 0, sy = 0, sxx = 0, sxy = 0;
  for (const p of points) {
    const x = (p.t - t0) / 86400000, y = p[key];
    sx += x; sy += y; sxx += x * x; sxy += x * y;
  }
  const denom = n * sxx - sx * sx;
  const spanMs = points[n - 1].t - points[0].t;
  if (spanMs < VEL_MIN_SPAN_MS || !(denom > 0)) return null;
  return { v: (n * sxy - sx * sy) / denom, spanMs };
}
function forecastAt(pctNow, vPerDay, atMs) {
  return pctNow + vPerDay * (atMs - Date.now()) / 86400000;
}
function lastWindowStart(TmMs, TwMs, winMs) {
  if (!Number.isFinite(TmMs) || !Number.isFinite(TwMs) || TmMs <= Date.now()) return null;
  let end = TwMs, guard = 0;
  while (end < TmMs && guard++ < 100) end += winMs;
  return end - winMs;
}

/* ---------- format ---------- */
function fmtMD(iso) {
  const t = new Date(iso).getTime();
  if (iso == null || !Number.isFinite(t)) return '未知日期';
  return new Date(iso).toLocaleDateString('zh-CN', { month: 'numeric', day: 'numeric' });
}
function fmtReset(iso) {
  const t = new Date(iso).getTime();
  if (iso == null || !Number.isFinite(t)) return '—';
  const ms = t - Date.now();
  if (ms <= 0) return '即将重置';
  const mins = Math.ceil(ms / 60000);
  const dd = Math.floor(mins / 1440), h = Math.floor((mins % 1440) / 60), m = mins % 60;
  if (dd > 0) return dd + '天' + (h > 0 ? h + '小时' : '') + '后重置';
  if (h > 0) return h + '小时' + (m > 0 ? m + '分' : '') + '后重置';
  return m + '分钟后重置';
}
function num1(p) {
  return (Math.round(p * 10) / 10).toFixed(1);
}
function pctLabel(p) {
  if (p <= 0) return '0%';
  if (Math.round(p * 10) / 10 === 0) return '<0.1%';
  return num1(p) + '%';
}
function labelOf(k) {
  const f = WINDOWS.find(x => x.key === k);
  return f ? f.label : k;
}

/* ---------- alerts（与 usage.html analyzeGo 同步） ---------- */
function analyzeGo(data) {
  const alerts = [];
  let bottleneck = null, top = -1;
  for (const { key } of WINDOWS) {
    const w = data && data[key];
    if (!w) continue;
    if (w.status === 'rate-limited' || w.percent > top) {
      bottleneck = key;
      top = w.percent;
    }
  }
  const bw = bottleneck && data ? data[bottleneck] : null;
  if (!bw || (bw.status !== 'rate-limited' && bw.percent < WARN_AT)) bottleneck = null;
  for (const { key, label } of WINDOWS) {
    const w = data && data[key];
    if (!w) continue;
    if (w.status === 'rate-limited' || w.percent >= 100) {
      alerts.push({ level: 'red', pair: key, text: label + '额度已用完（' + fmtReset(w.resetsAt) + '），期间请求会被限流' });
    } else if (w.percent >= WARN_AT) {
      alerts.push({ level: 'yellow', pair: key, text: label + '额度已用 ' + pctLabel(w.percent) + '，' + fmtReset(w.resetsAt) + '，省着用' });
    }
  }
  const order = ['rolling', 'weekly', 'monthly'];
  for (let i = 0; i < order.length - 1; i++) {
    const s = data && data[order[i]], l = data && data[order[i + 1]];
    if (!s || !l) continue;
    if (s.status !== 'rate-limited' && s.percent < WARN_AT) continue;
    const ts = new Date(s.resetsAt).getTime(), tl = new Date(l.resetsAt).getTime();
    if (!Number.isFinite(ts) || !Number.isFinite(tl) || ts <= tl) continue;
    const gap = Math.max(1, Math.round((ts - tl) / 86400000));
    alerts.push({
      level: 'red',
      pair: order[i],
      text: labelOf(order[i]) + '重置（' + fmtMD(s.resetsAt) + '）比' + labelOf(order[i + 1]) + '重置（' + fmtMD(l.resetsAt) + '）晚约 ' + gap + ' 天：这 ' + gap + ' 天里即使' + labelOf(order[i + 1]) + '额度有剩也会被卡住，建议把重活提前到 ' + fmtMD(l.resetsAt) + ' 前做完'
    });
  }
  const m = data && data.monthly;
  const vm = velocity('monthly');
  if (m && vm && vm.v > 0) {
    const Tm = new Date(m.resetsAt).getTime();
    if (Number.isFinite(Tm)) {
      const mEnd = forecastAt(m.percent, vm.v, Tm);
      if (m.percent < 100 && mEnd > 100) {
        const hitAt = Date.now() + (100 - m.percent) / vm.v * 86400000;
        const earlyDays = Math.max(1, Math.round((Tm - hitAt) / 86400000));
        const vmax = (100 - m.percent) / Math.max(0.5, (Tm - Date.now()) / 86400000);
        alerts.push({
          level: 'red',
          text: '按近 24h 速度（每天约 ' + vm.v.toFixed(1) + '%），月额度将于 ' + fmtMD(hitAt) + ' 提前用完（比月重置早 ' + earlyDays + ' 天）——降速到每天 ≤' + vmax.toFixed(1) + '% 可撑到月底'
        });
      }
      const shorts = [
        { key: 'weekly', f: F_WEEK, crit: CRIT_WEEK },
        { key: 'rolling', f: F_5H, crit: CRIT_5H }
      ];
      for (const s of shorts) {
        const w = data && data[s.key];
        if (!w) continue;
        const Tw = new Date(w.resetsAt).getTime();
        const T0 = lastWindowStart(Tm, Tw, WIN_MS[s.key]);
        if (T0 == null) continue;
        if (T0 <= Date.now()) {
          const reach = m.percent + Math.max(0, 100 - w.percent) * s.f;
          if (reach < 100) {
            if (alerts.some(x => x.level === 'red' && x.pair === s.key)) continue;
            const waste = 100 - reach;
            alerts.push({
              level: waste >= 15 ? 'red' : 'yellow',
              pair: s.key,
              text: '已进入' + labelOf(s.key) + '最后一窗：即使打满也只能冲到 ' + num1(reach) + '%，月末注定浪费 ≥' + num1(waste) + '%（约 $' + (waste * MONTHLY_DOLLARS / 100).toFixed(0) + '）——排点重活进来'
            });
          }
        } else {
          const mAtT0 = forecastAt(m.percent, vm.v, T0);
          if (mAtT0 < s.crit) {
            const need = (s.crit - m.percent) / Math.max(0.5, (T0 - Date.now()) / 86400000);
            alerts.push({
              level: 'yellow',
              pair: s.key,
              text: '按近 24h 速度（每天约 ' + vm.v.toFixed(1) + '%），到' + labelOf(s.key) + '最后一窗开始（' + fmtMD(T0) + '）月额度只能到 ' + num1(mAtT0) + '%，低于 ' + s.crit + '% 临界——之后即使打满也追不回。建议从现在起提速到每天 ≥' + need.toFixed(1) + '%'
            });
          }
        }
      }
    }
  }
  return { alerts, bottleneck };
}

/* ---------- 数据获取：优先同源 zen usage 接口，DOM 兜底 ---------- */
const API_URL = '/inference/go/v1/usage';
let apiCache = null, apiAt = 0, apiFailAt = 0;
const API_TTL = 55e3, API_FAIL_BACKOFF = 90e3;

async function fetchAPIUsage() {
  const now = Date.now();
  if (apiCache && now - apiAt < API_TTL) return apiCache;
  // 拿不到（401 被拒/网络不行）时不狂试：退避 90s。
  // 退避与“有没有旧缓存”无关——否则缓存过期后接口持续失败，会每个 tick 都重试一次。
  if (now - apiFailAt < API_FAIL_BACKOFF) return apiCache;
  try {
    const r = await fetch(API_URL, { credentials: 'include', cache: 'no-store', headers: { 'Accept': 'application/json' } });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    const body = await r.json();
    const usage = body && body.usage;
    const out = {};
    let n = 0;
    for (const { key } of WINDOWS) {
      const w = usage && usage[key];
      if (w && Number.isFinite(w.percent)) {
        out[key] = {
          percent: Math.min(100, Math.max(0, w.percent)),
          status: /rate-limited/i.test(String(w.status || '')) ? 'rate-limited' : 'ok',
          resetsAt: typeof w.resetsAt === 'string' ? new Date(w.resetsAt).getTime() : null
        };
        n++;
      }
    }
    if (!n) throw new Error('empty');
    apiCache = out;
    apiAt = now;
    return out;
  } catch (e) {
    apiFailAt = Date.now();
    return apiCache; // 旧缓存也比没有强
  }
}
// 新版 DOM：section[aria-label="Go usage limits"] 三张卡片
// 卡内 progressbar[aria-label="Xxx usage used"] 的 aria-valuenow 是整数百分比；
// 重置时间是 span[title="2026/10/6 15:03:54"]（本地时间绝对日期，语言无关）。
function parseLocalDate(s) {
  const m = String(s || '').match(/^(\d{4})[\/.\-](\d{1,2})[\/.\-](\d{1,2})[ T](\d{1,2}):(\d{2})(?::(\d{2}))?$/);
  if (!m) { const t = new Date(s).getTime(); return Number.isFinite(t) ? t : null; }
  return new Date(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +(m[6] || 0)).getTime();
}
function scrapeDOM() {
  const sec = document.querySelector('section[aria-label="Go usage limits"]')
    || document.querySelector('section[aria-label*="usage"], section[aria-label*="Use"], section[aria-label*="限度"], section[aria-label*="限额"]');
  if (!sec) return scrapeDOMLegacy();
  const bars = sec.querySelectorAll('[role="progressbar"][aria-valuenow]');
  if (!bars.length) return null;
  const out = {};
  let found = 0;
  bars.forEach(bar => {
    const label = bar.getAttribute('aria-label') || (bar.textContent || '');
    const entry = SLOT_LABEL.find(e => e.re.test(label));
    if (!entry || out[entry.key]) return;
    const pc = parseFloat(bar.getAttribute('aria-valuenow'));
    if (!Number.isFinite(pc)) return;
    // 从进度条向上找卡片根（ 含 span[title] 时间戳作用域 ）
    let card = bar;
    for (let up = 0; up < 4 && card.parentElement; up++) {
      card = card.parentElement;
      if (card.querySelector && card.querySelector('span[title]')) break;
    }
    const resetEl = card && card.querySelector('span[title]');
    const txt = (card && card.textContent) || '';
    out[entry.key] = {
      percent: Math.min(100, Math.max(0, pc)),
      status: /限流|超限|已用完|rate-limited|limited/i.test(txt) ? 'rate-limited' : 'ok',
      resetsAt: resetEl ? parseLocalDate(resetEl.getAttribute('title')) : parseDuration(txt)
    };
    found++;
  });
  return found ? out : scrapeDOMLegacy();
}
// 旧版 /workspace 页面兜底：data-slot 语义标签
function scrapeDOMLegacy() {
  const items = document.querySelectorAll('[data-slot="usage-item"]');
  if (!items.length) return null;
  const out = {};
  let found = 0;
  items.forEach(item => {
    const labelEl = item.querySelector('[data-slot="usage-label"]');
    const label = (labelEl && labelEl.textContent) || '';
    const entry = SLOT_LABEL.find(e => e.re.test(label));
    if (!entry || out[entry.key]) return;
    const valEl = item.querySelector('[data-slot="usage-value"]');
    const pc = parseFloat((((valEl && valEl.textContent) || '').replace(/[^0-9.]/g, '')));
    if (!Number.isFinite(pc)) return;
    const rstEl = item.querySelector('[data-slot="reset-time"]');
    const txt = item.textContent || '';
    out[entry.key] = {
      percent: Math.min(100, Math.max(0, pc)),
      status: /限流|超限|已用完|rate-limited/i.test(txt) ? 'rate-limited' : 'ok',
      resetsAt: parseDuration(rstEl ? rstEl.textContent : txt)
    };
    found++;
  });
  return found ? out : null;
}
// 中文（4 小时 1 分钟 / 6 天 14 小时）+ 英文（1 hour 21 minutes）都认
function parseDuration(t) {
  const s = String(t || '');
  const num = (re, mul) => {
    const x = s.match(re);
    return x ? parseFloat(x[1]) * mul : 0;
  };
  const ms = num(/(\d+(?:\.\d+)?)\s*周/i, 7 * 86400000)
    + num(/(\d+(?:\.\d+)?)\s*天/i, 86400000)
    + num(/(\d+(?:\.\d+)?)\s*(?:小时|时)/i, 3600e3)
    + num(/(\d+(?:\.\d+)?)\s*(?:分钟|分)/i, 60e3)
    + num(/(\d+(?:\.\d+)?)\s*秒/i, 1000)
    + num(/(\d+(?:\.\d+)?)\s*weeks?/i, 7 * 86400000)
    + num(/(\d+(?:\.\d+)?)\s*days?/i, 86400000)
    + num(/(\d+(?:\.\d+)?)\s*hours?/i, 3600e3)
    + num(/(\d+(?:\.\d+)?)\s*(?:minutes?|mins?)/i, 60e3)
    + num(/(\d+(?:\.\d+)?)\s*seconds?/i, 1000);
  return ms > 0 ? Date.now() + ms : null;
}
function scrapeDOMold() {
  const items = document.querySelectorAll('[data-slot="usage-item"]');
  if (!items.length) return null;
  const out = {};
  let found = 0;
  items.forEach(item => {
    const labelEl = item.querySelector('[data-slot="usage-label"]');
    const label = (labelEl && labelEl.textContent) || '';
    const entry = SLOT_LABEL.find(e => e.re.test(label));
    if (!entry || out[entry.key]) return;
    const valEl = item.querySelector('[data-slot="usage-value"]');
    const pc = parseFloat((((valEl && valEl.textContent) || '').replace(/[^0-9.]/g, '')));
    if (!Number.isFinite(pc)) return;
    const rstEl = item.querySelector('[data-slot="reset-time"]');
    const txt = item.textContent || '';
    out[entry.key] = {
      percent: Math.min(100, Math.max(0, pc)),
      status: /限流|超限|已用完|rate-limited/i.test(txt) ? 'rate-limited' : 'ok',
      resetsAt: parseDuration(rstEl ? rstEl.textContent : txt)
    };
    found++;
  });
  return found ? out : null;
}
// Activity 页兜底（2026-11-01 新增）：section.activity-workspace[aria-label="Go usage"]
// 实测结构（存档 Activity _ OpenCode Console.html 约 1349 行）：
//  - div.activity-section-heading h1 a 文本如 "70%"（月额度，链到 .../activity/usage?range=mtd）
//  - caption 文本如 "Go usage · Ends Nov 6 · On pace for 84%"（只有月日，无年份时刻）
//  - svg[aria-label] 如 "70% of the monthly Go allowance used. Forecast 84% by Nov 6."
// 该页只有月窗：周/5h 留空，analyzeGo 本就支持缺窗跳过；官方 "On pace" 预测值不接入告警，仍用自家 velocity()。
// "Ends Nov 6" 按最近未来的该月日、中午 12:00 本地时间推算；解析失败返回 null（显示"—"），不阻塞百分比。
function parseActivityEndDate(sec) {
  try {
    const txt = (sec && sec.textContent) || '';
    const m = txt.match(/Ends?\s+([A-Za-z]{3,9})\s+(\d{1,2})/i);
    if (!m) return null;
    const months = { jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5, jul: 6, aug: 7, sep: 8, sept: 8, oct: 9, nov: 10, dec: 11 };
    const mi = months[String(m[1]).slice(0, 4).toLowerCase().slice(0, 3)];
    const day = parseInt(m[2], 10);
    if (mi == null || !Number.isFinite(day) || day < 1 || day > 31) return null;
    const now = new Date();
    let d = new Date(now.getFullYear(), mi, day, 12, 0, 0);
    if (d.getTime() <= now.getTime()) d = new Date(now.getFullYear() + 1, mi, day, 12, 0, 0);
    return d.getTime();
  } catch (e) { return null; }
}
function scrapeActivityDOM() {
  const sec = document.querySelector('section.activity-workspace[aria-label="Go usage"]');
  if (!sec) return null;
  // 百分比优先读大标题 h1 a（如 "70%"），取不到再读图表 svg 的 aria-label。
  let pc = NaN;
  const h1a = sec.querySelector('.activity-section-heading h1 a');
  if (h1a) {
    const m = String(h1a.textContent || '').match(/([\d.]+)\s*%/);
    if (m) pc = parseFloat(m[1]);
  }
  if (!Number.isFinite(pc)) {
    const svg = sec.querySelector('svg[aria-label]');
    if (svg) {
      const m2 = String(svg.getAttribute('aria-label') || '').match(/([\d.]+)\s*%/);
      if (m2) pc = parseFloat(m2[1]);
    }
  }
  if (!Number.isFinite(pc)) return null;
  const txt = sec.textContent || '';
  return {
    monthly: {
      percent: Math.min(100, Math.max(0, pc)),
      status: /限流|超限|已用完|rate-limited|limited/i.test(txt) ? 'rate-limited' : 'ok',
      resetsAt: parseActivityEndDate(sec)
    }
  };
}
async function scrape() {
  // 优先级：① 同源 Go 用量接口（精确，三窗齐全）；② go 页卡片 DOM；③ activity 页 DOM（仅月窗）；④ 旧版兜底。
  return (await fetchAPIUsage()) || (scrapeDOM() || scrapeActivityDOM() || scrapeDOMold());
}

/* ---------- render：样式全内联，不污染官方页面 ---------- */
let lastKey = '', dismissed = false;
function renderBanner(result) {
  if (dismissed) return;
  if (!result || !result.alerts.length) {
    const old = document.getElementById(BANNER_ID);
    if (old) old.remove();
    lastKey = '';
    return;
  }
  const key = JSON.stringify(result.alerts.map(a => a.level + a.text));
  // 内容无变化且横幅还在：不重绘；SPA 把横幅清掉则重建
  if (key === lastKey && document.getElementById(BANNER_ID)) return;
  lastKey = key;
  const old = document.getElementById(BANNER_ID);
  if (old) old.remove();
  const host = document.body || document.documentElement;
  const box = document.createElement('div');
  box.id = BANNER_ID;
  // 悬浮贴片：fixed 挂在 body，与官方 hydration DOM 完全隔离，避免 Client Exception
  box.setAttribute('style', 'position:fixed;top:12px;right:12px;width:min(360px,calc(100vw - 24px));'
    + 'z-index:2147483647;background:#ffffff;color:#1b2334;font-family:inherit;font-size:13.5px;'
    + 'border-radius:12px;box-shadow:0 8px 30px rgba(0,0,0,.35);padding:12px 14px;');
  const head = '<div style="font-weight:700;font-size:14px;margin-bottom:8px;color:#111827;">'
    + '⚠ Go 配速预警'
    + (result.bottleneck ? ' · 瓶颈：' + labelOf(result.bottleneck) : '')
    + '<a href="#" id="' + BANNER_ID + '-x" style="float:right;font-weight:400;color:#6b7280;" title="本次隐藏">✕</a></div>';
  const rows = result.alerts.map(a => {
    const st = a.level === 'red'
      ? 'color:#b91c1c;background:rgba(248,113,113,.12);border:1px solid rgba(248,113,113,.45);'
      : 'color:#92400e;background:rgba(251,191,36,.12);border:1px solid rgba(251,191,36,.45);';
    return '<div style="' + st + 'font-size:13.5px;line-height:1.7;border-radius:10px;padding:10px 14px;margin-bottom:8px;">' + escHtml(a.text) + '</div>';
  }).join('');
  box.innerHTML = head + rows;
  host.appendChild(box);
  const x = document.getElementById(BANNER_ID + '-x');
  if (x) x.addEventListener('click', e => {
    e.preventDefault();
    dismissed = true;
    const b = document.getElementById(BANNER_ID);
    if (b) b.remove();
  });
}
function escHtml(s) {
  return String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

/* ---------- main loop ---------- */
async function tick() {
  try {
    const data = await scrape();
    if (!data) return; // 官方改版或未渲染：静默
    lastData = data;
    recordHistory(data);
    syncHistory();
    fetchRemoteHistory();
    renderBanner(analyzeGo(data));
  } catch (e) { /* 出错也不打扰官方页面 */ }
}

let debTimer = null;
function schedule() {
  clearTimeout(debTimer);
  debTimer = setTimeout(tick, 800);
}
try {
  const obs = new MutationObserver(schedule);
  obs.observe(document.documentElement, { childList: true, subtree: true, characterData: true });
} catch (e) { /* ignore */ }
setInterval(tick, 60000);
// SPA 切页兜底
try {
  const _push = history.pushState, _rep = history.replaceState;
  const nav = fn => function () { fn.apply(this, arguments); dismissed = false; schedule(); };
  history.pushState = nav(_push);
  history.replaceState = nav(_rep);
  window.addEventListener('popstate', () => { dismissed = false; schedule(); });
} catch (e) { /* ignore */ }
// 水合较慢时多试几次
[1500, 4000, 8000].forEach(t => setTimeout(tick, t));
tick();
