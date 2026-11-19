/* WX Pro — accuracy leaderboard and skill-weighted "best guess".
   Grades each source against what the nearest NWS station actually recorded.
   Loaded before app.js; only uses app.js globals inside functions that run later. */
'use strict';

const LEADS = [1, 2, 3, 5];
const PR_VARS = { temp: 'temperature_2m', wind: 'wind_speed_10m', precip: 'precipitation' };
const SKILL_TTL = 6 * 3600e3;
const WET_IN = 0.02;            // a "wet day" for rain-call scoring
const DAY = 86400;

const skillRuns = {};           // placeId -> in-flight promise
const skillStatus = {};         // placeId -> short progress / error text

/* ---------- Storage ---------- */
function skillGet(placeId) {
  if (!state.skill) state.skill = {};
  if (!(placeId in state.skill)) state.skill[placeId] = store.get('skill.' + placeId, null);
  return state.skill[placeId];
}
function skillSet(placeId, s) { if (!state.skill) state.skill = {}; state.skill[placeId] = s; store.set('skill.' + placeId, s); }

/* ---------- Record NWS forecasts as they arrive, so they can be graded later ---------- */
function recordNwsSnapshot(place, b) {
  const src = b.sources.nws; if (!src || !src.ok) return;
  const key = 'nwsh.' + place.id; const rec = store.get(key, {});
  const fetchT = Math.floor(Date.now() / 1000); const cutoff = fetchT - 32 * DAY;
  const r1 = v => v == null ? null : Math.round(v * 10) / 10;
  for (const [t, temp] of src.series.temp) {
    const ahead = (t - fetchT) / DAY;
    for (const L of LEADS) {
      if (Math.abs(ahead - L) > 0.5) continue;
      const slot = rec[t] || (rec[t] = {});
      if (!slot[L]) slot[L] = [r1(temp), r1(src.series.wind.get(t)), src.series.precip.has(t) ? Math.round(src.series.precip.get(t) * 1000) / 1000 : null];
    }
  }
  for (const t of Object.keys(rec)) if (+t < cutoff) delete rec[t];
  store.set(key, rec);
}
function nwsHistorySeries(placeId) {
  const rec = store.get('nwsh.' + placeId, {}); const out = { temp: {}, wind: {}, precip: {} };
  for (const L of LEADS) { out.temp[L] = new Map(); out.wind[L] = new Map(); out.precip[L] = new Map(); }
  for (const [t, slot] of Object.entries(rec)) for (const [L, v] of Object.entries(slot)) {
    if (!out.temp[L]) continue;
    if (v[0] != null) out.temp[L].set(+t, v[0]); if (v[1] != null) out.wind[L].set(+t, v[1]); if (v[2] != null) out.precip[L].set(+t, v[2]);
  }
  return out;
}

/* ---------- Station observations (accumulated on the device) ---------- */
async function updateObs(stationId) {
  const key = 'obs.' + stationId; const rec = store.get(key, { h: {}, days: {} });
  const nowMs = Date.now(); const today0 = Math.floor(nowMs / 864e5) * 864e5;
  const jobs = [];
  for (let k = 0; k < 8; k++) {
    const s = today0 - k * 864e5, e = s + 864e5; const dk = new Date(s).toISOString().slice(0, 10);
    const complete = e < nowMs - 3 * 3600e3;
    if (complete && rec.days[dk]) continue;
    jobs.push(getJSON(`https://api.weather.gov/stations/${stationId}/observations?start=${new Date(s).toISOString()}&end=${new Date(Math.min(e, nowMs)).toISOString()}&limit=500`, { headers: NWS_HDR, timeout: 25000 })
      .then(j => ({ dk, complete, feats: j.features || [] })).catch(() => null));
  }
  const res = await Promise.all(jobs);
  for (const r of res) {
    if (!r) continue;
    for (const f of r.feats) {
      const p = f.properties; const ts = Date.parse(p.timestamp) / 1000; if (!Number.isFinite(ts)) continue;
      const hr = Math.round(ts / 3600) * 3600; const dist = Math.abs(ts - hr); if (dist > 20 * 60) continue;
      const e = rec.h[hr] || (rec.h[hr] = { d: 9999 });
      const temp = conv(p.temperature?.unitCode, p.temperature?.value);
      if (temp != null && dist < e.d) { e.t = Math.round(temp * 10) / 10; e.w = p.windSpeed?.value != null ? Math.round(conv(p.windSpeed.unitCode, p.windSpeed.value) * 10) / 10 : e.w; e.d = dist; }
      if (p.rawMessage) e.m = 1;                                  // a METAR: counts toward rain coverage
      const pr = p.precipitationLastHour;
      if (pr && pr.value != null) e.p = Math.max(e.p || 0, Math.round(conv(pr.unitCode, pr.value) * 1000) / 1000);
    }
    if (r.complete) rec.days[r.dk] = 1;
  }
  const cutoff = nowMs / 1000 - 32 * DAY;
  for (const t of Object.keys(rec.h)) if (+t < cutoff) delete rec.h[t];
  for (const d of Object.keys(rec.days)) if (Date.parse(d) / 1000 < cutoff) delete rec.days[d];
  store.set(key, rec);
  return rec.h;
}

/* ---------- Past model forecasts (Open-Meteo Previous Runs API) ---------- */
async function fetchPrevRuns(src, hint, place) {
  const ids = hint ? [hint, ...src.ids.filter(x => x !== hint)] : src.ids;
  const hourly = []; for (const v of Object.values(PR_VARS)) for (const L of LEADS) hourly.push(`${v}_previous_day${L}`);
  let lastErr = null;
  for (const id of ids) {
    for (const past of [31, 8]) {
      const u = new URL('https://previous-runs-api.open-meteo.com/v1/forecast');
      u.search = new URLSearchParams({
        latitude: place.lat.toFixed(4), longitude: place.lon.toFixed(4), hourly: hourly.join(','), models: id,
        temperature_unit: 'fahrenheit', wind_speed_unit: 'mph', precipitation_unit: 'inch',
        timeformat: 'unixtime', timezone: 'GMT', past_days: String(past), forecast_days: '1',
      }).toString();
      try {
        const j = await getJSON(u, { timeout: 30000 }); const h = j.hourly || {};
        const out = { temp: {}, wind: {}, precip: {} }; let any = false;
        for (const [k, v] of Object.entries(PR_VARS)) for (const L of LEADS) {
          const name = `${v}_previous_day${L}`; const arr = h[name] || h[name + '_' + id] || []; const m = new Map();
          (h.time || []).forEach((t, i) => { const x = arr[i]; if (x != null) { m.set(t, x); if (k === 'temp') any = true; } });
          out[k][L] = m;
        }
        if (!any) { lastErr = new Error('no archive for ' + id); break; }
        return { ok: true, modelId: id, series: out };
      } catch (e) { lastErr = e; if (e.status !== 400) break; }
    }
  }
  return { ok: false, error: lastErr ? lastErr.message : 'unavailable' };
}

/* ---------- Scoring ---------- */
function scoreWindow(seriesBySrc, obsH, windowDays, off) {
  const nowH = Math.floor(Date.now() / 3600e3) * 3600; const t0 = nowH - windowDays * DAY;
  const obsTimes = Object.keys(obsH).map(Number).filter(t => t >= t0 && t < nowH).sort((a, c) => a - c);
  // complete local days for rain calls
  const byDay = {};
  for (const t of obsTimes) { const dk = dateKey(t, off); (byDay[dk] || (byDay[dk] = [])).push(t); }
  const todayKey = dateKey(nowH, off);
  const rainDays = Object.entries(byDay).filter(([dk, ts]) => dk !== todayKey && ts.filter(t => obsH[t].m).length >= 18)
    .map(([dk, ts]) => ({ dk, wet: ts.reduce((s, t) => s + (obsH[t].p || 0), 0) >= WET_IN, start: Date.parse(dk + 'T00:00:00Z') / 1000 - off }));
  const out = { hours: obsTimes.filter(t => obsH[t].t != null).length, days: rainDays.length, wetDays: rainDays.filter(d => d.wet).length, leads: {} };
  for (const L of LEADS) {
    const per = {};
    for (const [id, s] of Object.entries(seriesBySrc)) {
      const te = [], we = [];
      for (const t of obsTimes) {
        const o = obsH[t];
        const ft = s.temp[L]?.get(t); if (ft != null && o.t != null) te.push(ft - o.t);
        const fw = s.wind[L]?.get(t); if (fw != null && o.w != null) we.push(fw - o.w);
      }
      let rc = 0, rn = 0, hits = 0, falseAlarms = 0;
      for (const d of rainDays) {
        let sum = 0, n = 0; for (let k = 0; k < 24; k++) { const v = s.precip[L]?.get(d.start + k * 3600); if (v != null) { sum += v; n++; } }
        if (n < 20) continue;
        const fWet = sum >= WET_IN; rn++; if (fWet === d.wet) rc++; if (fWet && d.wet) hits++; if (fWet && !d.wet) falseAlarms++;
      }
      if (te.length < 24) continue;
      per[id] = {
        tMAE: mean(te.map(Math.abs)), tBias: mean(te), tN: te.length,
        wMAE: we.length >= 24 ? mean(we.map(Math.abs)) : null, wBias: we.length >= 24 ? mean(we) : null,
        rAcc: rn >= 3 ? rc / rn : null, rN: rn, hits, falseAlarms,
      };
    }
    // overall order: temperature counts double, then wind, then rain calls
    const ids = Object.keys(per); const rankBy = (k, asc) => { const v = ids.filter(id => per[id][k] != null).sort((a, c) => asc ? per[a][k] - per[c][k] : per[c][k] - per[a][k]); return Object.fromEntries(v.map((id, i) => [id, i + 1])); };
    const rt = rankBy('tMAE', true), rw = rankBy('wMAE', true), rr = rankBy('rAcc', false);
    for (const id of ids) {
      const parts = [[rt[id], 2], [rw[id], 1], [rr[id], 1]].filter(x => x[0] != null);
      per[id].score = parts.reduce((s, [r, w]) => s + r * w, 0) / parts.reduce((s, [, w]) => s + w, 0);
    }
    out.leads[L] = per;
  }
  return out;
}

/* ---------- Run the whole thing for a place ---------- */
async function ensureSkill(place, b, force = false) {
  if (!place || !b) return null;
  const cached = skillGet(place.id);
  if (!force && cached && Date.now() - cached.at < SKILL_TTL) return cached;
  if (skillRuns[place.id]) return skillRuns[place.id];
  const run = (async () => {
    const station = b.obs?.station;
    if (!station) { skillStatus[place.id] = 'No nearby NWS station is reporting right now, so there is nothing to grade against.'; return cached; }
    skillStatus[place.id] = 'Fetching past forecasts and station history…'; rerenderSkillViews();
    const omSrc = SOURCES.filter(s => s.kind !== 'nws');
    const [prev, obsH] = await Promise.all([
      Promise.all(omSrc.map(s => fetchPrevRuns(s, b.sources[s.id]?.modelId, place).then(r => [s.id, r]))),
      updateObs(station.id),
    ]);
    const series = {}; const failed = [];
    for (const [id, r] of prev) { if (r.ok) series[id] = r.series; else failed.push(id); }
    series.nws = nwsHistorySeries(place.id);
    const off = b.utcOffset;
    const s = { at: Date.now(), station, failed, w7: scoreWindow(series, obsH, 7, off), w30: scoreWindow(series, obsH, 30, off) };
    skillSet(place.id, s); delete skillStatus[place.id];
    return s;
  })().catch(e => { skillStatus[place.id] = 'Could not grade sources: ' + e.message; return cached; })
    .finally(() => { delete skillRuns[place.id]; rerenderSkillViews(); });
  skillRuns[place.id] = run;
  return run;
}
function rerenderSkillViews() { if (typeof renderAll === 'function') renderAll(); }

/* ---------- Skill-weighted best guess ---------- */
function bestWindow(s) { if (!s) return null; return (s.w30 && s.w30.hours >= 24 * 10) ? s.w30 : s.w7; }
function bestGuessReady(placeId) {
  const w = bestWindow(skillGet(placeId)); return !!(w && w.leads[1] && Object.keys(w.leads[1]).length >= 3);
}
function usingBestGuess(placeId) { return state.method !== 'median' && bestGuessReady(placeId); }
function leadFor(hoursAhead) { return hoursAhead <= 36 ? 1 : hoursAhead <= 60 ? 2 : hoursAhead <= 96 ? 3 : 5; }

/* weights ~ 1/MAE², bias removed for temperature-like values; sources not yet graded get the median weight */
function weightsFor(placeId, L) {
  const w = bestWindow(skillGet(placeId)); const per = w?.leads[L] || w?.leads[1] || {};
  const raw = {}; for (const [id, p] of Object.entries(per)) raw[id] = { w: 1 / Math.max(1.0, p.tMAE) ** 2, bias: p.tBias || 0 };
  return raw;
}
function combine(placeId, pairs, L, kind) {
  const vals = pairs.filter(([, v]) => v != null && Number.isFinite(v));
  if (!vals.length) return null;
  if (!usingBestGuess(placeId) || vals.length < 2) return median(vals.map(x => x[1]));
  const W = weightsFor(placeId, L); const ws = Object.values(W).map(x => x.w); const wMed = median(ws) || 1;
  let sw = 0, sv = 0;
  for (const [id, v] of vals) {
    const k = W[id]; const w = k ? k.w : wMed; const corr = (kind === 'temp' && k) ? v - k.bias : v;
    sw += w; sv += w * corr;
  }
  return sw ? sv / sw : median(vals.map(x => x[1]));
}
function consensusName(placeId) { return usingBestGuess(placeId) ? 'Best guess' : 'Consensus'; }

/* ---------- Leaderboard screen ---------- */
let skillChart = null;
function renderSkill() {
  const el = $('#view-skill'); const place = activePlace();
  if (!place) { el.innerHTML = `<div class="card empty">Add a place first.</div>`; return; }
  const b = state.data[place.id]; const s = skillGet(place.id); const status = skillStatus[place.id];
  if (!s) {
    el.innerHTML = `<div class="card empty">${esc(status || 'Grading sources…')}<br><br><span class="small muted">First run fetches a week of past forecasts and station reports.</span></div>${skeleton(2)}`;
    if (b && !skillRuns[place.id] && !status) ensureSkill(place, b);
    return;
  }
  const win = state.skillWin === '30' ? s.w30 : s.w7; const L = state.skillLead || 1;
  const per = win.leads[L] || {};
  const ids = Object.keys(per).sort((a, c) => per[a].score - per[c].score || per[a].tMAE - per[c].tMAE);
  const maxMAE = max(ids.map(id => per[id].tMAE)) || 1;
  const leadTxt = L === 1 ? '1 day' : L + ' days';
  const st = s.station;
  const fmtBias = v => v == null ? '' : Math.abs(v) < 0.5 ? 'no warm/cold bias' : `runs ${Math.abs(v).toFixed(1)}° ${v > 0 ? 'warm' : 'cold'}`;
  const rows = ids.map((id, i) => {
    const p = per[id]; const src = SRC[id];
    return `<div class="lb-row">
      <div class="lb-rank">${i + 1}</div>
      <div class="lb-main">
        <div class="lb-name"><span class="sw-inline" style="background:${src.color}"></span>${src.name}${i === 0 ? ' <span class="conf conf-H"><span class="dot"></span>Most accurate</span>' : ''}</div>
        <div class="lb-bar"><div style="width:${(p.tMAE / maxMAE * 100).toFixed(1)}%;background:${src.color}"></div></div>
        <div class="lb-meta">${fmtBias(p.tBias)} · ${p.tN} hours graded</div>
      </div>
      <div class="lb-nums">
        <div><b>${p.tMAE.toFixed(1)}°</b><span>temp off</span></div>
        <div><b>${p.wMAE == null ? '—' : p.wMAE.toFixed(1)}</b><span>wind mph</span></div>
        <div><b>${p.rAcc == null ? '—' : Math.round(p.rAcc * 100) + '%'}</b><span>rain calls</span></div>
      </div>
    </div>`;
  }).join('');
  const notGraded = SOURCES.filter(x => !per[x.id]).map(x => {
    if (x.id === 'nws') return 'NWS: its past forecasts aren\'t archived, so the app records them as you use it. Grades appear after a few days of use.';
    if (s.failed.includes(x.id)) return `${x.name}: past forecasts unavailable.`;
    if (x.id === 'hrrr' && L > 2) return 'HRRR only forecasts 2 days ahead.';
    return `${x.name}: not enough overlap with station reports yet.`;
  });

  // weights shown for the best guess
  const W = weightsFor(place.id, 1); const sw = Object.values(W).reduce((a, x) => a + x.w, 0);
  const topW = Object.entries(W).sort((a, c) => c[1].w - a[1].w).slice(0, 4).map(([id, x]) => `${SRC[id].name} ${Math.round(x.w / sw * 100)}%`).join(', ');
  const ready = bestGuessReady(place.id);

  el.innerHTML = `
    <div class="card">
      <h2>How accurate is each source here?</h2>
      <div class="ink2 small" style="margin:-4px 0 12px">Each source's forecast from ${leadTxt} earlier, checked against what <b>${esc(st.id)}</b> (${esc(st.name)}, ${st.dist.toFixed(1)} mi) actually recorded.</div>
      <div class="row" style="flex-wrap:wrap;gap:8px">
        <span class="small muted">Forecast made</span><div class="seg">${LEADS.map(x => `<button data-lead="${x}" class="${x === L ? 'on' : ''}">${x}d</button>`).join('')}</div><span class="small muted">ahead</span>
        <span class="spacer"></span><div class="seg">${['7', '30'].map(x => `<button data-win="${x}" class="${(state.skillWin || '7') === x ? 'on' : ''}">Last ${x}d</button>`).join('')}</div>
      </div>
      <div class="lb">${rows || '<div class="muted small" style="padding:12px 0">Not enough graded hours for this lead time yet.</div>'}</div>
      ${notGraded.length ? `<div class="foot" style="padding:8px 0 0">${notGraded.map(esc).join('<br>')}</div>` : ''}
    </div>
    <div class="card">
      <h2>Temperature error by lead time <span class="h2-note">· lower is better</span></h2>
      <div class="chart-box" style="height:220px"><canvas id="skillChart" role="img" aria-label="Average temperature error by forecast lead time for each source"></canvas></div>
      <div class="legend">${SOURCES.filter(x => LEADS.some(l => win.leads[l]?.[x.id])).map(x => `<span class="src" style="cursor:default"><span class="sw" style="background:${x.color}"></span>${x.name}</span>`).join('')}</div>
    </div>
    <div class="card">
      <h2>Best guess forecast</h2>
      <p class="ink2" style="margin:0 0 10px;line-height:1.45;font-size:14px">${ready
        ? `Now and Compare can blend the sources by how accurate they've been here and correct each one's usual warm or cold lean. Biggest 1-day weights right now: <b>${esc(topW)}</b>.`
        : 'Needs at least 3 graded sources before it can switch on.'}</p>
      <div class="seg"><button data-method="best" class="${state.method !== 'median' ? 'on' : ''}" ${ready ? '' : 'disabled'}>Best guess</button><button data-method="median" class="${state.method === 'median' ? 'on' : ''}">Simple middle value</button></div>
    </div>
    <div class="foot">
      Graded ${win.hours} station hours${win.days ? `, ${win.days} full days for rain calls (${win.wetDays} wet)` : ''} · updated ${ago(s.at)}${status ? ' · ' + esc(status) : ''}.
      "Temp off" is the average miss in °F. "Rain calls" is how often a source got wet vs dry right (wet = ${WET_IN}"+ in a day). The 30-day view fills in as station reports build up on this phone.
      Past forecasts: <a href="https://open-meteo.com/en/docs/previous-runs-api" target="_blank" rel="noopener">Open-Meteo Previous Runs</a>; observations: NOAA/NWS.
      <br><button class="btn" id="regrade" style="margin-top:10px">Regrade now</button>
    </div>`;

  el.querySelectorAll('[data-lead]').forEach(x => x.addEventListener('click', () => { state.skillLead = +x.dataset.lead; renderSkill(); }));
  el.querySelectorAll('[data-win]').forEach(x => x.addEventListener('click', () => { state.skillWin = x.dataset.win; store.set('skillWin', state.skillWin); renderSkill(); }));
  el.querySelectorAll('[data-method]').forEach(x => x.addEventListener('click', () => { state.method = x.dataset.method; store.set('method', state.method); toast(state.method === 'median' ? 'Using the simple middle value' : 'Using the best-guess blend'); renderSkill(); }));
  $('#regrade').addEventListener('click', () => { if (b) ensureSkill(place, b, true); toast('Regrading…'); });
  drawSkillChart(win);
}

function drawSkillChart(win) {
  const css = getComputedStyle(document.documentElement);
  const muted = css.getPropertyValue('--muted').trim(), grid = css.getPropertyValue('--grid').trim(), ink = css.getPropertyValue('--ink').trim();
  const datasets = SOURCES.filter(x => LEADS.some(l => win.leads[l]?.[x.id])).map(x => ({
    label: x.name, borderColor: x.color, backgroundColor: x.color, borderWidth: 2, pointRadius: 4, pointHoverRadius: 6, tension: 0.2, spanGaps: true,
    data: LEADS.map(l => ({ x: l, y: win.leads[l]?.[x.id]?.tMAE ?? null })),
  }));
  if (skillChart) { skillChart.destroy(); skillChart = null; }
  const cv = $('#skillChart'); if (!cv) return;
  skillChart = new Chart(cv, {
    type: 'line', data: { datasets },
    options: {
      animation: false, responsive: true, maintainAspectRatio: false, parsing: false,
      interaction: { mode: 'nearest', axis: 'x', intersect: false },
      plugins: {
        legend: { display: false },
        tooltip: {
          mode: 'index', intersect: false, backgroundColor: 'rgba(35,35,33,0.96)', titleColor: ink, bodyColor: ink, borderColor: 'rgba(255,255,255,0.12)', borderWidth: 1, padding: 10,
          filter: it => it.raw.y != null, itemSort: (a, c) => a.raw.y - c.raw.y,
          callbacks: { title: it => it.length ? `${it[0].raw.x} day${it[0].raw.x > 1 ? 's' : ''} ahead` : '', label: it => ` ${it.dataset.label}: ${it.raw.y.toFixed(1)}°` },
        },
      },
      scales: {
        x: { type: 'linear', min: 0.8, max: 5.2, afterBuildTicks: ax => { ax.ticks = LEADS.map(v => ({ value: v })); }, ticks: { color: muted, callback: v => v + 'd' }, grid: { color: grid }, border: { color: '#383835' } },
        y: { beginAtZero: true, ticks: { color: muted, maxTicksLimit: 5, callback: v => v + '°' }, grid: { color: grid }, border: { display: false } },
      },
    },
  });
}
