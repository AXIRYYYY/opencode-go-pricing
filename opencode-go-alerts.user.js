// ==UserScript==
// @name         OpenCode Go 配速预警
// @name:zh-CN   OpenCode Go 配速预警
// @namespace    https://github.com/axiryyyy/opencode-go-pricing
// @version      1.1.0
// @description  在官方 Go 控制台页面顶部显示配速预警：90%/用完提醒、周重置晚于月重置的搁浅分析、快慢配速临界值。官方已改版为 /console：优先同源 fetch zen usage 接口（精确数据），失败再读新版用量卡片 DOM（progressbar aria-valuenow + title 绝对时间）。
// @description:zh-CN 在官方 Go 控制台页面顶部显示配速预警：90%/用完提醒、周重置晚于月重置的搁浅分析、快慢配速临界值。官方已改版为 /console：优先同源 fetch zen usage 接口（精确数据），失败再读新版用量卡片 DOM（progressbar aria-valuenow + title 绝对时间）。
// @author        axiryyyy
// @license      MIT
// @match        https://opencode.ai/console/*/go*
// @match        https://opencode.ai/workspace/*/go*
// @run-at       document-idle
// @grant        none
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
function velocity(key) {
  const h = loadHistory().filter(p => p[key] != null);
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
async function scrape() {
  return (await fetchAPIUsage()) || (scrapeDOM() || scrapeDOMold());
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
    recordHistory(data);
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
