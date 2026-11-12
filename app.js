'use strict';
/* Kayline — blood pressure tracker. No build step, no dependencies.
   All readings live in this browser's localStorage. The only network call the app can
   make is the optional Claude AI feature in ai.js, using the user's own API key. */

/* ============ storage ============ */
const STORE_KEY = 'bp-baseline:v1';          // sessions (schema unchanged since v1)
const THEME_KEY = 'bp-baseline:theme';
const META_KEY = 'bp-baseline:meta';
const mem = {};
let storageOK = true;
const store = {
  get(k) { try { return localStorage.getItem(k); } catch (e) { storageOK = false; return mem[k] ?? null; } },
  set(k, v) { try { localStorage.setItem(k, v); } catch (e) { storageOK = false; mem[k] = v; } },
  del(k) { try { localStorage.removeItem(k); } catch (e) { delete mem[k]; } },
};
const readMeta = () => { try { return JSON.parse(store.get(META_KEY) || '{}') || {}; } catch (e) { return {}; } };
const writeMeta = patch => store.set(META_KEY, JSON.stringify({ ...readMeta(), ...patch }));

/* ============ domain constants ============ */
const TAGS = [
  { id: 'rested',   label: 'Rested 5+ min',  emoji: '🧘', disturbs: false },
  { id: 'caffeine', label: 'Caffeine',       emoji: '☕', disturbs: true },
  { id: 'exercise', label: 'Exercise',       emoji: '🏃', disturbs: true },
  { id: 'meal',     label: 'Just ate',       emoji: '🍽️', disturbs: true },
  { id: 'stressed', label: 'Stressed',       emoji: '😣', disturbs: true },
  { id: 'sleep',    label: 'Poor sleep',     emoji: '😴', disturbs: false },
  { id: 'alcohol',  label: 'Alcohol',        emoji: '🍷', disturbs: true },
  { id: 'nicotine', label: 'Nicotine',       emoji: '🚬', disturbs: true },
  { id: 'bladder',  label: 'Full bladder',   emoji: '🚻', disturbs: true },
  { id: 'ill',      label: 'Ill or in pain', emoji: '🤒', disturbs: true },
  { id: 'meds',     label: 'Took meds',      emoji: '💊', disturbs: false },
];
const TAG = Object.fromEntries(TAGS.map(t => [t.id, t]));
const DISTURBERS = TAGS.filter(t => t.disturbs).map(t => t.id);

const CATS = {
  normal:   { label: 'Normal',   sys: '< 120',   and: 'and',    dia: '< 80' },
  elevated: { label: 'Elevated', sys: '120–129', and: 'and',    dia: '< 80' },
  stage1:   { label: 'Stage 1',  sys: '130–139', and: 'or',     dia: '80–89' },
  stage2:   { label: 'Stage 2',  sys: '≥ 140',   and: 'or',     dia: '≥ 90' },
  crisis:   { label: 'Crisis',   sys: '> 180',   and: 'and/or', dia: '> 120' },
  low:      { label: 'Low',      sys: '< 90',    and: 'or',     dia: '< 60' },
};
const CAT_ORDER = ['normal', 'elevated', 'stage1', 'stage2', 'crisis', 'low'];

function classify(s, d) {
  if (s > 180 || d > 120) return 'crisis';
  if (s >= 140 || d >= 90) return 'stage2';
  if (s >= 130 || d >= 80) return 'stage1';
  if (s >= 120) return 'elevated';
  if (s < 90 || d < 60) return 'low';
  return 'normal';
}
const isStandard = s => s.pos === 'seated' && !s.tags.some(t => DISTURBERS.includes(t));

/* ============ icons (line style, 24px grid) ============ */
const ICONS = {
  heart: '<path d="M12 20s-7-4.4-7-10a4 4 0 0 1 7-2.6A4 4 0 0 1 19 10c0 5.6-7 10-7 10z"/>',
  up: '<path d="M3 17l6-6 4 4 8-8M15 7h6v6"/>',
  down: '<path d="M3 7l6 6 4-4 8 8M15 17h6v-6"/>',
  flat: '<path d="M4 12h16M15 7l5 5-5 5"/>',
  wave: '<path d="M3 12c2.5-7 4.5-7 6.5 0s4 7 6.5 0 3-5 5-3"/>',
  sunrise: '<path d="M3 18h18M7 18a5 5 0 0 1 10 0M12 6v3M5 10l2 2M19 10l-2 2"/>',
  pulse: '<path d="M3 12h4l2.5-6 4 12 2.5-6H21"/>',
  arms: '<path d="M4 12h16M8 8l-4 4 4 4M16 8l4 4-4 4"/>',
  target: '<circle cx="12" cy="12" r="9"/><circle cx="12" cy="12" r="4.5"/>',
  check: '<circle cx="12" cy="12" r="9"/><path d="M8 12.5l2.7 2.7L16 9.8"/>',
  flame: '<path d="M12 3c1 4 5 5.5 5 10a5 5 0 0 1-10 0c0-2 1-3 2-4 .3 1.5 1 2 2 2 0-3-1-5 1-8z"/>',
  sparkle: '<path d="M12 3l1.9 5.1L19 10l-5.1 1.9L12 17l-1.9-5.1L5 10l5.1-1.9z"/>',
  send: '<path d="M12 19V6M6 11l6-6 6 6"/>',
};
const icon = (name, size = 18) => `<svg class="i" width="${size}" height="${size}" viewBox="0 0 24 24" aria-hidden="true">${ICONS[name] || ''}</svg>`;

/* ============ small helpers ============ */
const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
const pad = n => String(n).padStart(2, '0');
const DAY = 864e5;
const RM = () => matchMedia('(prefers-reduced-motion: reduce)').matches;
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const mean = a => a.reduce((x, y) => x + y, 0) / a.length;
const sd = a => { if (a.length < 2) return 0; const m = mean(a); return Math.sqrt(a.reduce((x, y) => x + (y - m) ** 2, 0) / (a.length - 1)); };
const signed = n => (Math.round(n) > 0 ? '+' : Math.round(n) < 0 ? '−' : '±') + Math.abs(Math.round(n));
const toInput = ts => { const d = new Date(ts); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`; };
const dayKey = ts => toInput(ts).slice(0, 10);
const startOfDay = ts => { const d = new Date(ts); d.setHours(0, 0, 0, 0); return d.getTime(); };
const fmtDay = ts => new Date(ts).toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' });
const fmtTime = ts => new Date(ts).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
/* "Today at 7:05 AM", "Yesterday at 8:30 PM", "Mon, Nov 9 at 7:40 AM" */
function whenText(ts) {
  const diff = Math.round((startOfDay(Date.now()) - startOfDay(ts)) / DAY);
  const day = diff === 0 ? 'Today' : diff === 1 ? 'Yesterday' : fmtDay(ts);
  return `${day} at ${fmtTime(ts)}`;
}
const fmtShort = ts => new Date(ts).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
function ago(ts) {
  const m = Math.round((Date.now() - ts) / 6e4);
  if (m < 1) return 'just now';
  if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h} h ago`;
  const d = Math.round(h / 24);
  return d === 1 ? 'yesterday' : `${d} days ago`;
}
const chip = cat => `<span class="chip cat-${cat}"><i class="d" aria-hidden="true"></i>${CATS[cat].label}</span>`;
const tagPills = tags => tags.map(t => TAG[t] ? `<span class="tagpill">${TAG[t].emoji} ${TAG[t].label}</span>` : '').join('');
const frame = () => new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));

/* ============ state ============ */
const VIEWS = ['today', 'trends', 'insights', 'settings'];
const TITLES = { today: 'Today', trends: 'Trends', insights: 'Insights', settings: 'Settings' };
const state = { sessions: [], view: 'today', period: 'month', anchor: Date.now(), tview: 'chart', pane: 'highlights', tableLimit: 15, editing: null, animChart: true };

function validSession(s) {
  return s && typeof s.id === 'string' && Number.isFinite(s.ts) && Number.isFinite(s.sys) && Number.isFinite(s.dia)
    && s.sys > 40 && s.sys < 300 && s.dia > 20 && s.dia < 200 && Array.isArray(s.tags);
}
function load() {
  try {
    const raw = store.get(STORE_KEY);
    const parsed = raw ? JSON.parse(raw) : [];
    state.sessions = (Array.isArray(parsed) ? parsed : []).filter(validSession);
  } catch (e) { state.sessions = []; }
  state.sessions.sort((a, b) => a.ts - b.ts);
}
function save() {
  store.set(STORE_KEY, JSON.stringify(state.sessions));
  $('#storageWarn').hidden = storageOK;
  // Ask the browser not to evict this origin's storage (matters on Safari for non-installed sites).
  if (state.sessions.length && navigator.storage && navigator.storage.persist) navigator.storage.persist().catch(() => {});
}

/* ============ analytics ============ */
/* The time window the Trends view is showing: a day, a rolling week, a calendar month, or everything. */
function periodWindow() {
  const now = Date.now(), a = Math.min(state.anchor, now);
  if (state.period === 'all') {
    const ss = state.sessions;
    return { from: ss.length ? ss[0].ts - DAY / 4 : now - DAY, to: ss.length ? Math.max(now, ss[ss.length - 1].ts) : now };
  }
  if (state.period === 'day') { const from = startOfDay(a); return { from, to: startOfDay(from + DAY * 1.5) }; }
  if (state.period === 'week') { const e = startOfDay(a); return { from: startOfDay(e - DAY * 5.5), to: startOfDay(e + DAY * 1.5) }; }
  const d = new Date(a);
  return { from: new Date(d.getFullYear(), d.getMonth(), 1).getTime(), to: new Date(d.getFullYear(), d.getMonth() + 1, 1).getTime() };
}
function periodLabel(w) {
  if (state.period === 'all') return 'All time';
  if (state.period === 'day') return w.from === startOfDay(Date.now()) ? 'Today' : new Date(w.from).toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' });
  if (state.period === 'week') return `${fmtShort(w.from)} – ${fmtShort(w.to - 1)}`;
  return new Date(w.from).toLocaleDateString(undefined, { month: 'long', year: 'numeric' });
}
function stepPeriod(dir) {
  const a = new Date(Math.min(state.anchor, Date.now()));
  if (state.period === 'day') state.anchor = a.getTime() + dir * DAY;
  else if (state.period === 'week') state.anchor = a.getTime() + dir * 7 * DAY;
  else if (state.period === 'month') state.anchor = new Date(a.getFullYear(), a.getMonth() + dir, 15).getTime();
  state.anchor = Math.min(state.anchor, Date.now());
}
function rangeSessions() {
  const w = periodWindow();
  return state.sessions.filter(s => s.ts >= w.from && s.ts < w.to);
}

function computeBaseline(all = state.sessions) {
  const std = all.filter(isStandard);
  const days = [...new Set(std.map(s => dayKey(s.ts)))].sort();
  let used = std, dropped = false;
  if (days.length >= 4) { used = std.filter(s => dayKey(s.ts) !== days[0]); dropped = true; }
  const usedDays = new Set(used.map(s => dayKey(s.ts))).size;
  const out = { stdCount: std.length, n: used.length, days: usedDays, dropped };
  const TARGET_N = 14, TARGET_D = 7;
  out.progress = Math.min(1, (Math.min(used.length, TARGET_N) / TARGET_N + Math.min(usedDays, TARGET_D) / TARGET_D) / 2);
  out.needN = Math.max(0, TARGET_N - used.length);
  out.needD = Math.max(0, TARGET_D - usedDays);
  if (used.length < 3) return { ...out, ready: false };
  const S = used.map(s => s.sys), D = used.map(s => s.dia), P = used.map(s => s.pulse).filter(Number.isFinite);
  const sys = mean(S), dia = mean(D);
  return {
    ...out, ready: true, sys, dia, sdS: sd(S), sdD: sd(D),
    pulse: P.length ? mean(P) : null,
    pp: sys - dia, map: dia + (sys - dia) / 3,
    cat: classify(Math.round(sys), Math.round(dia)),
    level: out.progress >= 1 ? 'Solid' : out.progress >= .55 ? 'Building' : 'Early',
  };
}

function contextDeltas(base) {
  if (!base.ready) return [];
  const rows = [];
  for (const t of TAGS) {
    if (t.id === 'rested') continue;
    const ss = state.sessions.filter(s => s.tags.includes(t.id));
    if (ss.length < 2) continue;
    rows.push({ tag: t, n: ss.length, ds: mean(ss.map(s => s.sys)) - base.sys, dd: mean(ss.map(s => s.dia)) - base.dia });
  }
  return rows.sort((a, b) => Math.abs(b.ds) - Math.abs(a.ds));
}

function buildInsights(base) {
  const out = [];
  const ss = state.sessions;
  if (!ss.length) return out;
  const now = Date.now();

  const a = ss.filter(s => s.ts >= now - 7 * DAY), b = ss.filter(s => s.ts < now - 7 * DAY && s.ts >= now - 14 * DAY);
  if (a.length >= 3 && b.length >= 3) {
    const d = mean(a.map(s => s.sys)) - mean(b.map(s => s.sys));
    const dd = mean(a.map(s => s.dia)) - mean(b.map(s => s.dia));
    const flat = Math.abs(d) < 2;
    out.push({ ic: flat ? 'flat' : d < 0 ? 'down' : 'up', title: 'Weekly trend',
      text: flat ? `This week is level with last week (${signed(d)}/${signed(dd)} mmHg).`
        : `This week averages ${signed(d)}/${signed(dd)} mmHg compared with last week (${a.length} vs ${b.length} readings).` });
  }
  if (base.ready) {
    const v = base.sdS;
    out.push({ ic: 'wave', title: 'Day-to-day variability',
      text: `Your systolic varies by about ±${v.toFixed(0)} mmHg under standard conditions. ${v < 8 ? 'That is steady.' : v < 12 ? 'That is typical for home readings.' : 'That is fairly wide. Check that your technique is consistent.'}` });
    const std = ss.filter(isStandard);
    const am = std.filter(s => new Date(s.ts).getHours() < 12), pm = std.filter(s => new Date(s.ts).getHours() >= 12);
    if (am.length >= 3 && pm.length >= 3) {
      const d = mean(am.map(s => s.sys)) - mean(pm.map(s => s.sys));
      out.push({ ic: 'sunrise', title: 'Morning vs afternoon and evening',
        text: Math.abs(d) < 3 ? 'Your mornings and evenings look about the same.' : `Mornings run ${Math.abs(Math.round(d))} mmHg ${d > 0 ? 'higher' : 'lower'} (systolic) than afternoons and evenings.` });
    }
    const ppNote = base.pp < 30 ? 'a bit narrow' : base.pp <= 50 ? 'in the usual range (30–50)' : 'on the wide side (over 50)';
    out.push({ ic: 'pulse', title: 'Pulse pressure and MAP',
      text: `Pulse pressure (systolic minus diastolic) is ${Math.round(base.pp)} mmHg, ${ppNote}. Mean arterial pressure is about ${Math.round(base.map)} mmHg.` });
  }
  const L = ss.filter(s => s.arm === 'L'), R = ss.filter(s => s.arm === 'R');
  if (L.length >= 3 && R.length >= 3) {
    const d = mean(L.map(s => s.sys)) - mean(R.map(s => s.sys));
    out.push({ ic: 'arms', title: 'Left vs right arm',
      text: Math.abs(d) <= 10 ? `Your arms differ by only ${Math.abs(Math.round(d))} mmHg. Either arm is fine, just stay consistent.`
        : `Your ${d > 0 ? 'left' : 'right'} arm reads ${Math.abs(Math.round(d))} mmHg higher. A gap over 10 is worth mentioning to a clinician. Use the higher arm consistently.` });
  }
  const last30 = ss.filter(s => s.ts >= now - 30 * DAY);
  if (last30.length >= 5) {
    const ok = last30.filter(s => classify(s.sys, s.dia) === 'normal').length;
    out.push({ ic: 'target', title: 'Time in normal range',
      text: `${Math.round(ok / last30.length * 100)}% of your readings in the last 30 days were in the normal category (${ok} of ${last30.length}).` });
  }
  if (ss.length >= 6) {
    const pct = Math.round(ss.filter(isStandard).length / ss.length * 100);
    out.push({ ic: 'check', title: 'Measurement quality',
      text: pct >= 70 ? `${pct}% of your readings were taken under standard conditions. That makes your baseline trustworthy.`
        : `Only ${pct}% of readings were under standard conditions (seated, no caffeine, exercise, meal or stress). More of those will sharpen your baseline.` });
  }
  const sk = computeStreak();
  if (sk.current >= 2) out.push({ ic: 'flame', title: `${sk.current}-day streak`, text: `You have logged on ${sk.current} days in a row${sk.best > sk.current ? ` (your best is ${sk.best})` : ''}. Consistency is what turns numbers into a baseline.` });
  return out;
}

/* ============ motion helpers ============ */
const shownVals = {};
function runCounts(root) {
  $$('[data-cu]', root).forEach(el => {
    const key = el.dataset.cu, to = Number(el.dataset.to);
    const prev = shownVals[key];
    shownVals[key] = to;
    el.textContent = to;
    if (RM() || prev === to) return;
    const from = prev ?? Math.max(0, to - Math.max(10, Math.round(to * .14)));
    const t0 = performance.now(), dur = 750;
    const step = t => {
      const p = Math.min(1, (t - t0) / dur), e = 1 - Math.pow(1 - p, 3);
      el.textContent = Math.round(from + (to - from) * e);
      if (p < 1) requestAnimationFrame(step);
    };
    requestAnimationFrame(step);
  });
}
function runRings(root) {
  $$('.ring .prg', root).forEach(c => {
    const C = Number(c.getAttribute('stroke-dasharray')), p = Number(c.dataset.p);
    if (RM()) { c.style.strokeDashoffset = C * (1 - p); return; }
    c.style.strokeDashoffset = C;
    frame().then(() => { c.style.strokeDashoffset = C * (1 - p); });
  });
}
function enter(el) {
  if (RM()) return;
  [...el.children].forEach((c, i) => c.style.setProperty('--i', i));
  el.classList.remove('enter'); void el.offsetWidth; el.classList.add('enter');
  setTimeout(() => el.classList.remove('enter'), 1000);
}

/* ============ sheets ============ */
/* Sheets are plain fixed <div role="dialog" aria-modal="true" hidden> panels with our own scrim.
   No <dialog>, show() or showModal(): on iPhone WebKit every <dialog> variant showed only the dim
   layer. After opening, a self-check confirms the sheet is really on screen; if not, it is forced
   full-screen and a diagnostic banner (klDiag, defined inline in index.html) explains what failed.
   The banner never shows in normal use: only on a failed open, or always with ?debug=1. */
const SHEET_DEBUG = !!window.__klDebug;
const isSheetOpen = d => !!d && d.classList.contains('is-open');
const openSheets = () => $$('.sheet.is-open:not(.closing)');
const finePointer = () => !matchMedia('(pointer: coarse)').matches;
function sizeSheet(d) {
  // px from innerHeight rather than vh/dvh/%: iOS vh is the large viewport and can exceed what is visible.
  const f = d.querySelector('form'); if (!f || d._forced) return;
  const h = window.innerHeight || document.documentElement.clientHeight || 640;
  const desk = matchMedia('(min-width: 820px)').matches;
  f.style.maxHeight = Math.round(desk ? Math.min(h * .88, 820) : h * .92) + 'px';
}
window.addEventListener('resize', () => openSheets().forEach(sizeSheet));
function openSheet(d) {
  try {
    if (!d) throw new Error('Sheet element not found');
    if (isSheetOpen(d) && !d.classList.contains('closing')) return;
    const reopening = isSheetOpen(d);            // reopened mid-close: cancel the close
    clearTimeout(d._closeT); d._closeTok = null; d.classList.remove('closing');
    if (!d._scrim) {
      const scrim = document.createElement('div');
      scrim.className = 'sheet-scrim';
      scrim.addEventListener('click', () => closeSheet(d));
      d.parentNode.insertBefore(scrim, d);
      d._scrim = scrim;
    } else d._scrim.classList.remove('closing');
    if (!reopening) d._returnFocus = document.activeElement;
    sizeSheet(d);
    d.hidden = false;
    d.classList.add('is-open');
    document.documentElement.classList.add('sheet-open');
    // Move focus into the sheet for keyboard and screen-reader users; skipped on touch so iOS never scrolls or pops a keyboard.
    if (finePointer()) { try { d.focus({ preventScroll: true }); } catch (e) { /* ignore */ } }
    const stamp = d._openStamp = Date.now();
    setTimeout(() => checkSheet(d, stamp), 600);
  } catch (err) { sheetFail(d, err, 'openSheet'); }
}
function closeSheet(d) {
  if (!d) return;
  if (!isSheetOpen(d)) { finishClose(d); return; }   // idempotent: still clears any stray scrim
  if (d.classList.contains('closing')) return;
  if (RM()) { finishClose(d); return; }
  d.classList.add('closing');
  if (d._scrim) d._scrim.classList.add('closing');
  const tok = d._closeTok = {};
  const done = e => {
    if (e && e.target !== d) return;
    d.removeEventListener('animationend', done); d.removeEventListener('webkitAnimationEnd', done);
    if (d._closeTok === tok) finishClose(d);
  };
  d.addEventListener('animationend', done); d.addEventListener('webkitAnimationEnd', done);
  d._closeT = setTimeout(done, 350);
}
function finishClose(d) {
  clearTimeout(d._closeT); d._closeTok = null;
  const was = isSheetOpen(d);
  d.classList.remove('is-open', 'closing');
  d.hidden = true;
  if (d._forced) {
    d._forced = false; d.style.cssText = '';
    $$('form, .sheet-body', d).forEach(el => { el.style.cssText = ''; });
  }
  if (d._scrim) { d._scrim.remove(); d._scrim = null; }
  if (!$$('.sheet.is-open').length) document.documentElement.classList.remove('sheet-open');
  if (!was) return;
  const back = d._returnFocus; d._returnFocus = null;
  const a = document.activeElement;
  if (finePointer() && back && back.focus && document.contains(back) && (!a || a === document.body || d.contains(a))) { try { back.focus({ preventScroll: true }); } catch (e) { /* ignore */ } }
  let ev; try { ev = new Event('close'); } catch (e) { ev = document.createEvent('Event'); ev.initEvent('close', false, false); }
  d.dispatchEvent(ev);   // existing 'close' listeners (e.g. the welcome sheet's nameAsked) keep working
}
document.addEventListener('keydown', e => {
  const open = openSheets(), d = open[open.length - 1];
  if (!d) return;
  if (e.key === 'Escape') { e.preventDefault(); closeSheet(d); return; }
  if (e.key !== 'Tab') return;
  // Keep keyboard focus inside the open sheet (aria-modal).
  const items = $$('a[href], button:not([disabled]), input:not([type="hidden"]):not([disabled]), textarea, select, [tabindex]:not([tabindex="-1"])', d)
    .filter(el => el.offsetWidth || el.offsetHeight);
  if (!items.length) return;
  const first = items[0], last = items[items.length - 1], a = document.activeElement;
  if (!d.contains(a)) { e.preventDefault(); first.focus(); }
  else if (e.shiftKey && (a === first || a === d)) { e.preventDefault(); last.focus(); }
  else if (!e.shiftKey && a === last) { e.preventDefault(); first.focus(); }
});
function wireSheet(d, closeBtns) {
  closeBtns.forEach(b => b && b.addEventListener('click', () => closeSheet(d)));
  // Forms no longer use method="dialog"; never let a sheet form navigate, even if its handler throws.
  const f = d.querySelector('form'); if (f) f.addEventListener('submit', e => e.preventDefault());
}

/* ---------- sheet self-check and fallback ---------- */
const describeEl = el => !el ? 'nothing' : el.tagName.toLowerCase() + (el.id ? '#' + el.id : '') + (typeof el.className === 'string' && el.className.trim() ? '.' + el.className.trim().split(/\s+/).join('.') : '');
function sheetReport(d) {
  const r = d.getBoundingClientRect(), cs = getComputedStyle(d), W = window.innerWidth, H = window.innerHeight;
  const f = d.querySelector('form'), fr = f ? f.getBoundingClientRect() : null, vv = window.visualViewport, n = Math.round;
  let problem = '';
  if (cs.display === 'none') problem = 'display is none';
  else if (cs.visibility !== 'visible') problem = 'visibility is ' + cs.visibility;
  else if (parseFloat(cs.opacity) < .5) problem = 'opacity is ' + cs.opacity;
  else if (r.width < 40 || r.height < 40) problem = 'size is ' + n(r.width) + 'x' + n(r.height);
  else if (r.bottom <= 0 || r.top >= H || r.right <= 0 || r.left >= W) problem = 'it is off-screen';
  else {
    // A paint/compositing bug can leave the rect fine while nothing shows: check what is actually hit.
    const x = (Math.max(r.left, 0) + Math.min(r.right, W)) / 2, y = (Math.max(r.top, 0) + Math.min(r.bottom, H)) / 2;
    const hit = document.elementFromPoint(x, y);
    const benign = hit && hit.closest && hit.closest('#klDiag, .toast');   // our own banner/toast is not a failure
    if (!benign && (!hit || !d.contains(hit))) problem = 'its centre is covered by ' + describeEl(hit);
  }
  const text = [
    'sheet #' + d.id + (d._forced ? ' (forced)' : ''),
    'rect x' + n(r.left) + ' y' + n(r.top) + ' w' + n(r.width) + ' h' + n(r.height) + (fr ? ' | form h' + n(fr.height) : ''),
    'viewport ' + W + 'x' + H + (vv ? ' | visual ' + n(vv.width) + 'x' + n(vv.height) + ' top' + n(vv.offsetTop) : '') + ' | scrollY ' + n(window.pageYOffset || 0),
    'display ' + cs.display + ' | position ' + cs.position + ' | opacity ' + cs.opacity + ' | visibility ' + cs.visibility + ' | z ' + cs.zIndex,
    'height ' + cs.height + ' | max-h ' + cs.maxHeight + ' | top ' + cs.top + ' | bottom ' + cs.bottom + ' | transform ' + cs.transform + ' | anim ' + (cs.animationName || cs.webkitAnimationName || ''),
    'HTMLDialogElement ' + typeof window.HTMLDialogElement + ' | color-mix ' + (window.CSS && CSS.supports ? CSS.supports('color', 'color-mix(in srgb, red 50%, blue)') : '?') + ' | coarse ' + !finePointer(),
  ].join('\n');
  return { problem, text };
}
const safeReport = d => { try { return sheetReport(d).text; } catch (e) { return 'report failed: ' + e; } };
function sheetDiag(title, text, ok) {
  try {
    if (window.klDiag) window.klDiag(title, text, ok);
    // Debug mode: the hit test cannot detect a pure paint bug, so let the tester force the fallback by hand.
    const box = document.getElementById('klDiag'), open = openSheets(), d = open[open.length - 1];
    if (ok && box && d) {
      const b = document.createElement('button'); b.type = 'button'; b.textContent = 'Show full-screen';
      b.style.cssText = 'font:600 13px -apple-system,system-ui,sans-serif;color:#000;background:#fff;border:0;border-radius:8px;padding:8px 12px;-webkit-appearance:none;';
      b.onclick = () => { forceSheet(d); b.textContent = 'Forced'; };
      box.appendChild(b);
    }
  } catch (e) { /* ignore */ }
}
function checkSheet(d, stamp) {
  if (!isSheetOpen(d) || d.classList.contains('closing') || d._openStamp !== stamp || d._forced) return;
  let rep;
  try { rep = sheetReport(d); } catch (err) { sheetFail(d, err, 'checkSheet'); return; }
  if (rep.problem) {
    forceSheet(d);
    sheetDiag('This screen did not appear (' + rep.problem + '), so it is now shown full-screen.', rep.text + '\n\nAfter forcing:\n' + safeReport(d));
  } else if (SHEET_DEBUG) sheetDiag('Sheet check passed (debug mode)', rep.text, true);
}
/* Last resort: pin the sheet to the whole screen with inline !important styles and no flex layout. */
function forceSheet(d) {
  if (!d) return;
  d._forced = true;
  d.hidden = false; d.classList.add('is-open'); d.classList.remove('closing');
  document.documentElement.classList.add('sheet-open');
  const bs = getComputedStyle(document.body);
  const bg = bs.backgroundColor && !/rgba\(0, 0, 0, 0\)|transparent/.test(bs.backgroundColor) ? bs.backgroundColor : '#f2f2f7';
  const set = (el, props) => Object.keys(props).forEach(k => el.style.setProperty(k, props[k], 'important'));
  set(d, { display: 'block', position: 'fixed', top: '0px', left: '0px', right: '0px', bottom: '0px', width: '100%', height: '100%',
    'max-width': 'none', 'max-height': 'none', margin: '0px', opacity: '1', visibility: 'visible', transform: 'none', '-webkit-transform': 'none',
    animation: 'none', '-webkit-animation': 'none', 'z-index': '2147483646', overflow: 'auto', '-webkit-overflow-scrolling': 'touch',
    'border-radius': '0px', background: bg, color: bs.color || '#111114', 'padding-top': 'env(safe-area-inset-top)' });
  $$('form', d).forEach(f => set(f, { display: 'block', 'max-height': 'none', height: 'auto', opacity: '1', visibility: 'visible' }));
  $$('.sheet-body', d).forEach(b => set(b, { overflow: 'visible', 'max-height': 'none' }));
}
function sheetFail(d, err, where) {
  const msg = err && err.message ? err.message : String(err);
  try { if (d) forceSheet(d); } catch (e) { /* ignore */ }
  sheetDiag('Something went wrong opening this screen (' + where + ').', msg + (err && err.stack ? '\n' + err.stack : '') + (d ? '\n\n' + safeReport(d) : ''));
}

/* ============ router ============ */
function viewFromHash() { const h = location.hash.slice(1); return VIEWS.includes(h) ? h : null; }
function go(view, animate = true) {
  const changed = state.view !== view;
  state.view = view;
  VIEWS.forEach(v => { $('#view-' + v).hidden = v !== view; });
  $$('[data-nav]').forEach(a => a.dataset.nav === view ? a.setAttribute('aria-current', 'page') : a.removeAttribute('aria-current'));
  $('#navTitle').textContent = TITLES[view];
  document.title = view === 'today' ? 'Kayline — Blood Pressure Tracker' : `${TITLES[view]} · Kayline`;
  if (location.hash !== '#' + view) history.replaceState(null, '', '#' + view);
  state.animChart = animate;
  renderView(view);
  if (animate) { if (changed) window.scrollTo(0, 0); enter($('#view-' + view)); }
  requestAnimationFrame(() => refreshSegs());
}
/* Greeting that follows the time of day and her name. */
const getName = () => String(readMeta().name || '').trim();
function renderTodayHead() {
  const h = new Date().getHours(), name = getName();
  const g = h < 5 ? 'Hi' : h < 12 ? 'Good morning' : h < 17 ? 'Good afternoon' : 'Good evening';
  $('#h-today').textContent = name ? `${g}, ${name}` : 'Today';
}
function maybeWelcome() {
  const m = readMeta();
  if (!m.name && !m.nameAsked && !state.sessions.length && !location.hash.startsWith('#log')) setTimeout(() => { openSheet($('#nameDialog')); if (finePointer()) setTimeout(() => { if (isSheetOpen($('#nameDialog'))) $('#nameIn').focus({ preventScroll: true }); }, 420); }, 700);
}
function renderView(v = state.view) {
  if (v === 'today') { renderTodayHead(); renderStreak(); renderHero(); renderWeek(); renderBackup(); }
  if (v === 'trends') { renderTrend(); renderCategory(); renderContext(); }
  if (v === 'insights') renderPane();
  if (v === 'settings') renderSettings();
}
function renderAll() {
  renderBanners(); renderView();
  $('#todayDate').textContent = new Date().toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric' });
}

/* ============ rendering: today ============ */
function renderHero() {
  const base = computeBaseline();
  const latest = state.sessions[state.sessions.length - 1];
  const bc = $('#baselineCard'), lc = $('#latestCard');

  if (!state.sessions.length) {
    bc.innerHTML = `<div class="empty">
      <div class="card-label">${icon('heart', 16)}Baseline</div>
      <h2>Find your true blood pressure.</h2>
      <p>One reading is a snapshot. Your <strong>baseline</strong> is what your body does when you are rested, seated and unstimulated. Log a few days of readings with what was going on, and Kayline works it out.</p>
      <div class="row2"><button class="btn primary" data-act="log" type="button">Log your first reading</button><button class="btn" data-act="sample" type="button">Explore with sample data</button></div></div>`;
    lc.innerHTML = `<div class="card-label plain">Latest</div><p class="sub" style="margin-top:10px">Nothing yet. Your most recent reading and how it compares with your baseline will show up here.</p>`;
    return;
  }

  if (base.ready) {
    const r = Math.round;
    const marker = pos => Math.max(0, Math.min(100, (pos - 90) / 80 * 100));
    const zones = [['normal', 90, 120], ['elevated', 120, 130], ['stage1', 130, 140], ['stage2', 140, 170]];
    const C = 2 * Math.PI * 23;
    bc.innerHTML = `
      <div class="card-label">${icon('heart', 16)}Baseline</div>
      <div class="big"><span class="val"><span data-cu="bs" data-to="${r(base.sys)}">${r(base.sys)}</span><span class="slash">/</span><span data-cu="bd" data-to="${r(base.dia)}">${r(base.dia)}</span></span><span class="unit">mmHg</span></div>
      <div class="cat-line">${chip(base.cat)}<span class="num">Typical range ${r(base.sys - base.sdS)}–${r(base.sys + base.sdS)} / ${r(base.dia - base.sdD)}–${r(base.dia + base.sdD)}</span></div>
      <div class="zonebar" aria-hidden="true">
        <div class="zones">${zones.map((z, i) => `<span class="cat-${z[0]}" style="flex:${z[2] - z[1]};animation-delay:${i * 70}ms"></span>`).join('')}</div>
        <div class="zone-marker" style="left:${marker(base.sys)}%"></div>
        <div class="zone-labels"><span style="flex:30">Normal</span><span style="flex:10">120</span><span style="flex:10">130</span><span style="flex:30">140</span></div>
      </div>
      <div class="conf">
        <div class="ring" role="progressbar" aria-valuenow="${Math.round(base.progress * 100)}" aria-valuemin="0" aria-valuemax="100" aria-label="Baseline confidence">
          <svg viewBox="0 0 52 52"><circle class="trk" cx="26" cy="26" r="23"/><circle class="prg" cx="26" cy="26" r="23" stroke-dasharray="${C}" data-p="${base.progress}" style="stroke-dashoffset:${C}"/></svg>
          <b>${Math.round(base.progress * 100)}%</b>
        </div>
        <div class="conf-text"><strong>${base.level} confidence</strong>${base.n} rested readings over ${base.days} day${base.days === 1 ? '' : 's'}${base.progress >= 1 ? '' : `. ${base.needN > 0 ? `${base.needN} more reading${base.needN === 1 ? '' : 's'}` : `${base.needD} more day${base.needD === 1 ? '' : 's'}`} would firm it up.`}</div>
      </div>`;
  } else {
    const need = Math.max(0, 3 - base.n);
    bc.innerHTML = `
      <div class="card-label">${icon('heart', 16)}Baseline</div>
      <div class="big"><span class="val" style="color:var(--muted)">–<span class="slash">/</span>–</span><span class="unit">mmHg</span></div>
      <p class="sub" style="margin-top:10px">${need > 0 ? `Log <strong>${need} more standard reading${need === 1 ? '' : 's'}</strong> to see your first baseline.` : 'Almost there.'}</p>
      <p class="fine" style="margin-top:12px">A <strong>standard</strong> reading is taken seated, after resting, with no caffeine, exercise, meal, nicotine, alcohol, stress or full bladder. ${base.stdCount} of your ${state.sessions.length} readings so far qualify.</p>`;
  }

  const L = latest, cat = classify(L.sys, L.dia), std = isStandard(L);
  const delta = base.ready ? `${signed(L.sys - base.sys)}/${signed(L.dia - base.dia)}` : '–';
  lc.innerHTML = `
    <div class="card-label plain">Latest<span class="when">${ago(L.ts)}</span></div>
    <div class="big"><span class="val"><span data-cu="ls" data-to="${L.sys}">${L.sys}</span><span class="slash">/</span><span data-cu="ld" data-to="${L.dia}">${L.dia}</span></span><span class="unit">mmHg</span></div>
    <div class="latest-meta">${chip(cat)}<span class="tagpill ${std ? 'good' : ''}">${std ? 'Standard conditions' : 'Not a standard reading'}</span></div>
    ${L.tags.length ? `<div class="latest-meta">${tagPills(L.tags)}</div>` : ''}
    <div class="stats">
      <div class="stat"><div class="k">Pulse</div><div class="v">${L.pulse ? Math.round(L.pulse) : '–'}<small>bpm</small></div></div>
      <div class="stat"><div class="k">vs baseline</div><div class="v">${delta}</div></div>
      <div class="stat"><div class="k">Pulse pressure</div><div class="v">${L.sys - L.dia}<small>mmHg</small></div></div>
    </div>
    <dl class="kv">
      <div><dt>Taken</dt><dd>${whenText(L.ts)}</dd></div>
      <div><dt>Setup</dt><dd>${L.arm === 'L' ? 'Left' : 'Right'} arm, ${L.pos}${L.readings && L.readings.length > 1 ? `, ${L.readings.length} readings averaged` : ''}</dd></div>
    </dl>`;
  runCounts(bc); runCounts(lc); runRings(bc);
}

function renderBanners() {
  const cr = $('#crisis'), L = state.sessions[state.sessions.length - 1];
  if (L && classify(L.sys, L.dia) === 'crisis' && Date.now() - L.ts < DAY) {
    cr.hidden = false;
    cr.innerHTML = `<strong>Your latest reading (${L.sys}/${L.dia}) is in the hypertensive crisis range.</strong>
      Sit quietly for 5 minutes and measure again. If it is still above 180/120, contact your doctor right away. If you also have chest pain, shortness of breath, weakness, vision changes or trouble speaking, <strong>call emergency services now</strong>.`;
  } else cr.hidden = true;
  $('#sampleBar').hidden = !state.sessions.some(s => s.sample);
}

function renderBackup() {
  const m = readMeta(), real = state.sessions.filter(s => !s.sample).length;
  const due = real >= 7 && Date.now() - (m.lastExport || 0) > 30 * DAY && Date.now() > (m.dismissUntil || 0);
  $('#backupBar').hidden = !due;
}

/* Daily log: a horizontally scrollable strip. Shows about a week at a time, scrolls back through history. */
let weekFromEnd = 0;   // remembered scroll distance from the "today" end, so re-renders keep your place
function renderWeek() {
  const el = $('#weekCard');
  const today = startOfDay(Date.now());
  const dayAt = i => startOfDay(today - i * DAY + DAY / 2);            // i days ago; safe across DST changes
  let n = 7;
  if (state.sessions.length) {
    const first = startOfDay(state.sessions[0].ts);
    n = Math.min(120, Math.max(7, Math.round((today - first) / DAY) + 1));
  }
  const days = []; for (let i = n - 1; i >= 0; i--) days.push(dayAt(i));
  const byDay = {}; state.sessions.forEach(s => { (byDay[dayKey(s.ts)] ||= []).push(s); });
  const cells = days.map(d => {
    const ss = byDay[dayKey(d)] || [];
    const slot = pred => { const m = ss.filter(pred); return m.length ? (m.some(isStandard) ? 'std' : 'non') : ''; };
    const am = slot(s => new Date(s.ts).getHours() < 12), pm = slot(s => new Date(s.ts).getHours() >= 12);
    const dt = new Date(d);
    const mark = v => v === 'std' ? '✓' : v === 'non' ? '•' : '';
    const label = dt.getDate() === 1 || d === days[0] ? dt.toLocaleDateString(undefined, { month: 'short' }) : dt.toLocaleDateString(undefined, { weekday: 'narrow' });
    return `<div class="day ${d === today ? 'today' : ''}" aria-label="${fmtDay(d)}"><div class="dn">${label}</div><div class="dd">${dt.getDate()}</div>
      <div class="dots"><span class="dot ${am}" title="Morning">${mark(am) || 'AM'}</span><span class="dot ${pm}" title="Afternoon or evening">${mark(pm) || 'PM'}</span></div></div>`;
  }).join('');
  el.innerHTML = `<div class="week-head"><div><h2 class="t">Daily log</h2><p class="sub" id="weekRange" style="margin:2px 0 0"></p></div><button class="btn small" id="weekToday" type="button" hidden>Jump to today</button></div>
    <div class="week-scroll" id="weekScroll" tabindex="0" role="group" aria-label="Daily log, scroll sideways for earlier days"><div class="week">${cells}</div></div>
    <div class="week-key"><span><i class="dot std" style="display:inline-grid"></i>Standard</span><span><i class="dot non" style="display:inline-grid"></i>Not standard</span><span><i class="dot" style="display:inline-grid"></i>Missing</span><span>Goal: a morning and an evening reading</span></div>`;

  const sc = $('#weekScroll'), rng = $('#weekRange'), jump = $('#weekToday');
  const update = () => {
    const cells = $$('.day', sc); if (!cells.length) return;
    const sr = sc.getBoundingClientRect();
    weekFromEnd = Math.max(0, sc.scrollWidth - sc.clientWidth - sc.scrollLeft);
    let a = 0, b = cells.length - 1;
    for (let i = 0; i < cells.length; i++) { const r = cells[i].getBoundingClientRect(); if (r.left + r.width / 2 >= sr.left) { a = i; break; } }
    for (let i = cells.length - 1; i >= 0; i--) { const r = cells[i].getBoundingClientRect(); if (r.left + r.width / 2 <= sr.right) { b = i; break; } }
    rng.textContent = a >= b ? fmtShort(days[a]) : `${fmtShort(days[a])} – ${fmtShort(days[b])}`;
    jump.hidden = weekFromEnd < 8;
  };
  const toEnd = smooth => sc.scrollTo({ left: sc.scrollWidth, behavior: smooth && !RM() ? 'smooth' : 'auto' });
  // Rest on today (or on the spot she was last at). Layout can still be settling on first paint, so re-apply until she touches it.
  const fromEnd = weekFromEnd; let touched = false;
  ['pointerdown', 'wheel', 'touchstart'].forEach(ev => sc.addEventListener(ev, () => { touched = true; }, { passive: true }));
  const place = () => { if (touched) return; sc.scrollLeft = Math.max(0, sc.scrollWidth - sc.clientWidth - fromEnd); update(); };
  requestAnimationFrame(place); setTimeout(place, 150); setTimeout(place, 600);
  if (document.fonts && document.fonts.ready) document.fonts.ready.then(place);
  let raf = 0; sc.addEventListener('scroll', () => { if (!raf) raf = requestAnimationFrame(() => { raf = 0; update(); }); }, { passive: true });
  jump.addEventListener('click', () => toEnd(true));
}

/* ============ streak ============
   A day counts if at least one reading was logged. The streak is forgiving: one missed day in any
   7-day stretch is covered by a "shield" and does not break it. Only logging counts, never the values. */
const MILESTONES = [3, 7, 14, 21, 30, 50, 75, 100, 150, 200, 300, 365];
const dkAgo = i => dayKey(startOfDay(startOfDay(Date.now()) - i * DAY + DAY / 2));

function computeStreak(all = state.sessions) {
  const set = new Set(all.map(s => dayKey(s.ts)));
  const loggedToday = set.has(dkAgo(0));
  const out = { current: 0, best: 0, loggedToday, total: set.size, forgiven: new Set(), set, shieldReady: true, shieldIn: 0, atRisk: false };
  if (!set.size) return out;
  const first = Math.min(...all.map(s => s.ts));
  const span = Math.round((startOfDay(Date.now()) - startOfDay(first)) / DAY);     // how many days ago the first reading was
  let lastF = null, firstF = null, count = 0;
  for (let i = loggedToday ? 0 : 1; i <= span; i++) {                                // walk back; an unlogged today is still pending
    if (set.has(dkAgo(i))) { count++; continue; }
    if (lastF === null || i - lastF >= 7) { out.forgiven.add(dkAgo(i)); lastF = i; if (firstF === null) firstF = i; continue; }
    break;
  }
  out.current = count;
  out.shieldReady = firstF === null || firstF >= 7;
  out.shieldIn = firstF !== null && firstF < 7 ? 7 - firstF : 0;
  out.atRisk = !loggedToday && count > 0 && firstF === 1;                            // yesterday was covered, so today matters
  let run = 0, best = 0, lastMiss = -99;                                             // best run, same rule, oldest to newest
  for (let d = span; d >= 0; d--) {
    const idx = span - d;
    if (set.has(dkAgo(d))) { run++; best = Math.max(best, run); }
    else if (d === 0) { /* today still pending */ }
    else if (idx - lastMiss >= 7) lastMiss = idx;
    else run = 0;
  }
  out.best = Math.max(best, out.current);
  return out;
}
const nextMilestone = n => MILESTONES.find(m => m > n) ?? n + (100 - n % 100);
const prevMilestone = n => [...MILESTONES].reverse().find(m => m <= n) ?? 0;

const FLAME = '<svg class="flame-svg" viewBox="0 0 24 24" aria-hidden="true"><path class="f1" d="M12 2.5c.7 3.8 5 5.6 5 10.2a5 5 0 0 1-10 0c0-1.7.8-3 1.8-4 .3 1.4 1 2.2 2 2.4-.4-3-.1-6.2 1.2-8.6z"/><path class="f2" d="M12 21a2.8 2.8 0 0 0 2.8-2.8c0-1.7-1.6-2.5-2.2-4-1.4 1.1-3.4 2.3-3.4 4A2.8 2.8 0 0 0 12 21z"/></svg>';
const SHIELD = '<svg class="i" width="14" height="14" viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3l7 3v5c0 4.5-3 8.2-7 10-4-1.8-7-5.5-7-10V6z"/></svg>';

function streakMessage(st) {
  if (!st.total) return 'Log your first reading to start a streak.';
  if (st.current === 0) return st.best > 1 ? `Fresh start. Your best run was ${st.best} days, and you can beat it.` : 'Log a reading to start a new streak.';
  if (st.loggedToday) return st.current === 1 ? 'Day one is done. Come back tomorrow.' : 'Done for today. See you tomorrow.';
  if (st.atRisk) return 'Your shield covered yesterday. Log today to keep your streak alive.';
  return new Date().getHours() < 17 ? 'Log a reading today to keep it going.' : 'Still time tonight. Log a reading to keep your streak.';
}

function renderStreak() {
  const el = $('#streakCard'), st = computeStreak();
  const flame = st.current === 0 ? 'off' : st.loggedToday ? 'lit' : 'ember';
  el.classList.toggle('nudge', !st.loggedToday && st.current > 0 && (st.atRisk || new Date().getHours() >= 17));   // a warmer card when the day is running out
  const next = nextMilestone(st.current), prev = prevMilestone(st.current);
  const pct = st.current === 0 ? 0 : Math.round((st.current - prev) / (next - prev) * 100);
  const today = startOfDay(Date.now());
  const dots = []; for (let i = 6; i >= 0; i--) {
    const d = startOfDay(today - i * DAY + DAY / 2), k = dayKey(d), dt = new Date(d);
    const cls = st.set.has(k) ? 'logged' : st.forgiven.has(k) ? 'cover' : i === 0 ? 'today' : 'miss';
    const mark = cls === 'logged' ? '✓' : cls === 'cover' ? '' : '';
    dots.push(`<div class="sd ${cls}" style="--i:${6 - i}"><span class="b" title="${fmtDay(d)}">${cls === 'cover' ? SHIELD : mark}</span><span class="l">${dt.toLocaleDateString(undefined, { weekday: 'narrow' })}</span></div>`);
  }
  const shield = st.current === 0 ? '' : st.shieldReady
    ? `<span class="shield ready" title="Miss one day in a week and your streak survives">${SHIELD}Shield ready</span>`
    : `<span class="shield used" title="Your shield covered a missed day. It recharges in ${st.shieldIn} day${st.shieldIn === 1 ? '' : 's'}.">${SHIELD}Recharging · ${st.shieldIn}d</span>`;
  el.innerHTML = `
    <div class="streak-top">
      <div class="flame ${flame}">${FLAME}</div>
      <div class="streak-main">
        <div class="streak-num"><span class="n num" data-cu="streak" data-to="${st.current}">${st.current}</span><span class="l">day streak</span></div>
        <p class="streak-msg">${streakMessage(st)}</p>
      </div>
    </div>
    <div class="sweek" role="img" aria-label="Last 7 days. ${st.set.size ? 'Days with a reading are checked.' : ''}">${dots.join('')}</div>
    <div class="streak-foot">
      <div class="mile">
        <div class="mbar" role="progressbar" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${pct}" aria-label="Progress to the next streak goal"><i style="width:${pct}%"></i></div>
        <span class="mtxt">${st.current === 0 ? `First goal: ${next} days` : `${next - st.current} day${next - st.current === 1 ? '' : 's'} to ${next}`}</span>
      </div>
      <div class="sbadges">${shield}${st.best > 0 ? `<span class="best">Best ${st.best}</span>` : ''}</div>
    </div>
    ${st.loggedToday ? '' : '<button class="btn primary block streak-cta" data-act="log" type="button">Log today\'s reading</button>'}
    <p class="fine streak-note">Streaks count the days you measured, whatever the numbers were.</p>`;
  runCounts(el);
}

/* Plain-text summary of the period on screen, for sharing with a partner or doctor. */
function buildSummaryText() {
  const ss = rangeSessions(), win = periodWindow(), base = computeBaseline(), r = Math.round;
  const lines = [`Blood pressure summary · ${periodLabel(win)}`];
  if (!ss.length) return lines.concat('No readings in this period.').join('\n');
  const hi = ss.reduce((a, b) => (b.sys > a.sys ? b : a)), lo = ss.reduce((a, b) => (b.sys < a.sys ? b : a));
  const avgS = r(mean(ss.map(s => s.sys))), avgD = r(mean(ss.map(s => s.dia)));
  const normal = ss.filter(s => classify(s.sys, s.dia) === 'normal').length;
  const pulses = ss.map(s => s.pulse).filter(Number.isFinite);
  lines.push('', `Readings: ${ss.length} (${ss.filter(isStandard).length} under standard conditions)`,
    `Average: ${avgS}/${avgD} mmHg (${CATS[classify(avgS, avgD)].label})`,
    `Highest: ${hi.sys}/${hi.dia} on ${fmtShort(hi.ts)}`, `Lowest: ${lo.sys}/${lo.dia} on ${fmtShort(lo.ts)}`);
  if (pulses.length) lines.push(`Average pulse: ${r(mean(pulses))} bpm`);
  lines.push(`In the normal range: ${r(normal / ss.length * 100)}% of readings`);
  if (base.ready) lines.push('', `Baseline (rested, seated readings): ${r(base.sys)}/${r(base.dia)} mmHg, typical range ${r(base.sys - base.sdS)}–${r(base.sys + base.sdS)} over ${r(base.dia - base.sdD)}–${r(base.dia + base.sdD)}`);
  const fx = contextDeltas(base).slice(0, 3);
  if (fx.length) lines.push('', 'What moved the numbers: ' + fx.map(x => `${x.tag.label.toLowerCase()} ${signed(x.ds)}/${signed(x.dd)}`).join(', '));
  const st = computeStreak();
  if (st.current > 1) lines.push('', `Logging streak: ${st.current} days`);
  lines.push('', 'Home readings only. Not a diagnosis. Made with Kayline.');
  return lines.join('\n');
}
async function shareSummary() {
  const text = buildSummaryText(), title = `Blood pressure summary · ${periodLabel(periodWindow())}`;
  if (navigator.share) { try { await navigator.share({ title, text }); return; } catch (e) { if (e && e.name === 'AbortError') return; } }
  try { await navigator.clipboard.writeText(text); toast('Summary copied. Paste it into a message.'); } catch (e) { toast('Could not share. Try Export CSV in Settings.'); }
}

/* Milestone celebration: a short, tasteful moment. */
function celebrate(n) {
  const el = $('#celebrate');
  const lines = { 3: 'Three days in a row. A habit is forming.', 7: 'A full week. That is what makes a real baseline.', 14: 'Two weeks of readings. Your baseline is getting reliable.', 21: 'Three weeks. This is a habit now.', 30: 'A whole month of showing up for your health.' };
  $('#celTitle').textContent = `${n}-day streak`;
  const base = lines[n] || `${n} days of looking after yourself. Keep it going.`, who = getName();
  $('#celText').textContent = who ? `${who}, ${base[0].toLowerCase()}${base.slice(1)}` : base;
  $('#celFlame').innerHTML = FLAME;
  const burst = $('#celBurst'); burst.innerHTML = '';
  if (!RM()) for (let i = 0; i < 18; i++) {
    const a = (i / 18) * Math.PI * 2, r = 90 + Math.random() * 70;
    const s = document.createElement('i');
    s.style.cssText = `--dx:${Math.cos(a) * r}px;--dy:${Math.sin(a) * r}px;--c:${['var(--flame)', 'var(--flame-2)', 'var(--s1)', 'var(--s3)'][i % 4]};--d:${Math.random() * 120}ms`;
    burst.appendChild(s);
  }
  el.hidden = false; el.classList.remove('out');
  $('#celClose').focus();
  if (navigator.vibrate) navigator.vibrate([12, 40, 12]);
}
function closeCelebrate() {
  const el = $('#celebrate'); if (el.hidden) return;
  if (RM()) { el.hidden = true; return; }
  el.classList.add('out'); setTimeout(() => { el.hidden = true; el.classList.remove('out'); }, 260);
}

/* Daily reminder as a repeating calendar event (works offline, no server or push needed). */
function downloadReminder() {
  const time = $('#remTime').value || '20:00', [hh, mm] = time.split(':');
  writeMeta({ remTime: time });
  const now = new Date(), start = new Date(now.getFullYear(), now.getMonth(), now.getDate(), +hh, +mm);
  if (start <= now) start.setDate(start.getDate() + 1);
  const p = n => String(n).padStart(2, '0');
  const local = d => `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}T${p(d.getHours())}${p(d.getMinutes())}00`;
  const stamp = `${now.getUTCFullYear()}${p(now.getUTCMonth() + 1)}${p(now.getUTCDate())}T${p(now.getUTCHours())}${p(now.getUTCMinutes())}${p(now.getUTCSeconds())}Z`;
  const url = location.origin + location.pathname;
  const ics = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Kayline//Blood Pressure//EN', 'CALSCALE:GREGORIAN', 'BEGIN:VEVENT',
    `UID:kayline-reminder-${uid()}@kayline`, `DTSTAMP:${stamp}`, `DTSTART:${local(start)}`, 'DURATION:PT10M', 'RRULE:FREQ=DAILY',
    'SUMMARY:Take your blood pressure reading', `DESCRIPTION:Log it in Kayline: ${url}`, `URL:${url}`,
    'BEGIN:VALARM', 'TRIGGER:PT0M', 'ACTION:DISPLAY', 'DESCRIPTION:Time for your reading', 'END:VALARM', 'END:VEVENT', 'END:VCALENDAR'].join('\r\n');
  download('kayline-daily-reminder.ics', ics, 'text/calendar');
  toast('Reminder downloaded. Open it to save it to your calendar.');
}

/* ============ charts ============ */
const tip = $('#tip');
function hideTip() { tip.hidden = true; }

function tipHTML(s, base) {
  const cat = classify(s.sys, s.dia);
  const d = base && base.ready ? `<div class="t-row"><span class="tagpill">${signed(s.sys - base.sys)}/${signed(s.dia - base.dia)} vs baseline</span></div>` : '';
  return `<div class="t-when">${fmtDay(s.ts)} · ${fmtTime(s.ts)}</div>
    <div class="t-val">${s.sys}/${s.dia} <span class="unit">mmHg</span>${s.pulse ? ` · ${Math.round(s.pulse)} <span class="unit">bpm</span>` : ''}</div>
    <div class="t-row">${chip(cat)}${isStandard(s) ? '' : '<span class="tagpill">not standard</span>'}</div>
    ${s.tags.length ? `<div class="t-row">${tagPills(s.tags)}</div>` : ''}${d}
    ${s.note ? `<div class="t-note">“${esc(s.note)}”</div>` : ''}`;
}

function niceDayTicks(xmin, xmax, maxTicks) {
  const span = xmax - xmin;
  if (span <= 2 * DAY) {
    const step = span <= 8 * 36e5 ? 36e5 : 6 * 36e5; const out = [];
    for (let t = startOfDay(xmin); t <= xmax; t += step) if (t >= xmin) out.push({ t, label: new Date(t).toLocaleTimeString(undefined, { hour: 'numeric' }) });
    return out;
  }
  const days = Math.ceil(span / DAY), step = Math.max(1, Math.ceil(days / maxTicks));
  const out = []; let t = startOfDay(xmin) + DAY;
  for (; t <= xmax; t += step * DAY) out.push({ t, label: fmtShort(t) });
  return out;
}

/* Generic line chart: one or more series sharing ONE y-axis. */
function lineChart(el, o) {
  const { pts, series, xmin, xmax, h, baselines = [], aria, animate } = o;
  hideTip();
  if (!pts.length) { el.innerHTML = `<div class="empty-chart">No readings in this range yet.</div>`; return; }
  const W = Math.max(280, el.clientWidth || 600), H = h;
  const m = { l: 34, r: o.mr ?? (series.length > 1 ? 72 : 14), t: 12, b: 26 };
  const vals = pts.flatMap(p => series.map(s => p[s.key])).filter(Number.isFinite).concat(baselines.map(b => b.v));
  let lo = Math.floor((Math.min(...vals) - 8) / 10) * 10, hi = Math.ceil((Math.max(...vals) + 8) / 10) * 10;
  if (hi - lo < 40) { const c = (hi + lo) / 2; lo = Math.floor((c - 20) / 10) * 10; hi = lo + 40; }
  const step = hi - lo > 90 ? 20 : 10;
  const x = t => m.l + (t - xmin) / Math.max(1, xmax - xmin) * (W - m.l - m.r);
  const y = v => m.t + (1 - (v - lo) / (hi - lo)) * (H - m.t - m.b);

  let g = '';
  for (let v = Math.ceil(lo / step) * step; v <= hi; v += step) {
    const key = (o.emph || []).includes(v);   // 120 / 80 reference lines are drawn heavier
    g += `<line x1="${m.l}" x2="${W - m.r}" y1="${y(v)}" y2="${y(v)}" stroke="${key ? 'var(--muted)' : 'var(--grid)'}" stroke-width="${key ? 1.25 : 1}" ${key ? 'opacity=".55"' : ''}/><text x="${m.l - 8}" y="${y(v) + 4}" text-anchor="end" ${key ? 'style="font-weight:700;fill:var(--ink-2)"' : ''}>${v}</text>`;
  }
  const xt = niceDayTicks(xmin, xmax, W < 520 ? 4 : 7);
  for (const k of xt) if (x(k.t) > m.l + 10 && x(k.t) < W - m.r - 10)
    g += `<text x="${x(k.t)}" y="${H - 6}" text-anchor="middle">${k.label}</text>`;
  for (const b of baselines)
    g += `<line x1="${m.l}" x2="${W - m.r}" y1="${y(b.v)}" y2="${y(b.v)}" stroke="${b.color}" stroke-width="1.5" stroke-dasharray="5 4" opacity=".6"/>`;

  let lines = '', dots = '', labels = '';
  for (const s of series) {
    const P = pts.filter(p => Number.isFinite(p[s.key]));
    if (!P.length) continue;
    if (P.length > 1) lines += `<polyline ${animate ? 'class="draw" pathLength="1"' : ''} fill="none" stroke="${s.color}" stroke-width="2" stroke-linejoin="round" stroke-linecap="round" points="${P.map(p => `${x(p.ts).toFixed(1)},${y(p[s.key]).toFixed(1)}`).join(' ')}"/>`;
    for (const p of P) {
      const std = isStandard(p);
      dots += `<circle cx="${x(p.ts).toFixed(1)}" cy="${y(p[s.key]).toFixed(1)}" r="${std ? 3.5 : 4}" fill="${std ? s.color : 'var(--card)'}" stroke="${std ? 'var(--card)' : s.color}" stroke-width="2"/>`;
    }
    if (series.length > 1) {
      const last = P[P.length - 1];
      labels += `<text class="lbl" x="${W - m.r + 10}" y="${y(last[s.key]) + 4}">${s.label}</text>`;
    }
  }

  el.innerHTML = `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="${esc(aria)}">${g}${lines}<g class="${animate ? 'fade-dots' : ''}">${dots}</g>${labels}
    <g class="xh" display="none"><line stroke="var(--muted)" stroke-width="1" stroke-dasharray="3 3" y1="${m.t}" y2="${H - m.b}"/></g>
    <g class="hl"></g><rect class="hit" x="${m.l}" y="0" width="${W - m.l - m.r}" height="${H}" fill="transparent"/></svg>`;

  const svg = $('svg', el), hit = $('.hit', svg), xh = $('.xh', svg), hl = $('.hl', svg), xline = $('line', xh);
  const show = e => {
    const r = svg.getBoundingClientRect(), sx = W / r.width;
    const px = (e.clientX - r.left) * sx;
    let best = pts[0], bd = Infinity;
    for (const p of pts) { const d = Math.abs(x(p.ts) - px); if (d < bd) { bd = d; best = p; } }
    const cx = x(best.ts);
    xh.removeAttribute('display'); xline.setAttribute('x1', cx); xline.setAttribute('x2', cx);
    hl.innerHTML = series.filter(s => Number.isFinite(best[s.key])).map(s => `<circle cx="${cx}" cy="${y(best[s.key])}" r="6.5" fill="${s.color}" stroke="var(--card)" stroke-width="2.5"/>`).join('');
    if (o.onHover) o.onHover(best);
    tip.innerHTML = o.tip(best); tip.hidden = false;
    const tw = tip.offsetWidth, th = tip.offsetHeight;
    let left = e.clientX + 16; if (left + tw > innerWidth - 8) left = e.clientX - tw - 16; left = Math.max(8, left);
    let top = e.clientY - th - 12; if (top < 8) top = e.clientY + 18;
    tip.style.left = left + 'px'; tip.style.top = top + 'px';
  };
  const leave = () => { xh.setAttribute('display', 'none'); hl.innerHTML = ''; hideTip(); if (o.onHover) o.onHover(null); };
  hit.addEventListener('pointermove', show); hit.addEventListener('pointerdown', show);
  hit.addEventListener('pointerleave', leave); hit.addEventListener('pointercancel', leave);
}

function renderTrend() {
  const ss = rangeSessions();
  const base = computeBaseline();
  const win = periodWindow(), xmin = win.from, xmax = win.to;

  $$('#rangeSeg button').forEach(b => b.setAttribute('aria-pressed', String(b.dataset.period === state.period)));
  $('#pLabel').textContent = periodLabel(win);
  $('#periodNav').classList.toggle('static', state.period === 'all');
  $('#pNext').disabled = state.period === 'all' || win.to > Date.now();
  $('#pPrev').disabled = state.period === 'all' || !state.sessions.length || win.from <= state.sessions[0].ts - (state.period === 'month' ? 31 * DAY : 0);
  $$('#viewSeg button').forEach(b => b.setAttribute('aria-pressed', String(b.dataset.view === state.tview)));
  $('#chartView').hidden = state.tview !== 'chart';
  $('#tableView').hidden = state.tview !== 'table';

  const avgS = ss.length ? Math.round(mean(ss.map(s => s.sys))) : null, avgD = ss.length ? Math.round(mean(ss.map(s => s.dia))) : null;
  $('#trendSub').textContent = ss.length ? `${ss.length} reading${ss.length === 1 ? '' : 's'} · average ${avgS}/${avgD} mmHg` : 'No readings in this range';

  const lg = [`<span><i class="sw" style="--c:var(--s1)"></i>Systolic</span>`, `<span><i class="sw" style="--c:var(--s2)"></i>Diastolic</span>`];
  if (base.ready) lg.push(`<span><i class="sw dash" style="--c:var(--ink-2)"></i>Your baseline</span>`);
  lg.push(`<span><i class="mk fill"></i>Standard</span><span><i class="mk"></i>Not standard</span>`);
  $('#trendLegend').innerHTML = lg.join('');
  renderReadout(null);
  renderPeriodStats(ss);

  if (state.tview === 'table') { renderTable(ss); return; }

  const animate = state.animChart && !RM(); state.animChart = false;
  const narrow = innerWidth < 520;
  lineChart($('#bpChart'), {
    pts: ss, xmin, xmax, h: narrow ? 260 : 320, animate, emph: [120, 80], onHover: renderReadout,
    series: [{ key: 'sys', label: 'Systolic', color: 'var(--s1)' }, { key: 'dia', label: 'Diastolic', color: 'var(--s2)' }],
    baselines: base.ready ? [{ v: base.sys, color: 'var(--s1)' }, { v: base.dia, color: 'var(--s2)' }] : [],
    aria: ss.length ? `Systolic and diastolic blood pressure over time. Average ${avgS} over ${avgD} millimetres of mercury across ${ss.length} readings.` : 'No data',
    tip: s => tipHTML(s, base),
  });
  const withPulse = ss.filter(s => Number.isFinite(s.pulse));
  lineChart($('#pulseChart'), {
    pts: withPulse, xmin, xmax, h: 160, animate, mr: 72,
    series: [{ key: 'pulse', label: 'Pulse', color: 'var(--s3)' }],
    aria: 'Pulse over time in beats per minute',
    tip: s => tipHTML(s, base),
  });
  if (!withPulse.length) $('#pulseChart').innerHTML = `<div class="empty-chart">Add pulse to your readings to see it here.</div>`;
}

/* Readout above the chart: the period average, or the exact reading under your finger / cursor. */
function renderReadout(p) {
  const ss = rangeSessions(), src = p ? [p] : ss;
  const v = (k) => src.length ? Math.round(mean(src.map(s => s[k]))) : '--';
  const when = p ? `${fmtDay(p.ts)} · ${fmtTime(p.ts)}` : (ss.length ? `Average of ${ss.length} reading${ss.length === 1 ? '' : 's'}` : 'No readings in this period');
  $('#readout').innerHTML = `<div class="ro-when">${when}</div>
    <div class="ro-cols">
      <div><span class="ro-tag"><i style="--c:var(--s1)"></i>Systolic</span><div class="ro-val num">${v('sys')}<span class="unit"> mmHg</span></div></div>
      <div><span class="ro-tag"><i style="--c:var(--s2)"></i>Diastolic</span><div class="ro-val num">${v('dia')}<span class="unit"> mmHg</span></div></div>
    </div>`;
}

/* Swipeable summary cards for the period on screen. */
function renderPeriodStats(ss) {
  const el = $('#periodStats');
  if (!ss.length) { el.innerHTML = `<div class="mini wide"><div class="k">No readings in this period</div><div class="s">Step back with the arrows above, or log a reading.</div></div>`; return; }
  const hi = ss.reduce((a, b) => (b.sys > a.sys ? b : a)), lo = ss.reduce((a, b) => (b.sys < a.sys ? b : a));
  const pulses = ss.map(s => s.pulse).filter(Number.isFinite);
  const normal = ss.filter(s => classify(s.sys, s.dia) === 'normal').length;
  const std = ss.filter(isStandard).length;
  const card = (k, v, s, cat) => `<div class="mini"><div class="k">${k}</div><div class="v num">${v}</div><div class="s">${s}</div>${cat ? chip(cat) : ''}</div>`;
  const avgS = Math.round(mean(ss.map(s => s.sys))), avgD = Math.round(mean(ss.map(s => s.dia)));
  el.innerHTML = [
    card('Average', `${avgS}/${avgD}`, 'mmHg', classify(avgS, avgD)),
    card('Highest', `${hi.sys}/${hi.dia}`, `${fmtShort(hi.ts)}, ${fmtTime(hi.ts)}`, classify(hi.sys, hi.dia)),
    card('Lowest', `${lo.sys}/${lo.dia}`, `${fmtShort(lo.ts)}, ${fmtTime(lo.ts)}`, classify(lo.sys, lo.dia)),
    pulses.length ? card('Pulse', Math.round(mean(pulses)), 'bpm average') : '',
    card('In normal range', `${Math.round(normal / ss.length * 100)}%`, `${normal} of ${ss.length} readings`),
    card('Standard readings', std, `of ${ss.length} counted for baseline`),
  ].join('');
}

function renderTable(ss) {
  const el = $('#tableView');
  if (!ss.length) { el.innerHTML = `<div class="empty-chart">No readings in this range yet.</div>`; return; }
  const rows = [...ss].reverse();
  const shown = rows.slice(0, state.tableLimit);
  el.innerHTML = `<div class="tbl-wrap"><table class="hist"><thead><tr><th>When</th><th>BP</th><th>Pulse</th><th>Category</th><th>Setup</th><th>Context</th><th></th></tr></thead><tbody>
    ${shown.map(s => `<tr><td class="num">${fmtDay(s.ts)}<br><span class="unit">${fmtTime(s.ts)}</span></td>
      <td class="v">${s.sys}/${s.dia}${s.readings && s.readings.length > 1 ? `<br><span class="unit">avg of ${s.readings.length}</span>` : ''}</td>
      <td class="num">${s.pulse ? Math.round(s.pulse) : '–'}</td><td>${chip(classify(s.sys, s.dia))}</td>
      <td>${s.arm === 'L' ? 'Left' : 'Right'}, ${s.pos}${isStandard(s) ? '' : '<br><span class="unit">not standard</span>'}</td>
      <td>${tagPills(s.tags)}${s.note ? `<div class="unit" style="margin-top:2px">“${esc(s.note)}”</div>` : ''}</td>
      <td class="act"><button type="button" data-edit="${esc(s.id)}">Edit</button><button type="button" class="del" data-del="${esc(s.id)}">Delete</button></td></tr>`).join('')}
    </tbody></table></div>
    ${rows.length > shown.length ? `<p style="text-align:center;margin-top:10px"><button class="btn small" id="moreRows" type="button">Show more (${rows.length - shown.length} left)</button></p>` : ''}`;
}

/* ============ rendering: trends extras ============ */
function renderCategory() {
  const ss = rangeSessions(), el = $('#catCard');
  const label = periodLabel(periodWindow()).toLowerCase();
  if (!ss.length) { el.innerHTML = `<h2 class="t">Categories</h2><p class="sub">Once you log readings, you will see how they split across categories (${label}).</p>`; return; }
  const counts = {}; ss.forEach(s => { const c = classify(s.sys, s.dia); counts[c] = (counts[c] || 0) + 1; });
  const present = CAT_ORDER.filter(c => counts[c]);
  el.innerHTML = `<h2 class="t">Categories</h2><p class="sub">Share of readings, ${label}</p>
    <div class="stack" role="img" aria-label="${present.map(c => `${CATS[c].label} ${Math.round(counts[c] / ss.length * 100)}%`).join(', ')}">${present.map((c, i) => `<span class="cat-${c}" style="flex:${counts[c]};animation-delay:${i * 70}ms" title="${CATS[c].label}: ${counts[c]}"></span>`).join('')}</div>
    <div class="cat-list">${present.map(c => `<div class="cat-row cat-${c}"><span class="sq"></span><span>${CATS[c].label}</span><span class="rng">${CATS[c].sys}/${CATS[c].dia}</span><span class="n">${counts[c]} · ${Math.round(counts[c] / ss.length * 100)}%</span></div>`).join('')}</div>`;
}

function renderContext() {
  const el = $('#ctxCard'), base = computeBaseline();
  if (!base.ready) {
    el.innerHTML = `<h2 class="t">What moves your numbers</h2><p class="sub">Once your baseline is set and you have tagged a few readings (coffee, exercise, stress, poor sleep), you will see how much each one shifts your pressure.</p>`;
    return;
  }
  const rows = contextDeltas(base).slice(0, 6);
  if (!rows.length) {
    el.innerHTML = `<h2 class="t">What moves your numbers</h2><p class="sub">Tag at least two readings with the same context (for example, after coffee) to see how much it moves your pressure compared with your baseline.</p>`;
    return;
  }
  el.innerHTML = `<h2 class="t">What moves your numbers</h2><p class="sub">Average change vs your baseline of ${Math.round(base.sys)}/${Math.round(base.dia)}</p>
    <div class="delta-list">${rows.map((r, i) => {
      const w = Math.min(50, Math.abs(r.ds) / 20 * 50);
      return `<div class="delta"><span class="nm">${r.tag.label}<small>${r.n} readings</small></span><span class="dv">${signed(r.ds)}<span class="unit"> / ${signed(r.dd)}</span></span>
        <div class="track" aria-hidden="true"><div class="fill ${r.ds >= 0 ? 'up' : 'down'}" style="width:${w}%;animation-delay:${i * 60}ms"></div></div></div>`;
    }).join('')}</div>`;
}

/* ============ rendering: insights panes ============ */
function renderHighlights() {
  const list = buildInsights(computeBaseline()), el = $('#insights');
  if (!list.length) { el.innerHTML = `<article class="card"><h2 class="t">No highlights yet</h2><p class="sub" style="margin-top:6px">Log a handful of readings and patterns will show up here: weekly trend, morning vs evening, arm difference and more.</p></article>`; return; }
  el.innerHTML = list.map(i => `<article class="insight"><div class="ic">${icon(i.ic)}</div><h3>${esc(i.title)}</h3><p>${esc(i.text)}</p></article>`).join('');
}
function renderPane(animate = false) {
  const p = state.pane;
  $$('#insSeg button').forEach(b => b.setAttribute('aria-pressed', String(b.dataset.pane === p)));
  ['highlights', 'report', 'chat'].forEach(n => { $('#pane-' + n).hidden = n !== p; });
  if (p === 'highlights') renderHighlights();
  if (p === 'report') AI.renderReport($('#pane-report'));
  if (p === 'chat') AI.renderChat($('#pane-chat'));
  if (animate) enter($('#pane-' + p));
}

/* ============ rendering: settings ============ */
function renderSettings() {
  const has = state.sessions.length > 0;
  $('#loadSample').hidden = has;
  $('#wipe').hidden = !has;
  $('#exportJson').hidden = $('#exportCsv').hidden = !has;
  const mode = store.get(THEME_KEY) || 'auto';
  $$('#themeSeg button').forEach(b => b.setAttribute('aria-pressed', String(b.dataset.themeSet === mode)));
  $('#remTime').value = readMeta().remTime || '20:00';
  if (document.activeElement !== $('#setName')) $('#setName').value = getName();
  $('#aiRowSub').textContent = AI.statusText();
  $('#aiRow .row-t').textContent = AI.connected() ? 'Claude AI' : 'Connect Claude';
  updateInstallUI();
  renderGuideTable();
}
function renderGuideTable() {
  $('#catTable').innerHTML = ['normal', 'elevated', 'stage1', 'stage2', 'crisis'].map(c =>
    `<tr><td>${chip(c)}</td><td class="num">${CATS[c].sys}</td><td>${CATS[c].and}</td><td class="num">${CATS[c].dia}</td></tr>`).join('');
}

/* ============ theme + install ============ */
function applyTheme(mode) {
  if (mode === 'light' || mode === 'dark') document.documentElement.setAttribute('data-theme', mode);
  else document.documentElement.removeAttribute('data-theme');
  void document.documentElement.offsetHeight;   // force a style recalc (iOS can skip it)
  const lc = $('#tcLight'), dc = $('#tcDark');
  if (mode === 'dark') { lc.content = dc.content = '#000000'; }
  else if (mode === 'light') { lc.content = dc.content = '#f2f2f7'; }
  else { lc.content = '#f2f2f7'; dc.content = '#000000'; }
}
let deferredInstall = null;
const isStandalone = () => matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;
const isIOS = () => /iphone|ipad|ipod/i.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
function updateInstallUI() {
  const canPrompt = !!deferredInstall, ios = isIOS() && !canPrompt;
  const show = !isStandalone() && (canPrompt || ios);
  $('#installGroup').hidden = !show;
  $('#installBtn').hidden = !canPrompt;
  $('#iosHint').hidden = !ios;
}

/* ============ log form ============ */
let form = { arm: 'L', pos: 'seated', tags: new Set() };

function rowHTML(i) {
  return `<div class="rrow" data-i="${i}">
    <label class="cell"><span>Systolic <em>mmHg</em></span><input type="number" inputmode="numeric" min="60" max="260" placeholder="120" data-f="sys" aria-label="Systolic, reading ${i + 1}"></label>
    <label class="cell"><span>Diastolic <em>mmHg</em></span><input type="number" inputmode="numeric" min="30" max="160" placeholder="80" data-f="dia" aria-label="Diastolic, reading ${i + 1}"></label>
    <label class="cell"><span>Pulse <em>bpm</em></span><input type="number" inputmode="numeric" min="30" max="220" placeholder="65" data-f="pulse" aria-label="Pulse, reading ${i + 1}"></label>
    <button type="button" class="rm" aria-label="Remove reading ${i + 1}" ${i === 0 ? 'hidden' : ''}>×</button></div>`;
}
function readRows() {
  return $$('.rrow').map(r => ({ sys: parseInt($('[data-f=sys]', r).value, 10), dia: parseInt($('[data-f=dia]', r).value, 10), pulse: parseInt($('[data-f=pulse]', r).value, 10) }));
}
function addRow(vals) {
  const box = $('#readingRows'), i = $$('.rrow').length;
  if (i >= 3) return;
  box.insertAdjacentHTML('beforeend', rowHTML(i));
  const r = box.lastElementChild;
  if (vals) { $('[data-f=sys]', r).value = vals.sys ?? ''; $('[data-f=dia]', r).value = vals.dia ?? ''; $('[data-f=pulse]', r).value = vals.pulse ?? ''; }
  $('#addRow').hidden = i + 1 >= 3;
}
function updatePreview() {
  $('#saveLog').disabled = !readRows().some(r => Number.isFinite(r.sys) && Number.isFinite(r.dia));   // dimmed until there is something to save
  const rs = readRows().filter(r => Number.isFinite(r.sys) && Number.isFinite(r.dia) && r.sys > r.dia);
  const pv = $('#preview');
  if (!rs.length) { pv.innerHTML = ''; return; }
  const s = Math.round(mean(rs.map(r => r.sys))), d = Math.round(mean(rs.map(r => r.dia))), c = classify(s, d);
  pv.innerHTML = `${rs.length > 1 ? `Average <strong class="num">${s}/${d}</strong>` : `<strong class="num">${s}/${d}</strong>`} ${chip(c)}${c === 'crisis' ? ' <strong>Rest and measure again. If still this high, seek care.</strong>' : ''}`;
}
function updateStdNote() {
  const ok = form.pos === 'seated' && ![...form.tags].some(t => DISTURBERS.includes(t));
  $('#stdNote').textContent = ok ? 'Counts toward your baseline' : 'Tracked, but not counted toward your baseline';
}
function syncFormUI() {
  $$('#armSeg button').forEach(b => b.setAttribute('aria-pressed', String(b.dataset.v === form.arm)));
  $$('#posSeg button').forEach(b => b.setAttribute('aria-pressed', String(b.dataset.v === form.pos)));
  $$('#tagChips button').forEach(b => b.setAttribute('aria-pressed', String(form.tags.has(b.dataset.t))));
  updateStdNote();
}
function openLog(session) {
  // Open the sheet even if preparing the form fails, then report the error (see sheetFail).
  let setupErr = null;
  try { prepLog(session); } catch (err) { setupErr = err; }
  openSheet($('#logDialog'));
  if (setupErr) sheetFail(null, setupErr, 'openLog setup');
  requestAnimationFrame(() => { try { refreshSegs(); } catch (e) { /* cosmetic */ } });
  // Autofocus only with a real keyboard; on phones it pops the keyboard over the sheet (and iOS can shove the sheet off-screen).
  if (finePointer()) setTimeout(() => { const f = $('[data-f=sys]'); if (f && !session && isSheetOpen($('#logDialog'))) f.focus({ preventScroll: true }); }, 380);
}
function prepLog(session) {
  state.editing = session ? session.id : null;
  $('#logTitle').textContent = session ? 'Edit reading' : 'New reading';
  $('#readingRows').innerHTML = '';
  $('#formError').hidden = true;
  const last = state.sessions[state.sessions.length - 1];
  form = { arm: session ? session.arm : (last ? last.arm : 'L'), pos: session ? session.pos : 'seated', tags: new Set(session ? session.tags : []) };
  $('#tagChips').innerHTML = TAGS.map(t => `<button type="button" data-t="${t.id}" aria-pressed="false"><span class="em" aria-hidden="true">${t.emoji}</span>${t.label}</button>`).join('');
  setWhen(session ? session.ts : Date.now());
  $('#fNote').value = session ? (session.note || '') : '';
  const rd = session ? (session.readings && session.readings.length ? session.readings : [{ sys: session.sys, dia: session.dia, pulse: session.pulse }]) : [null];
  rd.forEach(r => addRow(r));
  syncFormUI(); updatePreview();
}
/* Date and time: friendly pills over native pickers, kept in sync with one hidden value (YYYY-MM-DDTHH:mm). */
function setWhen(ts) {
  const v = toInput(ts);
  $('#fWhen').value = v; $('#fDate').value = v.slice(0, 10); $('#fTime').value = v.slice(11, 16);
  $('#fDate').max = toInput(Date.now()).slice(0, 10);
  updateWhenText();
}
function updateWhenText() {
  const ts = new Date($('#fWhen').value).getTime(); if (!Number.isFinite(ts)) return;
  const diff = Math.round((startOfDay(Date.now()) - startOfDay(ts)) / DAY);
  $('#dateText').textContent = diff === 0 ? 'Today' : diff === 1 ? 'Yesterday' : new Date(ts).toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' });
  $('#timeText').textContent = fmtTime(ts);
}
function onWhenInput() {
  const d = $('#fDate').value, t = $('#fTime').value;
  if (d && t) { $('#fWhen').value = `${d}T${t}`; updateWhenText(); }
}
function quickTime(kind) {
  const d = new Date();
  if (kind === 'am') d.setHours(8, 0, 0, 0);
  if (kind === 'pm') d.setHours(20, 0, 0, 0);
  if (d.getTime() > Date.now()) d.setDate(d.getDate() - 1);
  setWhen(d.getTime());
}

/* ============ glass segmented controls: a sliding thumb behind the selected option ============ */
function layoutSeg(seg) {
  let t = seg.querySelector(':scope > .thumb');
  const fresh = !t;
  if (fresh) { t = document.createElement('i'); t.className = 'thumb'; t.setAttribute('aria-hidden', 'true'); t.style.transition = 'none'; seg.prepend(t); }
  const on = seg.querySelector('button[aria-pressed="true"]');
  if (!on || !seg.offsetWidth) { t.style.opacity = '0'; return; }
  const nl = on.offsetLeft, nw = on.offsetWidth, nt = on.offsetTop;
  // Liquid glass: on a tap, the thumb stretches across to the new option, then settles (Web Animations, no libraries).
  if (seg.classList.contains('glass') && seg._anim && !fresh && !RM() && t.dataset.l !== undefined && (Number(t.dataset.l) !== nl || Number(t.dataset.w) !== nw)) {
    const ol = Number(t.dataset.l), ow = Number(t.dataset.w), left = Math.min(ol, nl), span = Math.max(ol + ow, nl + nw) - left;
    t.animate([
      { transform: `translate(${ol}px, ${nt}px) scale(1, 1)`, width: ow + 'px', offset: 0 },
      { transform: `translate(${left}px, ${nt}px) scale(1, .9)`, width: span + 'px', offset: .42 },
      { transform: `translate(${nl}px, ${nt}px) scale(1, 1)`, width: nw + 'px', offset: 1 },
    ], { duration: 560, easing: 'cubic-bezier(.32,.72,0,1)' });
    t.classList.remove('shine'); void t.offsetWidth; t.classList.add('shine');
  }
  seg._anim = false;
  t.dataset.l = nl; t.dataset.w = nw;
  t.style.opacity = '1'; t.style.width = nw + 'px'; t.style.height = on.offsetHeight + 'px';
  t.style.transform = `translate(${nl}px, ${nt}px)`;
  if (fresh) requestAnimationFrame(() => { t.style.transition = ''; });
}
function refreshSegs() { $$('.seg').forEach(layoutSeg); }
let segRaf = 0;
function watchSegs() {
  const sched = () => { if (!segRaf) segRaf = requestAnimationFrame(() => { segRaf = 0; refreshSegs(); }); };
  new MutationObserver(sched).observe(document.body, { subtree: true, childList: true, attributes: true, attributeFilter: ['aria-pressed'] });
  window.addEventListener('resize', sched); window.addEventListener('load', sched);
  if (document.fonts && document.fonts.ready) document.fonts.ready.then(sched);
  sched();
}
function submitForm(e) {
  e.preventDefault();
  const err = m => { const el = $('#formError'); el.textContent = m; el.hidden = false; el.scrollIntoView({ block: 'nearest', behavior: RM() ? 'auto' : 'smooth' }); };
  const ts = new Date($('#fWhen').value).getTime();
  if (!Number.isFinite(ts)) return err('Please pick a date and time.');
  if (ts > Date.now() + 5 * 6e4) return err('That time is in the future.');
  const rs = readRows().filter(r => Number.isFinite(r.sys) || Number.isFinite(r.dia));
  if (!rs.length) return err('Enter your systolic and diastolic numbers from the cuff.');
  for (const [i, r] of rs.entries()) {
    const n = rs.length > 1 ? ` (reading ${i + 1})` : '';
    if (!Number.isFinite(r.sys) || !Number.isFinite(r.dia)) return err(`Please fill both systolic and diastolic${n}.`);
    if (r.sys < 60 || r.sys > 260) return err(`Systolic should be between 60 and 260${n}.`);
    if (r.dia < 30 || r.dia > 160) return err(`Diastolic should be between 30 and 160${n}.`);
    if (r.sys <= r.dia) return err(`Systolic should be higher than diastolic${n}. Did the numbers get swapped?`);
    if (Number.isFinite(r.pulse) && (r.pulse < 30 || r.pulse > 220)) return err(`Pulse should be between 30 and 220${n}.`);
  }
  const clean = rs.map(r => ({ sys: r.sys, dia: r.dia, pulse: Number.isFinite(r.pulse) ? r.pulse : null }));
  const pulses = clean.map(r => r.pulse).filter(Number.isFinite);
  const prev = state.editing ? state.sessions.find(s => s.id === state.editing) : null;
  const s = {
    id: prev ? prev.id : uid(), ts, readings: clean,
    sys: Math.round(mean(clean.map(r => r.sys))), dia: Math.round(mean(clean.map(r => r.dia))),
    pulse: pulses.length ? Math.round(mean(pulses)) : null,
    arm: form.arm, pos: form.pos, tags: [...form.tags], note: $('#fNote').value.trim(),
  };
  if (prev && prev.sample) s.sample = true;
  const before = computeStreak(), snap = state.sessions;      // snap lets "Undo" put everything back exactly
  state.sessions = state.sessions.filter(x => x.id !== s.id).concat(s).sort((a, b) => a.ts - b.ts);
  save(); closeSheet($('#logDialog'));
  state.animChart = false; renderAll();
  const after = computeStreak(), grew = !prev && after.current > before.current;
  const hit = grew && MILESTONES.includes(after.current);
  const catLabel = CATS[classify(s.sys, s.dia)].label;
  toast(prev ? 'Reading updated' : grew && !hit ? `Saved ${s.sys}/${s.dia} · ${after.current}-day streak` : `Saved ${s.sys}/${s.dia} · ${catLabel}`,
    { label: 'Undo', fn: () => { state.sessions = snap; save(); state.animChart = false; renderAll(); toast(prev ? 'Change undone' : 'Reading removed'); } });
  if (classify(s.sys, s.dia) === 'crisis') go('today');
  if (hit) setTimeout(() => { if (computeStreak().current >= after.current) celebrate(after.current); }, 650);
}

/* ============ data tools ============ */
let toastT;
function toast(msg, act) {
  const t = $('#toast'); t.textContent = '';
  const s = document.createElement('span'); s.textContent = msg; t.append(s);
  if (act) {
    const b = document.createElement('button'); b.type = 'button'; b.className = 'toast-act'; b.textContent = act.label;
    b.addEventListener('click', () => { clearTimeout(toastT); t.hidden = true; act.fn(); });
    t.append(b);
  }
  t.hidden = false; t.style.animation = 'none'; void t.offsetWidth; t.style.animation = '';
  clearTimeout(toastT); toastT = setTimeout(() => { t.hidden = true; }, act ? 6000 : 3200);
}
function download(name, text, type) {
  const url = URL.createObjectURL(new Blob([text], { type })), a = document.createElement('a');
  a.href = url; a.download = name; document.body.appendChild(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(url), 1000);
}
function exportJson() {
  const mine = state.sessions.filter(s => !s.sample);
  download(`kayline-backup-${dayKey(Date.now())}.json`, JSON.stringify({ app: 'baseline-bp', version: 1, exportedAt: new Date().toISOString(), sessions: mine }, null, 2), 'application/json');
  writeMeta({ lastExport: Date.now() }); renderBackup(); toast('Backup exported');
}
function exportCsv() {
  const q = v => `"${String(v ?? '').replace(/"/g, '""')}"`;
  const head = ['datetime', 'systolic', 'diastolic', 'pulse', 'readings_averaged', 'arm', 'position', 'category', 'standard_conditions', 'context', 'note'];
  const lines = state.sessions.filter(s => !s.sample).map(s => [toInput(s.ts).replace('T', ' '), s.sys, s.dia, s.pulse ?? '', (s.readings || []).length || 1, s.arm, s.pos, CATS[classify(s.sys, s.dia)].label, isStandard(s) ? 'yes' : 'no', s.tags.map(t => TAG[t]?.label || t).join('; '), s.note].map(q).join(','));
  download(`kayline-readings-${dayKey(Date.now())}.csv`, [head.join(','), ...lines].join('\n'), 'text/csv');
  writeMeta({ lastExport: Date.now() }); renderBackup(); toast('CSV exported');
}
function importJson(file) {
  const rd = new FileReader();
  rd.onload = () => {
    try {
      const data = JSON.parse(rd.result);
      const list = Array.isArray(data) ? data : data.sessions;
      const good = (list || []).filter(validSession).map(s => ({ ...s, tags: s.tags.filter(t => TAG[t]), pos: ['seated', 'standing', 'lying'].includes(s.pos) ? s.pos : 'seated', arm: s.arm === 'R' ? 'R' : 'L', note: String(s.note || '').slice(0, 200) }));
      if (!good.length) throw new Error('none');
      const have = new Set(state.sessions.map(s => s.id));
      const fresh = good.filter(s => !have.has(s.id));
      state.sessions = state.sessions.concat(fresh).sort((a, b) => a.ts - b.ts);
      save(); renderAll(); toast(`Imported ${fresh.length} new reading${fresh.length === 1 ? '' : 's'}${good.length - fresh.length ? ` (${good.length - fresh.length} already here)` : ''}`);
    } catch (e) { toast('That file does not look like a Kayline backup.'); }
  };
  rd.readAsText(file);
}

function makeSample() {
  let seed = 11; const rnd = () => (seed = seed * 16807 % 2147483647) / 2147483647;
  const g = () => (rnd() + rnd() + rnd() - 1.5) * 1.6;
  const out = [], today = startOfDay(Date.now());
  for (let d = 27; d >= 0; d--) {
    for (const slot of ['am', 'pm']) {
      if (rnd() < .1) continue;
      const hour = slot === 'am' ? 7 + rnd() * 1.5 : 19.5 + rnd() * 2;
      const ts = today - d * DAY + hour * 36e5;
      if (ts > Date.now()) continue;
      let sys = 120 - (27 - d) * .06 + (slot === 'am' ? 2.5 : 0) + g() * 3.2, dia = 76.5 + (slot === 'am' ? 1.5 : 0) + g() * 2.4, pulse = 66 + g() * 3.5;
      const tags = [], r = rnd();
      if (r < .14) { tags.push('caffeine'); sys += 8; dia += 4; pulse += 4; }
      else if (r < .22) { tags.push('exercise'); sys += 14; dia += 3; pulse += 16; }
      else if (r < .32) { tags.push('stressed'); sys += 9; dia += 5; pulse += 6; }
      else if (r < .40) { tags.push('sleep'); sys += 5; dia += 3; }
      else if (r < .45) { tags.push('meal'); sys += 3; dia += 2; }
      else if (r < .75) tags.push('rested');
      const readings = [1, -1].map(k => ({ sys: Math.round(sys + k * 1.5 + g()), dia: Math.round(dia + k + g() * .6), pulse: Math.round(pulse + g()) }));
      out.push({ id: 'sample-' + out.length, sample: true, ts, readings,
        sys: Math.round(mean(readings.map(x => x.sys))), dia: Math.round(mean(readings.map(x => x.dia))), pulse: Math.round(mean(readings.map(x => x.pulse))),
        arm: rnd() < .85 ? 'L' : 'R', pos: 'seated', tags, note: tags.includes('caffeine') ? 'Double espresso' : '' });
    }
  }
  return out;
}
function loadSample() { state.sessions = makeSample(); save(); state.animChart = true; renderAll(); }

/* ============ wiring ============ */
function wire() {
  const logDlg = $('#logDialog');
  wireSheet(logDlg, [$('#cancelLog')]);
  $('#openLog').addEventListener('click', () => openLog());
  $('#openLogDesk').addEventListener('click', () => openLog());
  $('#logForm').addEventListener('submit', submitForm);
  $('#readingRows').addEventListener('input', updatePreview);
  $('#readingRows').addEventListener('click', e => {
    if (e.target.classList.contains('rm')) { e.target.closest('.rrow').remove(); $$('.rrow').forEach((r, i) => { r.dataset.i = i; $('.rm', r).hidden = i === 0; }); $('#addRow').hidden = false; updatePreview(); }
  });
  $('#addRow').addEventListener('click', () => { addRow(); const rs = $$('.rrow'); $('[data-f=sys]', rs[rs.length - 1]).focus(); });
  $('#quickTimes').addEventListener('click', e => { const q = e.target.dataset.q; if (!q) return; if (q === 'now') setWhen(Date.now()); else quickTime(q); });
  ['#fDate', '#fTime'].forEach(s => $(s).addEventListener('input', onWhenInput));
  ['#datePill', '#timePill'].forEach(s => $(s).addEventListener('click', e => { const i = $('input', e.currentTarget); if (e.target !== i) { try { i.showPicker(); } catch (err) { i.focus(); } } }));

  // Welcome sheet and name setting
  const nameDlg = $('#nameDialog');
  wireSheet(nameDlg, [$('#nameSkip')]);
  nameDlg.addEventListener('close', () => { writeMeta({ nameAsked: true }); renderTodayHead(); });
  $('#nameForm').addEventListener('submit', e => { e.preventDefault(); const n = $('#nameIn').value.trim(); if (n) writeMeta({ name: n }); closeSheet(nameDlg); renderTodayHead(); });
  $('#setName').addEventListener('input', e => { writeMeta({ name: e.target.value.trim() }); renderTodayHead(); });
  $('#armSeg').addEventListener('click', e => { if (e.target.dataset.v) { $('#armSeg')._anim = true; form.arm = e.target.dataset.v; syncFormUI(); if (navigator.vibrate) navigator.vibrate(6); } });
  $('#posSeg').addEventListener('click', e => { if (e.target.dataset.v) { $('#posSeg')._anim = true; form.pos = e.target.dataset.v; syncFormUI(); if (navigator.vibrate) navigator.vibrate(6); } });
  $('#tagChips').addEventListener('click', e => { const b = e.target.closest('button'); if (!b) return; const t = b.dataset.t; form.tags.has(t) ? form.tags.delete(t) : form.tags.add(t); syncFormUI(); if (navigator.vibrate) navigator.vibrate(6); });

  $('#rangeSeg').addEventListener('click', e => { if (e.target.dataset.period) { state.period = e.target.dataset.period; state.anchor = Date.now(); state.tableLimit = 15; state.animChart = true; renderTrend(); renderCategory(); renderContext(); } });
  const step = dir => { stepPeriod(dir); state.tableLimit = 15; state.animChart = true; renderTrend(); renderCategory(); };
  $('#pPrev').addEventListener('click', () => step(-1));
  $('#pNext').addEventListener('click', () => step(1));
  $('#viewSeg').addEventListener('click', e => { if (e.target.dataset.view) { state.tview = e.target.dataset.view; state.animChart = true; renderTrend(); } });
  $('#insSeg').addEventListener('click', e => { if (e.target.dataset.pane) { state.pane = e.target.dataset.pane; renderPane(true); } });
  $('#tableView').addEventListener('click', e => {
    const t = e.target;
    if (t.dataset.edit) { const s = state.sessions.find(x => x.id === t.dataset.edit); if (s) openLog(s); }
    if (t.dataset.del) {   // no confirm dialog: delete right away, with a few seconds to undo
      const snap = state.sessions;
      state.sessions = state.sessions.filter(x => x.id !== t.dataset.del); save(); state.animChart = false; renderAll();
      toast('Reading deleted', { label: 'Undo', fn: () => { state.sessions = snap; save(); state.animChart = false; renderAll(); toast('Reading restored'); } });
    }
    if (t.id === 'moreRows') { state.tableLimit += 20; renderTrend(); }
  });
  document.addEventListener('click', e => {
    const a = e.target.closest('[data-act]'); if (!a) return;
    if (a.dataset.act === 'log') openLog();
    if (a.dataset.act === 'sample') loadSample();
    if (a.dataset.act === 'ai') AI.openSetup();
  });

  $$('#themeSeg button').forEach(b => b.addEventListener('click', () => { const m = b.dataset.themeSet; store.set(THEME_KEY, m); applyTheme(m); renderSettings(); }));
  $('#exportJson').addEventListener('click', exportJson);
  $('#exportCsv').addEventListener('click', exportCsv);
  $('#importBtn').addEventListener('click', () => $('#importFile').click());
  $('#importFile').addEventListener('change', e => { if (e.target.files[0]) importJson(e.target.files[0]); e.target.value = ''; });
  $('#loadSample').addEventListener('click', () => { loadSample(); toast('Sample data loaded. Clear it any time.'); });
  $('#clearSample').addEventListener('click', () => { const snap = state.sessions; state.sessions = state.sessions.filter(s => !s.sample); save(); renderAll(); toast('Sample data cleared', { label: 'Undo', fn: () => { state.sessions = snap; save(); renderAll(); } }); });
  $('#wipe').addEventListener('click', () => {
    if (confirm('Delete ALL readings stored in this browser? Export a backup first if you want to keep them.')) { state.sessions = []; save(); AI.clearReport(); renderAll(); toast('All data deleted'); }
  });
  $('#backupNow').addEventListener('click', exportJson);
  $('#backupLater').addEventListener('click', () => { writeMeta({ dismissUntil: Date.now() + 14 * DAY }); renderBackup(); });
  $('#aiRow').addEventListener('click', () => AI.openSetup());
  $('#celClose').addEventListener('click', closeCelebrate);
  $('#celebrate').addEventListener('click', e => { if (e.target.id === 'celebrate') closeCelebrate(); });
  document.addEventListener('keydown', e => { if (e.key === 'Escape') closeCelebrate(); });
  $('#remBtn').addEventListener('click', downloadReminder);
  $('#shareSummary').addEventListener('click', shareSummary);
  // Coming back to the app later in the day (or after midnight) should show the current streak state.
  document.addEventListener('visibilitychange', () => { if (!document.hidden && state.view === 'today') { weekFromEnd = 0; renderTodayHead(); renderStreak(); renderWeek(); } });
  $('#remTime').addEventListener('change', e => writeMeta({ remTime: e.target.value }));
  $('#installBtn').addEventListener('click', async () => {
    if (!deferredInstall) return;
    deferredInstall.prompt(); try { await deferredInstall.userChoice; } catch (e) {}
    deferredInstall = null; updateInstallUI();
  });

  window.addEventListener('beforeinstallprompt', e => { e.preventDefault(); deferredInstall = e; updateInstallUI(); });
  window.addEventListener('appinstalled', () => { deferredInstall = null; updateInstallUI(); toast('Kayline installed'); });
  window.addEventListener('hashchange', () => {
    if (location.hash === '#log') { history.replaceState(null, '', '#' + state.view); openLog(); return; }
    const v = viewFromHash(); if (v && v !== state.view) go(v);
  });
  window.addEventListener('scroll', () => { document.body.classList.toggle('scrolled', scrollY > 40); hideTip(); }, { passive: true });
  matchMedia('(display-mode: standalone)').addEventListener?.('change', updateInstallUI);
  window.addEventListener('online', () => renderPane());
  window.addEventListener('offline', () => renderPane());

  // Reserve exactly as much space as the bottom tab bar really occupies (it varies with safe areas).
  const tb = $('.tabbar'), setTab = () => document.documentElement.style.setProperty('--tabbar-h', tb.offsetHeight + 'px');
  new ResizeObserver(setTab).observe(tb); setTab();

  let rt; new ResizeObserver(() => { clearTimeout(rt); rt = setTimeout(() => { if (state.view === 'trends' && state.tview === 'chart') renderTrend(); }, 120); }).observe($('#view-trends'));
  AI.init();
}

/* ============ boot ============ */
load();
applyTheme(store.get(THEME_KEY) || 'auto');
wire();
renderBanners();
$('#todayDate').textContent = new Date().toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric' });
$('#storageWarn').hidden = storageOK;
{
  const wantsLog = location.hash === '#log';
  go(viewFromHash() || 'today');
  if (wantsLog) { history.replaceState(null, '', '#' + state.view); openLog(); }
  watchSegs();
  maybeWelcome();
}
if ('serviceWorker' in navigator && location.protocol.startsWith('http')) {
  window.addEventListener('load', () => navigator.serviceWorker.register('sw.js').catch(() => {}));
}
