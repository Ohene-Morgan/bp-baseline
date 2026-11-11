'use strict';
/* Baseline — blood pressure tracker. No build step, no dependencies.
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
  { id: 'rested',   label: 'Rested 5+ min',  disturbs: false },
  { id: 'caffeine', label: 'Caffeine',       disturbs: true },
  { id: 'exercise', label: 'Exercise',       disturbs: true },
  { id: 'meal',     label: 'Just ate',       disturbs: true },
  { id: 'stressed', label: 'Stressed',       disturbs: true },
  { id: 'sleep',    label: 'Poor sleep',     disturbs: false },
  { id: 'alcohol',  label: 'Alcohol',        disturbs: true },
  { id: 'nicotine', label: 'Nicotine',       disturbs: true },
  { id: 'bladder',  label: 'Full bladder',   disturbs: true },
  { id: 'ill',      label: 'Ill or in pain', disturbs: true },
  { id: 'meds',     label: 'Took meds',      disturbs: false },
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
const tagPills = tags => tags.map(t => TAG[t] ? `<span class="tagpill">${TAG[t].label}</span>` : '').join('');
const frame = () => new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));

/* ============ state ============ */
const VIEWS = ['today', 'trends', 'insights', 'settings'];
const TITLES = { today: 'Today', trends: 'Trends', insights: 'Insights', settings: 'Settings' };
const state = { sessions: [], view: 'today', range: '30', tview: 'chart', pane: 'highlights', tableLimit: 15, editing: null, animChart: true };

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
function rangeSessions() {
  if (state.range === 'all') return state.sessions;
  const from = Date.now() - Number(state.range) * DAY;
  return state.sessions.filter(s => s.ts >= from);
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
  const keys = new Set(ss.map(s => dayKey(s.ts)));
  let streak = 0; for (let i = 0; i < 365; i++) { if (keys.has(dayKey(now - i * DAY))) streak++; else if (i === 0) continue; else break; }
  if (streak >= 2) out.push({ ic: 'flame', title: `${streak}-day streak`, text: 'You have logged readings on consecutive days. Consistency is what turns numbers into a baseline.' });
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
function openSheet(d) { d.classList.remove('closing'); if (!d.open) d.showModal(); }
function closeSheet(d) {
  if (!d.open || d.classList.contains('closing')) return;
  if (RM()) { d.close(); return; }
  let done = false;
  const finish = () => { if (done) return; done = true; d.classList.remove('closing'); d.close(); };
  d.classList.add('closing');
  d.addEventListener('animationend', e => { if (e.target === d) finish(); });
  setTimeout(finish, 450);
}
function wireSheet(d, closeBtns) {
  d.addEventListener('cancel', e => { e.preventDefault(); closeSheet(d); });
  d.addEventListener('click', e => { if (e.target === d) closeSheet(d); });
  closeBtns.forEach(b => b && b.addEventListener('click', () => closeSheet(d)));
}

/* ============ router ============ */
function viewFromHash() { const h = location.hash.slice(1); return VIEWS.includes(h) ? h : null; }
function go(view, animate = true) {
  const changed = state.view !== view;
  state.view = view;
  VIEWS.forEach(v => { $('#view-' + v).hidden = v !== view; });
  $$('[data-nav]').forEach(a => a.dataset.nav === view ? a.setAttribute('aria-current', 'page') : a.removeAttribute('aria-current'));
  $('#navTitle').textContent = TITLES[view];
  document.title = view === 'today' ? 'Baseline — Blood Pressure Tracker' : `${TITLES[view]} · Baseline`;
  if (location.hash !== '#' + view) history.replaceState(null, '', '#' + view);
  state.animChart = animate;
  renderView(view);
  if (animate) { if (changed) window.scrollTo(0, 0); enter($('#view-' + view)); }
}
function renderView(v = state.view) {
  if (v === 'today') { renderHero(); renderWeek(); renderBackup(); }
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
      <p>One reading is a snapshot. Your <strong>baseline</strong> is what your body does when you are rested, seated and unstimulated. Log a few days of readings with what was going on, and Baseline works it out.</p>
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
      <div class="cat-line">${chip(base.cat)}<span class="num">Typical ${r(base.sys - base.sdS)}–${r(base.sys + base.sdS)} over ${r(base.dia - base.sdD)}–${r(base.dia + base.sdD)}${base.pulse ? ` · ${r(base.pulse)} bpm` : ''}</span></div>
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
        <div class="conf-text"><strong>${base.level} confidence</strong>${base.n} standard readings over ${base.days} day${base.days === 1 ? '' : 's'}. ${base.progress >= 1 ? 'Enough for a reliable baseline.' : `About ${base.needN} more readings across ${base.needD || 'a few more'} day${base.needD === 1 ? '' : 's'} will firm it up.`}${base.dropped ? ' First day excluded.' : ''}</div>
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
    <div class="latest-meta">${chip(cat)}<span class="tagpill">${std ? 'Standard conditions' : 'Not standard'}</span>${tagPills(L.tags)}</div>
    <p class="sub num" style="margin-top:10px">${fmtDay(L.ts)}, ${fmtTime(L.ts)}${L.readings && L.readings.length > 1 ? ` · average of ${L.readings.length}` : ''} · ${L.arm === 'L' ? 'left' : 'right'} arm, ${L.pos}</p>
    <div class="stats">
      <div class="stat"><div class="k">Pulse</div><div class="v">${L.pulse ? Math.round(L.pulse) : '–'}<small>bpm</small></div></div>
      <div class="stat"><div class="k">vs baseline</div><div class="v">${delta}</div></div>
      <div class="stat"><div class="k">Pulse pressure</div><div class="v">${L.sys - L.dia}<small>mmHg</small></div></div>
    </div>`;
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

function renderWeek() {
  const el = $('#weekCard');
  const today = startOfDay(Date.now());
  const days = []; for (let i = 6; i >= 0; i--) days.push(today - i * DAY);
  const cells = days.map(d => {
    const ss = state.sessions.filter(s => s.ts >= d && s.ts < d + DAY);
    const slot = pred => { const m = ss.filter(pred); return m.length ? (m.some(isStandard) ? 'std' : 'non') : ''; };
    const am = slot(s => new Date(s.ts).getHours() < 12), pm = slot(s => new Date(s.ts).getHours() >= 12);
    const dt = new Date(d);
    const mark = v => v === 'std' ? '✓' : v === 'non' ? '•' : '';
    return `<div class="day ${d === today ? 'today' : ''}"><div class="dn">${dt.toLocaleDateString(undefined, { weekday: 'narrow' })}</div><div class="dd">${dt.getDate()}</div>
      <div class="dots"><span class="dot ${am}" title="Morning">${mark(am) || 'AM'}</span><span class="dot ${pm}" title="Afternoon or evening">${mark(pm) || 'PM'}</span></div></div>`;
  }).join('');
  el.innerHTML = `<div class="week-head"><h2 class="t">Last 7 days</h2><span class="sub" style="margin:0">Goal: a morning and an evening reading</span></div>
    <div class="week">${cells}</div>
    <div class="week-key"><span><i class="dot std" style="display:inline-grid"></i>Standard</span><span><i class="dot non" style="display:inline-grid"></i>Not standard</span><span><i class="dot" style="display:inline-grid"></i>Missing</span></div>`;
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
    for (let t = Math.ceil(xmin / step) * step; t <= xmax; t += step) out.push({ t, label: fmtTime(t) });
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
  for (let v = Math.ceil(lo / step) * step; v <= hi; v += step)
    g += `<line x1="${m.l}" x2="${W - m.r}" y1="${y(v)}" y2="${y(v)}" stroke="var(--grid)" stroke-width="1"/><text x="${m.l - 8}" y="${y(v) + 4}" text-anchor="end">${v}</text>`;
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
    tip.innerHTML = o.tip(best); tip.hidden = false;
    const tw = tip.offsetWidth, th = tip.offsetHeight;
    let left = e.clientX + 16; if (left + tw > innerWidth - 8) left = e.clientX - tw - 16; left = Math.max(8, left);
    let top = e.clientY - th - 12; if (top < 8) top = e.clientY + 18;
    tip.style.left = left + 'px'; tip.style.top = top + 'px';
  };
  const leave = () => { xh.setAttribute('display', 'none'); hl.innerHTML = ''; hideTip(); };
  hit.addEventListener('pointermove', show); hit.addEventListener('pointerdown', show);
  hit.addEventListener('pointerleave', leave); hit.addEventListener('pointercancel', leave);
}

function renderTrend() {
  const ss = rangeSessions();
  const base = computeBaseline();
  const now = Date.now();
  const xmin = state.range === 'all' ? (ss[0] ? ss[0].ts - DAY / 4 : now - DAY) : now - Number(state.range) * DAY;
  const xmax = state.range === 'all' ? (ss.length ? Math.max(now, ss[ss.length - 1].ts) : now) : now;

  $$('#rangeSeg button').forEach(b => b.setAttribute('aria-pressed', String(b.dataset.range === state.range)));
  $$('#viewSeg button').forEach(b => b.setAttribute('aria-pressed', String(b.dataset.view === state.tview)));
  $('#chartView').hidden = state.tview !== 'chart';
  $('#tableView').hidden = state.tview !== 'table';

  const avgS = ss.length ? Math.round(mean(ss.map(s => s.sys))) : null, avgD = ss.length ? Math.round(mean(ss.map(s => s.dia))) : null;
  $('#trendSub').textContent = ss.length ? `${ss.length} reading${ss.length === 1 ? '' : 's'} · average ${avgS}/${avgD} mmHg` : 'No readings in this range';

  const lg = [`<span><i class="sw" style="--c:var(--s1)"></i>Systolic</span>`, `<span><i class="sw" style="--c:var(--s2)"></i>Diastolic</span>`];
  if (base.ready) lg.push(`<span><i class="sw dash" style="--c:var(--ink-2)"></i>Your baseline</span>`);
  lg.push(`<span><i class="mk fill"></i>Standard</span><span><i class="mk"></i>Not standard</span>`);
  $('#trendLegend').innerHTML = lg.join('');

  if (state.tview === 'table') { renderTable(ss); return; }

  const animate = state.animChart && !RM(); state.animChart = false;
  const narrow = innerWidth < 520;
  lineChart($('#bpChart'), {
    pts: ss, xmin, xmax, h: narrow ? 260 : 320, animate,
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
  const label = state.range === 'all' ? 'all time' : `last ${state.range} days`;
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
    <label class="cell"><span>Systolic</span><input type="number" inputmode="numeric" min="60" max="260" placeholder="120" data-f="sys" aria-label="Systolic, reading ${i + 1}"></label>
    <label class="cell"><span>Diastolic</span><input type="number" inputmode="numeric" min="30" max="160" placeholder="80" data-f="dia" aria-label="Diastolic, reading ${i + 1}"></label>
    <label class="cell"><span>Pulse</span><input type="number" inputmode="numeric" min="30" max="220" placeholder="65" data-f="pulse" aria-label="Pulse, reading ${i + 1}"></label>
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
  state.editing = session ? session.id : null;
  $('#logTitle').textContent = session ? 'Edit reading' : 'New reading';
  $('#readingRows').innerHTML = '';
  $('#formError').hidden = true;
  const last = state.sessions[state.sessions.length - 1];
  form = { arm: session ? session.arm : (last ? last.arm : 'L'), pos: session ? session.pos : 'seated', tags: new Set(session ? session.tags : []) };
  $('#tagChips').innerHTML = TAGS.map(t => `<button type="button" data-t="${t.id}" aria-pressed="false">${t.label}</button>`).join('');
  $('#fWhen').value = toInput(session ? session.ts : Date.now());
  $('#fNote').value = session ? (session.note || '') : '';
  const rd = session ? (session.readings && session.readings.length ? session.readings : [{ sys: session.sys, dia: session.dia, pulse: session.pulse }]) : [null];
  rd.forEach(r => addRow(r));
  syncFormUI(); updatePreview();
  openSheet($('#logDialog'));
  setTimeout(() => { const f = $('[data-f=sys]'); if (f && !session) f.focus({ preventScroll: true }); }, 380);
}
function quickTime(kind) {
  const d = new Date();
  if (kind === 'am') d.setHours(8, 0, 0, 0);
  if (kind === 'pm') d.setHours(20, 0, 0, 0);
  if (d.getTime() > Date.now()) d.setDate(d.getDate() - 1);
  $('#fWhen').value = toInput(d.getTime());
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
  state.sessions = state.sessions.filter(x => x.id !== s.id).concat(s).sort((a, b) => a.ts - b.ts);
  save(); closeSheet($('#logDialog'));
  state.animChart = false; renderAll();
  toast(prev ? 'Reading updated' : `Saved ${s.sys}/${s.dia} · ${CATS[classify(s.sys, s.dia)].label}`);
  if (classify(s.sys, s.dia) === 'crisis') { go('today'); }
}

/* ============ data tools ============ */
let toastT;
function toast(msg) { const t = $('#toast'); t.textContent = msg; t.hidden = false; t.style.animation = 'none'; void t.offsetWidth; t.style.animation = ''; clearTimeout(toastT); toastT = setTimeout(() => { t.hidden = true; }, 3200); }
function download(name, text, type) {
  const url = URL.createObjectURL(new Blob([text], { type })), a = document.createElement('a');
  a.href = url; a.download = name; document.body.appendChild(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(url), 1000);
}
function exportJson() {
  const mine = state.sessions.filter(s => !s.sample);
  download(`baseline-backup-${dayKey(Date.now())}.json`, JSON.stringify({ app: 'baseline-bp', version: 1, exportedAt: new Date().toISOString(), sessions: mine }, null, 2), 'application/json');
  writeMeta({ lastExport: Date.now() }); renderBackup(); toast('Backup exported');
}
function exportCsv() {
  const q = v => `"${String(v ?? '').replace(/"/g, '""')}"`;
  const head = ['datetime', 'systolic', 'diastolic', 'pulse', 'readings_averaged', 'arm', 'position', 'category', 'standard_conditions', 'context', 'note'];
  const lines = state.sessions.filter(s => !s.sample).map(s => [toInput(s.ts).replace('T', ' '), s.sys, s.dia, s.pulse ?? '', (s.readings || []).length || 1, s.arm, s.pos, CATS[classify(s.sys, s.dia)].label, isStandard(s) ? 'yes' : 'no', s.tags.map(t => TAG[t]?.label || t).join('; '), s.note].map(q).join(','));
  download(`baseline-readings-${dayKey(Date.now())}.csv`, [head.join(','), ...lines].join('\n'), 'text/csv');
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
    } catch (e) { toast('That file does not look like a Baseline backup.'); }
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
  $('#quickTimes').addEventListener('click', e => { const q = e.target.dataset.q; if (!q) return; if (q === 'now') $('#fWhen').value = toInput(Date.now()); else quickTime(q); });
  $('#armSeg').addEventListener('click', e => { if (e.target.dataset.v) { form.arm = e.target.dataset.v; syncFormUI(); } });
  $('#posSeg').addEventListener('click', e => { if (e.target.dataset.v) { form.pos = e.target.dataset.v; syncFormUI(); } });
  $('#tagChips').addEventListener('click', e => { const b = e.target.closest('button'); if (!b) return; const t = b.dataset.t; form.tags.has(t) ? form.tags.delete(t) : form.tags.add(t); syncFormUI(); if (navigator.vibrate) navigator.vibrate(6); });

  $('#rangeSeg').addEventListener('click', e => { if (e.target.dataset.range) { state.range = e.target.dataset.range; state.tableLimit = 15; state.animChart = true; renderTrend(); renderCategory(); } });
  $('#viewSeg').addEventListener('click', e => { if (e.target.dataset.view) { state.tview = e.target.dataset.view; state.animChart = true; renderTrend(); } });
  $('#insSeg').addEventListener('click', e => { if (e.target.dataset.pane) { state.pane = e.target.dataset.pane; renderPane(true); } });
  $('#tableView').addEventListener('click', e => {
    const t = e.target;
    if (t.dataset.edit) { const s = state.sessions.find(x => x.id === t.dataset.edit); if (s) openLog(s); }
    if (t.dataset.del && confirm('Delete this reading?')) { state.sessions = state.sessions.filter(x => x.id !== t.dataset.del); save(); state.animChart = false; renderAll(); toast('Reading deleted'); }
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
  $('#clearSample').addEventListener('click', () => { state.sessions = state.sessions.filter(s => !s.sample); save(); renderAll(); toast('Sample data cleared'); });
  $('#wipe').addEventListener('click', () => {
    if (confirm('Delete ALL readings stored in this browser? Export a backup first if you want to keep them.')) { state.sessions = []; save(); AI.clearReport(); renderAll(); toast('All data deleted'); }
  });
  $('#backupNow').addEventListener('click', exportJson);
  $('#backupLater').addEventListener('click', () => { writeMeta({ dismissUntil: Date.now() + 14 * DAY }); renderBackup(); });
  $('#aiRow').addEventListener('click', () => AI.openSetup());
  $('#installBtn').addEventListener('click', async () => {
    if (!deferredInstall) return;
    deferredInstall.prompt(); try { await deferredInstall.userChoice; } catch (e) {}
    deferredInstall = null; updateInstallUI();
  });

  window.addEventListener('beforeinstallprompt', e => { e.preventDefault(); deferredInstall = e; updateInstallUI(); });
  window.addEventListener('appinstalled', () => { deferredInstall = null; updateInstallUI(); toast('Baseline installed'); });
  window.addEventListener('hashchange', () => {
    if (location.hash === '#log') { history.replaceState(null, '', '#' + state.view); openLog(); return; }
    const v = viewFromHash(); if (v && v !== state.view) go(v);
  });
  window.addEventListener('scroll', () => { document.body.classList.toggle('scrolled', scrollY > 40); hideTip(); }, { passive: true });
  matchMedia('(display-mode: standalone)').addEventListener?.('change', updateInstallUI);
  window.addEventListener('online', () => renderPane());
  window.addEventListener('offline', () => renderPane());

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
}
if ('serviceWorker' in navigator && location.protocol.startsWith('http')) {
  window.addEventListener('load', () => navigator.serviceWorker.register('sw.js').catch(() => {}));
}
