/* WX Pro — radar map (IEM NEXRAD loop, NWS warning polygons, SPC outlook) and the Alerts screen.
   Loaded before app.js; uses app.js globals only inside functions that run later. */
'use strict';

const IEM_TILES = 'https://mesonet.agron.iastate.edu/cache/tile.py/1.0.0/';
const RADAR_STEPS = [55, 50, 45, 40, 35, 30, 25, 20, 15, 10, 5, 0];   // minutes old
const WARN_EVENTS = ['Tornado Warning', 'Severe Thunderstorm Warning', 'Flash Flood Warning', 'Extreme Wind Warning', 'Snow Squall Warning', 'Special Marine Warning', 'Dust Storm Warning'];
const WARN_COLORS = {
  'Tornado Warning': '#ff2a2a', 'Severe Thunderstorm Warning': '#ffa500', 'Flash Flood Warning': '#2ee86f',
  'Extreme Wind Warning': '#ff5fa2', 'Snow Squall Warning': '#c77dff', 'Special Marine Warning': '#ffa500', 'Dust Storm Warning': '#e0c9a6',
};
const SPC_LEVELS = [
  { code: 'TSTM', name: 'General thunder', n: 0, color: '#c1e9c1' },
  { code: 'MRGL', name: 'Marginal', n: 1, color: '#66a366' },
  { code: 'SLGT', name: 'Slight', n: 2, color: '#ffe066' },
  { code: 'ENH',  name: 'Enhanced', n: 3, color: '#ffa366' },
  { code: 'MDT',  name: 'Moderate', n: 4, color: '#e06666' },
  { code: 'HIGH', name: 'High', n: 5, color: '#ee99ee' },
];
const SPC_SERVICE = 'https://mapservices.weather.noaa.gov/vector/rest/services/outlooks/SPC_wx_outlks/MapServer';
const SPC_TTL = 30 * 60e3, ALERTS_TTL = 5 * 60e3, WARN_TTL = 2 * 60e3;

const radar = { map: null, frames: [], idx: RADAR_STEPS.length - 1, timer: null, playing: false, bucket: 0, validMs: null,
  warnLayer: null, warnAt: 0, spcLayer: null, placeLayer: null, centeredOn: null, show: { warn: true, spc: false } };
const spc = { at: 0, days: {}, err: null, loading: null };
const alertCache = {};   // placeId -> { at, alerts, err }

/* ---------- SPC outlooks ---------- */
function spcLevelOf(props) {
  const p = {}; for (const [k, v] of Object.entries(props || {})) p[k.toLowerCase()] = v;
  const lab = String(p.label || '').toUpperCase();
  let lv = SPC_LEVELS.find(l => l.code === lab);
  if (!lv && p.dn != null) lv = { 2: SPC_LEVELS[0], 3: SPC_LEVELS[1], 4: SPC_LEVELS[2], 5: SPC_LEVELS[3], 6: SPC_LEVELS[4], 8: SPC_LEVELS[5] }[+p.dn];
  if (!lv && p.label2) lv = SPC_LEVELS.slice().reverse().find(l => String(p.label2).toLowerCase().includes(l.name.toLowerCase().split(' ')[0]));
  return lv || null;
}
async function ensureSpc(force = false) {
  if (!force && spc.at && Date.now() - spc.at < SPC_TTL) return spc;
  if (spc.loading) return spc.loading;
  spc.loading = (async () => {
    try {
      const lj = await getJSON(SPC_SERVICE + '/layers?f=json', { timeout: 20000 });
      const ids = {};
      for (const l of lj.layers || []) { const m = /^Day ([123]) Categorical Outlook$/i.exec(l.name || ''); if (m) ids[m[1]] = l.id; }
      const days = {};
      await Promise.all(Object.entries(ids).map(async ([d, id]) => {
        try { days[d] = await getJSON(`${SPC_SERVICE}/${id}/query?where=1%3D1&outFields=*&returnGeometry=true&f=geojson`, { timeout: 25000 }); } catch {}
      }));
      if (!Object.keys(days).length) throw new Error('no outlook layers');
      spc.days = days; spc.at = Date.now(); spc.err = null;
    } catch (e) { spc.err = e.message; }
    finally { spc.loading = null; }
    return spc;
  })();
  return spc.loading;
}
function pointInRing(x, y, ring) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i], [xj, yj] = ring[j];
    if ((yi > y) !== (yj > y) && x < (xj - xi) * (y - yi) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}
function pointInGeom(lon, lat, g) {
  if (!g) return false;
  const polys = g.type === 'Polygon' ? [g.coordinates] : g.type === 'MultiPolygon' ? g.coordinates : [];
  return polys.some(p => pointInRing(lon, lat, p[0]) && !p.slice(1).some(h => pointInRing(lon, lat, h)));
}
function spcRiskAt(day, lat, lon) {
  const fc = spc.days[day]; if (!fc) return undefined;          // undefined = unknown, null = no risk
  let best = null;
  for (const f of fc.features || []) { const lv = spcLevelOf(f.properties); if (lv && (!best || lv.n > best.n) && pointInGeom(lon, lat, f.geometry)) best = lv; }
  return best;
}
function spcChip(day, lv) {
  const dname = day === '1' ? 'Today' : day === '2' ? 'Tomorrow' : 'Day 3';
  if (lv === undefined) return `<span class="risk"><span class="risk-sw" style="background:var(--surface-2)"></span>${dname}: —</span>`;
  if (!lv || lv.n === 0) return `<span class="risk"><span class="risk-sw" style="background:${lv ? lv.color : 'var(--surface-2)'}"></span>${dname}: ${lv ? 'thunder only' : 'no severe risk'}</span>`;
  return `<span class="risk risk-on"><span class="risk-sw" style="background:${lv.color}"></span>${dname}: <b>${lv.name}</b> (${lv.n}/5)</span>`;
}
function spcCardForNow(place) {
  if (!spc.at) return '';
  const r1 = spcRiskAt('1', place.lat, place.lon), r2 = spcRiskAt('2', place.lat, place.lon);
  if (!((r1 && r1.n >= 1) || (r2 && r2.n >= 1))) return '';
  return `<div class="card"><h2>Severe storm outlook <span class="h2-note">· NOAA Storm Prediction Center</span></h2><div class="risks">${spcChip('1', r1)}${spcChip('2', r2)}${spcChip('3', spcRiskAt('3', place.lat, place.lon))}</div></div>`;
}

/* ---------- Alerts for every saved place ---------- */
async function loadPlaceAlerts(place, force = false) {
  const c = alertCache[place.id];
  if (!force && c && Date.now() - c.at < ALERTS_TTL) return c;
  try { alertCache[place.id] = { at: Date.now(), alerts: await fetchAlerts(place) }; }
  catch (e) { alertCache[place.id] = { at: Date.now(), alerts: [], err: e.message }; }
  return alertCache[place.id];
}
function alertCount() { return state.places.reduce((n, p) => n + (alertCache[p.id]?.alerts?.length || 0), 0); }
function updateAlertBadge() {
  const tab = document.querySelector('.tab[data-tab="alerts"]'); if (!tab) return;
  const n = alertCount(); let b = tab.querySelector('.badge');
  if (n && !b) { b = document.createElement('span'); b.className = 'badge'; tab.appendChild(b); }
  if (b) { if (n) b.textContent = n > 9 ? '9+' : n; else b.remove(); }
}
async function refreshAllAlerts(force = false) {
  await Promise.all([ensureSpc(force), ...state.places.map(p => loadPlaceAlerts(p, force))]);
  updateAlertBadge();
}

let alertsLoading = false;
function renderAlertsView() {
  const el = $('#view-alerts');
  if (!state.places.length) { el.innerHTML = `<div class="card empty">Add places to watch for alerts.</div>`; return; }
  const stale = state.places.some(p => !alertCache[p.id] || Date.now() - alertCache[p.id].at > ALERTS_TTL) || !spc.at;
  if (stale && !alertsLoading) { alertsLoading = true; refreshAllAlerts().finally(() => { alertsLoading = false; if (currentTab() === 'alerts') renderAlertsView(); }); }
  const total = alertCount();
  const cards = state.places.map(p => {
    const c = alertCache[p.id];
    const body = !c ? '<div class="muted small">Checking…</div>'
      : c.err ? `<div class="err">Couldn't check NWS alerts (${esc(c.err)}).</div>`
      : c.alerts.length ? c.alerts.map(a => alertDetailsHtml(a)).join('')
      : '<div class="muted small">✓ No active NWS alerts.</div>';
    return `<div class="card">
      <div class="row place-head" data-go="${esc(p.id)}"><div><div class="li-title">${esc(p.name)}</div><div class="li-sub">${esc(p.sub || '')}</div></div><span class="spacer"></span><span class="muted small">Forecast ›</span></div>
      <div class="risks">${['1', '2', '3'].map(d => spcChip(d, spcRiskAt(d, p.lat, p.lon))).join('')}</div>
      <div style="margin-top:10px">${body}</div>
    </div>`;
  }).join('');
  el.innerHTML = `
    <div class="card" style="padding:12px 14px"><div class="row"><div><b>${total ? `${total} active alert${total > 1 ? 's' : ''}` : 'All quiet'}</b>
      <div class="small muted">${state.places.length} saved place${state.places.length > 1 ? 's' : ''} · NWS alerts + SPC severe outlook</div></div>
      <span class="spacer"></span><button class="btn" id="alertsRefresh">Refresh</button></div></div>
    ${cards}
    <div class="foot">Severe outlook levels: Marginal (1) · Slight (2) · Enhanced (3) · Moderate (4) · High (5).${spc.err ? ` SPC outlook unavailable (${esc(spc.err)}).` : ''}
      Alerts show when the app is open; this app does not send push notifications. Keep an official alert app (Wireless Emergency Alerts, NOAA Weather Radio) on for warnings.</div>`;
  el.querySelectorAll('[data-go]').forEach(x => x.addEventListener('click', () => { setActive(x.dataset.go); location.hash = '#now'; }));
  $('#alertsRefresh').addEventListener('click', () => { toast('Checking alerts…'); refreshAllAlerts(true).then(() => currentTab() === 'alerts' && renderAlertsView()); });
  updateAlertBadge();
}
function alertDetailsHtml(a) {
  const until = a.ends ? new Date(a.ends).toLocaleString([], { weekday: 'short', hour: 'numeric', minute: '2-digit' }) : '';
  return `<details class="alert">
    <summary><span class="sev-bar sev-${esc(a.severity)}"></span>
      <div><div class="alert-title">⚠️ ${esc(a.event)}<span class="sev-label sev-${esc(a.severity)}">${esc(a.severity)}</span></div>
      <div class="alert-meta">${until ? 'Until ' + esc(until) + ' · ' : ''}${esc(a.sender || '')} · tap for details</div></div>
    </summary>
    <div class="alert-body">${a.headline ? `<h4>${esc(a.headline)}</h4>` : ''}${esc(a.description || '')}${a.instruction ? `<h4>What to do</h4>${esc(a.instruction)}` : ''}</div>
  </details>`;
}

/* ---------- Radar map ---------- */
function radarUrl(min) { return `${IEM_TILES}nexrad-n0q-900913${min ? '-m' + String(min).padStart(2, '0') + 'm' : ''}/{z}/{x}/{y}.png?v=${radar.bucket}`; }
function frameLabel(i) {
  const min = RADAR_STEPS[i];
  if (radar.validMs) return new Date(radar.validMs - min * 60e3).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  return min ? `−${min} min` : 'Latest';
}
function sizeMap() {
  const wrap = $('#mapWrap'); if (!wrap) return;
  const top = $('.topbar').offsetHeight, bot = $('.tabbar').offsetHeight;
  wrap.style.height = Math.max(320, window.innerHeight - top - bot - 24) + 'px';
  radar.map && radar.map.invalidateSize();
}
function buildRadarFrames(force = false) {
  const bucket = Math.floor(Date.now() / 300e3);
  if (!force && radar.frames.length && bucket === radar.bucket) return;
  radar.bucket = bucket;
  radar.frames.forEach(l => radar.map.removeLayer(l));
  radar.frames = RADAR_STEPS.map(min => L.tileLayer(radarUrl(min), { opacity: 0, zIndex: 300, maxNativeZoom: 10, maxZoom: 13, attribution: 'Radar: <a href="https://mesonet.agron.iastate.edu/" target="_blank" rel="noopener">IEM</a> / NOAA NEXRAD', pane: 'radar' }).addTo(radar.map));
  showFrame(radar.frames.length - 1);
  // valid time of the latest composite, when IEM exposes it
  getJSON('https://mesonet.agron.iastate.edu/data/gis/images/4326/USCOMP/n0q_0.json', { timeout: 10000 })
    .then(j => { const v = Date.parse(j?.meta?.valid || j?.meta?.valid_time || ''); if (Number.isFinite(v)) { radar.validMs = v; showFrame(radar.idx); } })
    .catch(() => {});
}
function showFrame(i) {
  radar.idx = i;
  radar.frames.forEach((l, k) => l.setOpacity(k === i ? 0.78 : 0));
  const s = $('#radarSlider'); if (s) s.value = i;
  const t = $('#radarTime'); if (t) t.textContent = frameLabel(i);
}
function setPlaying(on) {
  radar.playing = on; clearTimeout(radar.timer);
  const btn = $('#radarPlay'); if (btn) btn.innerHTML = on ? '❚❚' : '▶';
  if (!on) return;
  const step = () => {
    const next = (radar.idx + 1) % radar.frames.length; showFrame(next);
    radar.timer = setTimeout(step, next === radar.frames.length - 1 ? 1600 : 450);
  };
  radar.timer = setTimeout(step, 300);
}
async function loadWarnings(force = false) {
  if (!radar.map) return;
  if (!force && radar.warnAt && Date.now() - radar.warnAt < WARN_TTL) return;
  radar.warnAt = Date.now();
  try {
    const j = await getJSON('https://api.weather.gov/alerts/active?status=actual&event=' + encodeURIComponent(WARN_EVENTS.join(',')), { headers: NWS_HDR, timeout: 25000 });
    const feats = (j.features || []).filter(f => f.geometry).map(f => ({ type: 'Feature', geometry: f.geometry, properties: f.properties || {} }));
    if (radar.warnLayer) radar.map.removeLayer(radar.warnLayer);
    radar.warnLayer = L.geoJSON({ type: 'FeatureCollection', features: feats }, {
      pane: 'warn',
      style: f => ({ color: WARN_COLORS[f.properties.event] || '#fff', weight: 2.5, fillOpacity: 0.12, fillColor: WARN_COLORS[f.properties.event] || '#fff' }),
      onEachFeature: (f, layer) => {
        const p = f.properties; const ends = Date.parse(p.ends || p.expires);
        layer.bindPopup(`<b>${esc(p.event)}</b><br>${Number.isFinite(ends) ? 'Until ' + esc(new Date(ends).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })) + '<br>' : ''}<span class="pop-sub">${esc(p.areaDesc || '')}</span>`);
      },
    });
    if (radar.show.warn) radar.warnLayer.addTo(radar.map);
    const n = feats.length; const el = $('#warnCount'); if (el) el.textContent = n ? ` (${n})` : '';
  } catch (e) { console.error('warnings: ' + e.message); const el = $('#warnCount'); if (el) el.textContent = ' (offline)'; }
}
async function loadSpcLayer() {
  await ensureSpc();
  if (!radar.map || !spc.days['1']) { if (spc.err) toast('SPC outlook unavailable'); return; }
  if (radar.spcLayer) radar.map.removeLayer(radar.spcLayer);
  radar.spcLayer = L.geoJSON(spc.days['1'], {
    pane: 'spc',
    style: f => { const lv = spcLevelOf(f.properties); const c = (f.properties.fill || f.properties.FILL) || lv?.color || '#999'; return { color: c, weight: 1.5, fillColor: c, fillOpacity: 0.22 }; },
    onEachFeature: (f, layer) => { const lv = spcLevelOf(f.properties); if (lv) layer.bindPopup(`<b>SPC Day 1: ${lv.name}</b>${lv.n ? ` (${lv.n}/5)` : ''}`); },
  });
  if (radar.show.spc) radar.spcLayer.addTo(radar.map);
}
function drawPlaces() {
  if (!radar.map) return;
  if (radar.placeLayer) radar.map.removeLayer(radar.placeLayer);
  radar.placeLayer = L.layerGroup(state.places.map(p => L.circleMarker([p.lat, p.lon], {
    pane: 'places', radius: p.id === state.activeId ? 7 : 5, color: '#0d0d0d', weight: 2, fillColor: p.id === state.activeId ? '#f0efec' : '#c3c2b7', fillOpacity: 1,
  }).bindTooltip(esc(p.name), { direction: 'top', offset: [0, -6] }))).addTo(radar.map);
}

function renderRadar() {
  const el = $('#view-radar'); const place = activePlace();
  if (typeof L === 'undefined') { el.innerHTML = '<div class="card err">Map library failed to load.</div>'; return; }
  if (!radar.map) {
    el.innerHTML = `
      <div class="map-wrap" id="mapWrap">
        <div id="map"></div>
        <div class="map-top">
          <button class="chip ${radar.show.warn ? 'on' : ''}" data-layer="warn">Warnings<span id="warnCount"></span></button>
          <button class="chip ${radar.show.spc ? 'on' : ''}" data-layer="spc">Storm outlook</button>
          <span class="spacer"></span>
          <button class="icon-btn map-btn" id="radarHome" aria-label="Center on place">◎</button>
        </div>
        <div class="map-bottom">
          <div class="row"><button class="icon-btn map-btn" id="radarPlay" aria-label="Play radar loop">▶</button>
            <input type="range" id="radarSlider" min="0" max="${RADAR_STEPS.length - 1}" value="${RADAR_STEPS.length - 1}" aria-label="Radar frame">
            <span class="radar-time" id="radarTime">Latest</span></div>
          <div class="dbz"><span class="dbz-bar"></span><div class="dbz-lab"><span>Light</span><span>20</span><span>35</span><span>50</span><span>65 dBZ</span></div></div>
        </div>
      </div>`;
    const map = L.map('map', { zoomControl: false, attributionControl: true, worldCopyJump: false, minZoom: 3, maxZoom: 13 });
    radar.map = map;
    map.createPane('radar').style.zIndex = 300;
    map.createPane('spc').style.zIndex = 350;
    map.createPane('warn').style.zIndex = 420;
    map.createPane('labels').style.zIndex = 450; map.getPane('labels').style.pointerEvents = 'none';
    map.createPane('places').style.zIndex = 460;
    L.tileLayer('https://{s}.basemaps.cartocdn.com/dark_nolabels/{z}/{x}/{y}{r}.png', { subdomains: 'abcd', maxZoom: 19, attribution: '&copy; <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">OpenStreetMap</a> &copy; <a href="https://carto.com/attributions" target="_blank" rel="noopener">CARTO</a>' }).addTo(map);
    L.tileLayer('https://{s}.basemaps.cartocdn.com/dark_only_labels/{z}/{x}/{y}{r}.png', { subdomains: 'abcd', maxZoom: 19, pane: 'labels' }).addTo(map);
    L.control.zoom({ position: 'bottomright' }).addTo(map);
    map.attributionControl.setPrefix(false);
    const c = place ? [place.lat, place.lon] : [37.5, -96]; map.setView(c, place ? 8 : 4); radar.centeredOn = place?.id;

    $('#radarSlider').addEventListener('input', e => { setPlaying(false); showFrame(+e.target.value); });
    $('#radarPlay').addEventListener('click', () => setPlaying(!radar.playing));
    $('#radarHome').addEventListener('click', () => { const p = activePlace(); if (p) map.setView([p.lat, p.lon], Math.max(map.getZoom(), 8)); });
    el.querySelectorAll('[data-layer]').forEach(b => b.addEventListener('click', () => {
      const k = b.dataset.layer; radar.show[k] = !radar.show[k]; b.classList.toggle('on', radar.show[k]);
      const lyr = k === 'warn' ? radar.warnLayer : radar.spcLayer;
      if (radar.show[k]) { if (lyr) lyr.addTo(map); else if (k === 'spc') loadSpcLayer(); } else if (lyr) map.removeLayer(lyr);
    }));
    window.addEventListener('resize', sizeMap);
  }
  sizeMap();
  setTimeout(sizeMap, 50);
  if (place && radar.centeredOn !== place.id) { radar.map.setView([place.lat, place.lon], Math.max(radar.map.getZoom(), 8)); radar.centeredOn = place.id; }
  buildRadarFrames();
  drawPlaces();
  loadWarnings();
  if (radar.show.spc && !radar.spcLayer) loadSpcLayer();
}
function leaveRadar() { setPlaying(false); }
