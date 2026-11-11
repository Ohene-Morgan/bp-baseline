'use strict';
/* Optional Claude AI features: written reports and chat about the user's own readings.
   - Bring-your-own-key. Requests go straight from this browser to api.anthropic.com.
   - Nothing is sent until the user taps Generate or Send, and only after they consented.
   - The key never leaves the device except in the request header to Anthropic.
   Loaded before app.js; uses app.js helpers ($, esc, state, computeBaseline, ...) at call time only. */

const AI = (() => {
  const CFG_KEY = 'bp-baseline:ai:v1';
  const KEY_KEY = 'bp-baseline:ai-key';
  const REPORT_KEY = 'bp-baseline:report';
  const API = 'https://api.anthropic.com/v1';
  const API_VERSION = '2026-10-21';
  const MODELS = [
    { id: 'claude-opus-5-5',   label: 'Claude Opus 5.5',   note: 'Most thorough. Recommended for reports.' },
    { id: 'claude-sonnet-5-5', label: 'Claude Sonnet 5.5', note: 'Balanced speed and depth.' },
    { id: 'claude-haiku-5-5',  label: 'Claude Haiku 5.5',  note: 'Fastest and lowest cost.' },
  ];

  let cfg = { model: 'claude-opus-5-5', remember: true, notes: false, consent: false };
  let sessionKey = '';                       // used when "remember" is off
  let rep = { status: 'idle', text: '', meta: null, error: '', days: 30 };
  const chat = { msgs: [], busy: false, abort: null };

  /* ---------- storage ---------- */
  const lget = k => { try { return localStorage.getItem(k); } catch (e) { return null; } };
  const lset = (k, v) => { try { localStorage.setItem(k, v); } catch (e) { /* ignore */ } };
  const ldel = k => { try { localStorage.removeItem(k); } catch (e) { /* ignore */ } };
  function loadCfg() {
    try { cfg = { ...cfg, ...(JSON.parse(lget(CFG_KEY) || '{}') || {}) }; } catch (e) { /* keep defaults */ }
    if (!MODELS.some(m => m.id === cfg.model)) cfg.model = MODELS[0].id;
    try { const r = JSON.parse(lget(REPORT_KEY) || 'null'); if (r && r.text) rep = { status: 'done', text: r.text, meta: r.meta, error: '', days: (r.meta && r.meta.days) || 30 }; } catch (e) { /* ignore */ }
  }
  const saveCfg = () => lset(CFG_KEY, JSON.stringify(cfg));
  const getKey = () => lget(KEY_KEY) || sessionKey || '';
  function setKey(k) {
    ldel(KEY_KEY); sessionKey = '';
    if (cfg.remember) lset(KEY_KEY, k); else sessionKey = k;
  }
  function forget() { ldel(KEY_KEY); sessionKey = ''; cfg.consent = false; saveCfg(); chat.msgs = []; }
  const connected = () => !!getKey() && cfg.consent;
  const modelLabel = () => (MODELS.find(m => m.id === cfg.model) || MODELS[0]).label;
  const statusText = () => connected() ? `${modelLabel()} · key ${cfg.remember ? 'saved on this device' : 'kept until you close the tab'}` : 'Add your own API key for AI reports and chat';
  function clearReport() { ldel(REPORT_KEY); rep = { status: 'idle', text: '', meta: null, error: '', days: rep.days }; }

  /* ---------- API plumbing ---------- */
  class AIError extends Error { constructor(msg, code) { super(msg); this.code = code; } }
  const headers = (key, extra) => ({ 'content-type': 'application/json', 'x-api-key': key, 'anthropic-version': API_VERSION, 'anthropic-dangerous-direct-browser-access': 'true', ...extra });

  async function httpError(res) {
    let apiMsg = '';
    try { const j = await res.json(); apiMsg = (j && j.error && j.error.message) || ''; } catch (e) { /* not JSON */ }
    const ra = Number(res.headers.get('retry-after'));
    if (res.status === 401) return new AIError('Anthropic rejected that API key. Open Settings, then Claude AI, to check or replace it.', 401);
    if (res.status === 403) return new AIError('That key is not allowed to use this model or feature.' + (apiMsg ? ` (${apiMsg})` : ''), 403);
    if (res.status === 429) return new AIError(`Rate limit reached${ra ? `. Try again in about ${ra} seconds` : '. Try again in a minute'}.`, 429);
    if (res.status === 402 || /credit|billing/i.test(apiMsg)) return new AIError('Your Anthropic account has no credit available. Check billing in the Anthropic Console.', 402);
    if (res.status >= 500) return new AIError('Claude is busy or unavailable right now. Try again shortly.', res.status);
    return new AIError(apiMsg || `Request failed (${res.status}).`, res.status);
  }
  const netError = e => (e && e.name === 'AbortError') ? e : new AIError(navigator.onLine === false ? 'You are offline. AI features need an internet connection.' : 'Could not reach Anthropic. Check your connection and try again.', 'net');

  async function validateKey(key) {
    let res;
    try { res = await fetch(`${API}/models?limit=1`, { headers: headers(key) }); } catch (e) { throw netError(e); }
    if (!res.ok) throw await httpError(res);
  }

  /* Incremental Server-Sent Events parser. Calls onEvent(parsedJson) for each complete event. */
  function makeSSE(onEvent) {
    let buf = '';
    return chunk => {
      buf = (buf + chunk).replace(/\r\n/g, '\n');
      let i;
      while ((i = buf.indexOf('\n\n')) >= 0) {
        const raw = buf.slice(0, i); buf = buf.slice(i + 2);
        let data = '';
        for (const line of raw.split('\n')) if (line.startsWith('data:')) data += line.slice(5).trimStart();
        if (data) { try { onEvent(JSON.parse(data)); } catch (e) { /* ignore malformed event */ } }
      }
    };
  }

  /* Streams one Messages API call. Returns { stopReason, model }. Calls onText(delta) for text only. */
  async function stream({ system, messages, effort, signal, onText, maxTokens = 16000 }) {
    const key = getKey();
    if (!key) throw new AIError('Add your API key in Settings first.', 'nokey');
    if (navigator.onLine === false) throw new AIError('You are offline. AI features need an internet connection.', 'net');
    const wantFallback = cfg.model !== 'claude-haiku-5-5';   // server-side refusal fallback; not offered on Haiku
    const send = fb => {
      const body = { model: cfg.model, max_tokens: maxTokens, stream: true, system, messages, output_config: { effort } };
      const h = headers(key);
      if (fb) { h['anthropic-beta'] = 'server-side-fallback-2026-07-01'; body.fallbacks = 'default'; }
      return fetch(`${API}/messages`, { method: 'POST', headers: h, body: JSON.stringify(body), signal });
    };
    let res;
    try {
      res = await send(wantFallback);
      if (res.status === 400 && wantFallback) { const t = await res.clone().text(); if (/fallback/i.test(t)) res = await send(false); }
    } catch (e) { throw netError(e); }
    if (!res.ok) throw await httpError(res);

    let stopReason = null, model = cfg.model, apiErr = null;
    const feed = makeSSE(ev => {
      if (ev.type === 'message_start' && ev.message && ev.message.model) model = ev.message.model;
      else if (ev.type === 'content_block_delta' && ev.delta && ev.delta.type === 'text_delta') onText(ev.delta.text);
      else if (ev.type === 'message_delta' && ev.delta && ev.delta.stop_reason) stopReason = ev.delta.stop_reason;
      else if (ev.type === 'error') apiErr = ev.error && ev.error.message || 'The stream ended with an error.';
    });
    const reader = res.body.getReader(), dec = new TextDecoder();
    try {
      for (;;) { const { done, value } = await reader.read(); if (done) break; feed(dec.decode(value, { stream: true })); }
    } catch (e) { throw netError(e); }
    if (apiErr) throw new AIError(apiErr, 'stream');
    return { stopReason, model };
  }

  /* ---------- what gets sent ---------- */
  function buildSummary(days, includeNotes) {
    const now = Date.now(), r1 = n => Math.round(n * 10) / 10;
    const inRange = days === 'all' ? state.sessions : state.sessions.filter(s => s.ts >= now - days * DAY);
    const base = computeBaseline();
    const cats = {}; inRange.forEach(s => { const c = CATS[classify(s.sys, s.dia)].label; cats[c] = (cats[c] || 0) + 1; });
    const std = state.sessions.filter(isStandard);
    const am = std.filter(s => new Date(s.ts).getHours() < 12), pm = std.filter(s => new Date(s.ts).getHours() >= 12);
    const a = state.sessions.filter(s => s.ts >= now - 7 * DAY), b = state.sessions.filter(s => s.ts < now - 7 * DAY && s.ts >= now - 14 * DAY);
    const L = state.sessions.filter(s => s.arm === 'L'), R = state.sessions.filter(s => s.arm === 'R');
    const out = {
      today: toInput(now).slice(0, 10),
      data_is_sample: state.sessions.some(s => s.sample),
      period: days === 'all' ? 'all time' : `last ${days} days`,
      readings_in_period: inRange.length,
      readings_total: state.sessions.length,
      standard_readings_total: std.length,
      crisis_readings_in_period: inRange.filter(s => classify(s.sys, s.dia) === 'crisis').length,
      baseline: base.ready ? {
        systolic: r1(base.sys), diastolic: r1(base.dia), systolic_sd: r1(base.sdS), diastolic_sd: r1(base.sdD),
        pulse: base.pulse ? r1(base.pulse) : null, pulse_pressure: r1(base.pp), mean_arterial_pressure: r1(base.map),
        category: CATS[base.cat].label, standard_readings_used: base.n, days_covered: base.days,
        confidence_percent: Math.round(base.progress * 100), first_day_excluded: base.dropped,
      } : 'not enough standard readings yet (needs at least 3)',
      period_average: inRange.length ? { systolic: r1(mean(inRange.map(s => s.sys))), diastolic: r1(mean(inRange.map(s => s.dia))) } : null,
      category_counts_in_period: cats,
      context_effects_vs_baseline: contextDeltas(base).slice(0, 8).map(r => ({ context: r.tag.label, readings: r.n, avg_systolic_change: r1(r.ds), avg_diastolic_change: r1(r.dd) })),
      morning_minus_later_systolic_standard_only: am.length >= 3 && pm.length >= 3 ? r1(mean(am.map(s => s.sys)) - mean(pm.map(s => s.sys))) : null,
      left_minus_right_arm_systolic: L.length >= 3 && R.length >= 3 ? r1(mean(L.map(s => s.sys)) - mean(R.map(s => s.sys))) : null,
      last_7_days_minus_previous_7_days_systolic: a.length >= 3 && b.length >= 3 ? r1(mean(a.map(s => s.sys)) - mean(b.map(s => s.sys))) : null,
      recent_readings: inRange.slice(-60).map(s => {
        const o = { when: toInput(s.ts).replace('T', ' '), systolic: s.sys, diastolic: s.dia, pulse: s.pulse || null, arm: s.arm === 'L' ? 'left' : 'right', position: s.pos,
          contexts: s.tags.map(t => TAG[t] ? TAG[t].label : t), standard_conditions: isStandard(s), readings_averaged: (s.readings || []).length || 1 };
        if (includeNotes && s.note) o.note = s.note;
        return o;
      }),
    };
    return out;
  }

  const SYS_BASE = `You are the assistant inside Kayline, a home blood pressure log. You help one person understand their own readings. You are not a clinician.

Rules:
- Use only the numbers in the DATA block. Never invent readings, dates or statistics. If the data is thin (few readings or few days), say so plainly.
- Categories (AHA/ACC): Normal is under 120 and under 80. Elevated is 120-129 and under 80. Stage 1 is 130-139 or 80-89. Stage 2 is 140 or higher, or 90 or higher. Hypertensive crisis is above 180 and/or above 120. "Low" (under 90 or under 60) is an informal flag only.
- "Baseline" is the average of standard-condition readings: seated, with no caffeine, exercise, meal, stress, alcohol, nicotine, full bladder or illness. Other readings are compared against it.
- Do not diagnose. Do not suggest starting, stopping or changing any medication, and give no dosing. When something needs a judgment call, suggest talking to a doctor or pharmacist. A home log alone cannot confirm or rule out hypertension.
- If crisis_readings_in_period is above zero, or the user describes chest pain, shortness of breath, weakness, vision changes or trouble speaking, begin with one calm line: rest and measure again after 5 minutes, and seek urgent care or call emergency services if it stays above 180/120 or symptoms are present.
- If data_is_sample is true, say once that this is demo data and not the person's own.
- Plain language. No emojis. No hype and no alarm. Pressure is in mmHg and pulse in bpm.`;
  const SYS_REPORT = `${SYS_BASE}

Task: write a report on the period in the data. Use these markdown headings exactly, in this order: "## Summary" (2-3 sentences), "## Your baseline", "## Patterns worth noticing", "## What moves your numbers", "## Measurement quality", "## Questions for your clinician" (2-4 bullets), "## Next two weeks" (3 bullets, only about measurement habits). Stay under 400 words. If the data cannot support a section, say so in one line instead of padding it.`;
  const SYS_CHAT = `${SYS_BASE}

Task: chat. Answer concisely, usually under 150 words, grounded in the DATA block. If the question cannot be answered from the data, say what is missing. Offer a next step only when it helps.`;
  const dataBlock = days => ({ type: 'text', text: `DATA (JSON, current as of this message):\n${JSON.stringify(buildSummary(days, cfg.notes))}` });

  /* ---------- markdown (escape first, then add only our own tags) ---------- */
  function md(text) {
    const inline = s => s.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>').replace(/`([^`]+)`/g, '<code>$1</code>');
    let html = '', list = null, para = [];
    const flushPara = () => { if (para.length) { html += `<p>${inline(para.join(' '))}</p>`; para = []; } };
    const closeList = () => { if (list) { html += `</${list}>`; list = null; } };
    for (const line of esc(text).split('\n')) {
      let m;
      if ((m = line.match(/^#{1,6}\s+(.*)$/))) { flushPara(); closeList(); html += `<h3>${inline(m[1])}</h3>`; }
      else if ((m = line.match(/^\s*[-*•]\s+(.*)$/))) { flushPara(); if (list !== 'ul') { closeList(); html += '<ul>'; list = 'ul'; } html += `<li>${inline(m[1])}</li>`; }
      else if ((m = line.match(/^\s*\d+[.)]\s+(.*)$/))) { flushPara(); if (list !== 'ol') { closeList(); html += '<ol>'; list = 'ol'; } html += `<li>${inline(m[1])}</li>`; }
      else if (!line.trim()) { flushPara(); closeList(); }
      else { closeList(); para.push(line.trim()); }
    }
    flushPara(); closeList();
    return html;
  }

  /* ---------- connect card (shared by report + chat) ---------- */
  const connectCard = (title, text) => `<article class="card connect-card"><div class="card-label">${icon('sparkle', 16)}Optional</div><h2>${title}</h2><p>${text}</p><button class="btn primary" data-act="ai" type="button">Connect Claude</button></article>`;
  const noData = () => !state.sessions.length;

  /* ---------- report pane ---------- */
  function renderReport(el) {
    if (!connected()) {
      el.innerHTML = connectCard('A written report from Claude', 'Turn your readings into a plain-language summary with patterns and questions to bring to your doctor. Uses your own Anthropic API key. Nothing is sent until you tap Generate.');
      return;
    }
    const offline = navigator.onLine === false, busy = rep.status === 'loading';
    const meta = rep.meta ? `Generated ${new Date(rep.meta.ts).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })} · ${esc(rep.meta.model)} · ${rep.meta.days === 'all' ? 'all time' : `last ${rep.meta.days} days`}${rep.meta.sample ? ' · sample data' : ''}` : 'Not generated yet';
    el.innerHTML = `
      <article class="card">
        <div class="report-controls">
          <div class="seg" id="repDays" role="group" aria-label="Report period">${[7, 30, 90].map(d => `<button type="button" data-d="${d}" aria-pressed="${rep.days === d}">${d} days</button>`).join('')}</div>
          <button class="btn primary" id="repGo" type="button" ${busy || offline || noData() ? 'disabled' : ''}>${busy ? 'Writing…' : rep.text ? 'Generate again' : 'Generate report'}</button>
        </div>
        <p class="report-meta" style="margin-top:10px">${offline ? 'You are offline. Reports need a connection.' : noData() ? 'Log some readings first.' : meta}</p>
      </article>
      <article class="card" id="repCard" ${rep.text || busy || rep.error ? '' : 'hidden'}>
        <div class="md ${busy ? 'caret' : ''}" id="repBody">${md(rep.text)}</div>
        ${rep.error ? `<div class="err-box" style="margin-top:12px">${esc(rep.error)}</div>` : ''}
        ${rep.text && !busy ? `<div class="report-actions"><button class="btn small" id="repCopy" type="button">Copy</button>${navigator.share ? '<button class="btn small" id="repShare" type="button">Share</button>' : ''}<button class="btn small ghost" id="repDel" type="button">Delete report</button></div>` : ''}
      </article>
      <p class="fine" style="padding:0 6px">AI can make mistakes. This is not medical advice. Your readings summary is sent to Anthropic when you generate.</p>`;
    el.onclick = e => {
      const t = e.target.closest('button'); if (!t) return;
      if (t.dataset.d) { rep.days = Number(t.dataset.d); renderReport(el); }
      if (t.id === 'repGo') generateReport(el);
      if (t.id === 'repCopy') copyText(rep.text);
      if (t.id === 'repShare') navigator.share({ title: 'Kayline report', text: rep.text }).catch(() => {});
      if (t.id === 'repDel') { clearReport(); renderReport(el); }
    };
  }
  async function generateReport(el) {
    rep = { ...rep, status: 'loading', text: '', error: '' };
    renderReport(el);
    const body = () => $('#repBody', el);
    let acc = '', raf = 0;
    const paint = () => { raf = 0; const b = body(); if (b) b.innerHTML = md(acc); };
    const days = rep.days;
    try {
      const r = await stream({
        system: [{ type: 'text', text: SYS_REPORT }, dataBlock(days)],
        messages: [{ role: 'user', content: 'Write my blood pressure report.' }],
        effort: 'medium', onText: d => { acc += d; if (!raf) raf = requestAnimationFrame(paint); },
      });
      cancelAnimationFrame(raf);
      if (r.stopReason === 'refusal') throw new AIError('Claude declined to write this report. Try a different model in Settings.', 'refusal');
      if (!acc.trim()) throw new AIError('Claude returned an empty report. Try again.', 'empty');
      if (r.stopReason === 'max_tokens') acc += '\n\n(The report was cut short.)';
      const meta = { ts: Date.now(), model: (MODELS.find(m => r.model === m.id) || { label: r.model }).label, days, sample: state.sessions.some(s => s.sample) };
      rep = { status: 'done', text: acc, meta, error: '', days };
      lset(REPORT_KEY, JSON.stringify({ text: acc, meta }));
    } catch (e) {
      cancelAnimationFrame(raf);
      rep = { ...rep, status: 'error', text: acc, error: e.message || 'Something went wrong.' };
    }
    if (state.view === 'insights' && state.pane === 'report') renderReport(el);
  }
  async function copyText(t) {
    try { await navigator.clipboard.writeText(t); toast('Copied'); } catch (e) { toast('Could not copy. Select the text instead.'); }
  }

  /* ---------- chat pane ---------- */
  const SUGGESTIONS = ['Is my baseline in a healthy range?', 'Does caffeine affect my numbers?', 'What should I tell my doctor?', 'Are my mornings different from evenings?'];
  function renderChat(el) {
    if (!connected()) {
      el.innerHTML = connectCard('Ask Claude about your numbers', 'Chat about your baseline, patterns and what to ask your doctor. Claude sees a summary of your logged readings and nothing else. Uses your own Anthropic API key.');
      return;
    }
    const offline = navigator.onLine === false;
    el.innerHTML = `<div class="chat">
      <div class="msgs" id="msgs" aria-live="polite">
        <div class="msg bot"><div class="md"><p>${noData() ? 'Log a few readings and I can help you make sense of them.' : 'Ask me anything about your readings. I can see your logged numbers, context tags and baseline.'}</p></div></div>
        ${chat.msgs.map(m => m.role === 'user' ? `<div class="msg user">${esc(m.content)}</div>` : `<div class="msg bot"><div class="md">${md(m.content)}</div></div>`).join('')}
      </div>
      ${chat.msgs.length || noData() ? '' : `<div class="suggest" id="sugg">${SUGGESTIONS.map(s => `<button type="button">${esc(s)}</button>`).join('')}</div>`}
      <form class="composer" id="chatForm">
        <textarea id="chatIn" rows="1" placeholder="${offline ? 'Offline' : 'Ask about your readings'}" aria-label="Message" ${offline ? 'disabled' : ''}></textarea>
        <button type="submit" id="chatSend" aria-label="${chat.busy ? 'Stop' : 'Send'}" ${offline ? 'disabled' : ''}>${chat.busy ? '<svg class="i" width="18" height="18" viewBox="0 0 24 24"><rect x="7" y="7" width="10" height="10" rx="2" fill="currentColor"/></svg>' : icon('send')}</button>
      </form>
      <div class="chat-foot"><span>AI can be wrong. Not medical advice.</span>${chat.msgs.length ? '<button type="button" id="chatClear">Clear chat</button>' : ''}</div>
    </div>`;
    const input = $('#chatIn', el), form = $('#chatForm', el), box = $('#msgs', el);
    const grow = () => { input.style.height = 'auto'; input.style.height = Math.min(120, input.scrollHeight) + 'px'; };
    input.addEventListener('input', grow);
    input.addEventListener('keydown', e => { if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); form.requestSubmit(); } });
    form.addEventListener('submit', e => {
      e.preventDefault();
      if (chat.busy) { chat.abort && chat.abort.abort(); return; }
      const text = input.value.trim(); if (!text) return;
      input.value = ''; grow(); sendChat(el, text);
    });
    const sg = $('#sugg', el); if (sg) sg.addEventListener('click', e => { const b = e.target.closest('button'); if (b) sendChat(el, b.textContent); });
    const clr = $('#chatClear', el); if (clr) clr.addEventListener('click', () => { chat.msgs = []; renderChat(el); });
    if (chat.msgs.length) requestAnimationFrame(() => box.lastElementChild && box.lastElementChild.scrollIntoView({ block: 'end' }));
  }
  async function sendChat(el, text) {
    if (chat.busy) return;
    chat.msgs.push({ role: 'user', content: text });
    chat.busy = true; chat.abort = new AbortController();
    renderChat(el);
    const box = $('#msgs', el);
    box.insertAdjacentHTML('beforeend', `<div class="msg bot" id="pending"><div class="md"><span class="typing" aria-label="Claude is typing"><i></i><i></i><i></i></span></div></div>`);
    const pend = $('#pending', el), mdEl = $('.md', pend);
    pend.scrollIntoView({ block: 'end', behavior: RM() ? 'auto' : 'smooth' });
    let acc = '', raf = 0;
    const paint = () => { raf = 0; mdEl.innerHTML = md(acc) + '<span class="caret"></span>'; };
    let history = chat.msgs.slice(-20); while (history.length && history[0].role !== 'user') history.shift();
    let failed = null;
    try {
      const r = await stream({
        system: [{ type: 'text', text: SYS_CHAT }, dataBlock('all')],
        messages: history, effort: 'low', signal: chat.abort.signal,
        onText: d => { acc += d; if (!raf) raf = requestAnimationFrame(paint); },
      });
      if (r.stopReason === 'refusal') throw new AIError('Claude declined to answer that. Try rephrasing or switch model in Settings.', 'refusal');
      if (r.stopReason === 'max_tokens') acc += '\n\n(Cut short.)';
    } catch (e) { failed = e; }
    cancelAnimationFrame(raf);
    chat.busy = false; chat.abort = null;
    if (failed && failed.name === 'AbortError') {
      if (acc.trim()) chat.msgs.push({ role: 'assistant', content: acc + '\n\n(Stopped.)' }); else chat.msgs.pop();
    } else if (failed) {
      chat.msgs.pop();                               // drop the unanswered question so history stays valid
      if (state.view === 'insights' && state.pane === 'chat') { renderChat(el); const i = $('#chatIn', el); if (i) i.value = text; $('#msgs', el).insertAdjacentHTML('beforeend', `<div class="err-box" role="alert">${esc(failed.message)}</div>`); }
      return;
    } else {
      chat.msgs.push({ role: 'assistant', content: acc });
    }
    if (state.view === 'insights' && state.pane === 'chat') renderChat(el);
  }

  /* ---------- setup sheet ---------- */
  function renderModels() {
    $('#aiModels').innerHTML = MODELS.map(m => `<label class="radio"><input type="radio" name="aiModel" value="${m.id}" ${cfg.model === m.id ? 'checked' : ''}><span><span class="rt">${m.label}</span><span class="rs">${m.note}</span></span></label>`).join('');
  }
  function openSetup() {
    const on = connected();
    renderModels();
    $('#aiKey').value = '';
    $('#aiKey').placeholder = on ? 'Key saved. Paste a new one to replace it.' : 'sk-ant-…';
    $('#aiRemember').checked = cfg.remember; $('#aiNotes').checked = cfg.notes; $('#aiConsent').checked = cfg.consent;
    $('#aiSave').textContent = on ? 'Save changes' : 'Connect';
    $('#aiForget').hidden = !on;
    $('#aiError').hidden = true;
    openSheet($('#aiDialog'));
  }
  async function submitSetup(e) {
    e.preventDefault();
    const err = m => { const x = $('#aiError'); x.textContent = m; x.hidden = false; };
    $('#aiError').hidden = true;
    const typed = $('#aiKey').value.trim();
    if (!typed && !getKey()) return err('Paste your Anthropic API key to connect.');
    if (!$('#aiConsent').checked) return err('Turn on “I understand the above” to continue.');
    if (typed && !/^sk-ant-[\w-]{10,}$/.test(typed)) return err('That does not look like an Anthropic API key. Keys start with sk-ant-.');
    const btn = $('#aiSave'), label = btn.textContent;
    cfg.model = ($('input[name=aiModel]:checked') || {}).value || cfg.model;
    cfg.remember = $('#aiRemember').checked; cfg.notes = $('#aiNotes').checked; cfg.consent = true;
    try {
      if (typed) {
        btn.disabled = true; btn.textContent = 'Checking key…';
        await validateKey(typed);
        setKey(typed);
      } else if (getKey()) setKey(getKey());           // re-store the existing key under the new "remember" choice
    } catch (ex) {
      btn.disabled = false; btn.textContent = label; cfg.consent = connected();
      return err(ex.message);
    }
    btn.disabled = false; btn.textContent = label;
    saveCfg(); closeSheet($('#aiDialog')); toast(typed ? 'Claude connected' : 'Saved');
    renderSettings(); if (state.view === 'insights') renderPane();
  }

  function init() {
    loadCfg();
    wireSheet($('#aiDialog'), [$('#aiClose')]);
    $('#aiForm').addEventListener('submit', submitSetup);
    $('#aiForget').addEventListener('click', () => {
      forget(); closeSheet($('#aiDialog')); toast('Claude disconnected. Key removed from this device.');
      renderSettings(); if (state.view === 'insights') renderPane();
    });
  }

  return { init, connected, statusText, openSetup, renderReport, renderChat, clearReport, _test: { makeSSE, md, buildSummary } };
})();
