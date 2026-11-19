/* WX Pro — multi-model weather for the US.
   Data: Open-Meteo (CC BY 4.0) and NOAA / National Weather Service. */
'use strict';

/* ---------- Sources (fixed color per source: color follows the entity) ---------- */
const SOURCES = [
  { id: 'nws',   name: 'NWS',   full: 'NWS official forecast',          kind: 'nws', color: '#3987e5' },
  { id: 'hrrr',  name: 'HRRR',  full: 'NOAA HRRR 3 km (to 48 h)',        ids: ['ncep_hrrr_conus', 'gfs_hrrr'], color: '#d95926' },
  { id: 'nbm',   name: 'NBM',   full: 'NOAA National Blend of Models',   ids: ['ncep_nbm_conus'], color: '#199e70' },
  { id: 'gfs',   name: 'GFS',   full: 'NOAA GFS global',                 ids: ['gfs_global', 'gfs025', 'gfs_seamless'], color: '#c98500' },
  { id: 'ecmwf', name: 'ECMWF', full: 'ECMWF IFS (European)',            ids: ['ecmwf_ifs', 'ecmwf_ifs025'], color: '#d55181' },
  { id: 'aifs',  name: 'AIFS',  full: 'ECMWF AIFS (AI model)',           ids: ['ecmwf_aifs025_single', 'ecmwf_aifs025'], color: '#0ca30c' },
  { id: 'icon',  name: 'ICON',  full: 'DWD ICON (German)',               ids: ['icon_global', 'icon_seamless'], color: '#9085e9' },
  { id: 'gem',   name: 'GEM',   full: 'Environment Canada GEM',          ids: ['gem_global', 'gem_seamless'], color: '#e66767' },
];
const SRC = Object.fromEntries(SOURCES.map(s => [s.id, s]));

/* Variables: internal key -> Open-Meteo name, NWS gridpoint name */
const OM_VARS = {
  temp: 'temperature_2m', feels: 'apparent_temperature', dew: 'dew_point_2m', rh: 'relative_humidity_2m',
  precip: 'precipitation', pop: 'precipitation_probability', snow: 'snowfall', code: 'weather_code',
  cloud: 'cloud_cover', wind: 'wind_speed_10m', gust: 'wind_gusts_10m', wdir: 'wind_direction_10m',
};
const NWS_VARS = {
  temp: ['temperature', 'avg'], feels: ['apparentTemperature', 'avg'], dew: ['dewpoint', 'avg'],
  rh: ['relativeHumidity', 'avg'], precip: ['quantitativePrecipitation', 'sum'], pop: ['probabilityOfPrecipitation', 'avg'],
  snow: ['snowfallAmount', 'sum'], cloud: ['skyCover', 'avg'], wind: ['windSpeed', 'avg'], gust: ['windGust', 'avg'],
  wdir: ['windDirection', 'avg'],
};

/* What the Compare screen can plot */
const PLOTS = {
  temp:  { label: 'Temp',        unit: '°F', key: 'temp',   daily: 'hilo' },
  feels: { label: 'Feels like',  unit: '°F', key: 'feels',  daily: 'hilo' },
  rain:  { label: 'Rain total',  unit: 'in', key: 'precip', daily: 'sum', cumulative: true, dec: 2 },
  pop:   { label: 'Rain chance', unit: '%',  key: 'pop',    daily: 'max', min: 0, max: 100 },
  wind:  { label: 'Wind',        unit: 'mph', key: 'wind',  daily: 'max', min: 0 },
  gust:  { label: 'Gusts',       unit: 'mph', key: 'gust',  daily: 'max', min: 0 },
  cloud: { label: 'Clouds',      unit: '%',  key: 'cloud',  daily: 'mean', min: 0, max: 100 },
  dew:   { label: 'Dew point',   unit: '°F', key: 'dew',    daily: 'mean' },
  snow:  { label: 'Snow total',  unit: 'in', key: 'snow',   daily: 'sum', cumulative: true, dec: 1 },
};
const RANGES = { '48h': 48, '5d': 120, '10d': 240 };

const DEFAULT_PLACE = { id: 'alpharetta-ga', name: 'Alpharetta', sub: 'Georgia', lat: 34.0754, lon: -84.2941 };
const CACHE_MS = 10 * 60 * 1000;

/* ---------- State ---------- */
const store = {
  get(k, d) { try { const v = localStorage.getItem('wx.' + k); return v == null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem('wx.' + k, JSON.stringify(v)); } catch {} },
};
const state = {
  places: store.get('places', null) || [DEFAULT_PLACE],
  activeId: store.get('active', null),
  enabled: new Set(store.get('enabled', SOURCES.map(s => s.id))),
  plot: store.get('plot', 'temp'),
  range: store.get('range', '5d'),
  data: {},            // placeId -> bundle
  loading: false,
  openDay: null,
  method: store.get('method', 'best'),    // 'best' (skill-weighted) or 'median'
  skillWin: store.get('skillWin', '7'),
  skillLead: 1,
  skill: {},
};
if (!state.places.find(p => p.id === state.activeId)) state.activeId = state.places[0]?.id || null;
if (!PLOTS[state.plot]) state.plot = 'temp';
if (!RANGES[state.range]) state.range = '5d';

const $ = (s, el = document) => el.querySelector(s);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const activePlace = () => state.places.find(p => p.id === state.activeId) || null;

/* ---------- Small math helpers ---------- */
const nums = a => a.filter(v => v != null && Number.isFinite(v));
const median = a => { const b = nums(a).sort((x, y) => x - y); if (!b.length) return null; const m = b.length >> 1; return b.length % 2 ? b[m] : (b[m - 1] + b[m]) / 2; };
const mean = a => { const b = nums(a); return b.length ? b.reduce((s, v) => s + v, 0) / b.length : null; };
const min = a => { const b = nums(a); return b.length ? Math.min(...b) : null; };
const max = a => { const b = nums(a); return b.length ? Math.max(...b) : null; };
const sum = a => { const b = nums(a); return b.length ? b.reduce((s, v) => s + v, 0) : null; };
const r0 = v => v == null ? '—' : Math.round(v);
const fmtIn = (v, d = 2) => v == null ? '—' : (v < 0.005 && d === 2 ? '0' : v.toFixed(d));
const haversineMi = (a, b, c, d) => { const R = 3958.8, toR = x => x * Math.PI / 180; const dLat = toR(c - a), dLon = toR(d - b); const h = Math.sin(dLat / 2) ** 2 + Math.cos(toR(a)) * Math.cos(toR(c)) * Math.sin(dLon / 2) ** 2; return 2 * R * Math.asin(Math.sqrt(h)); };
const compass = deg => deg == null ? '' : ['N', 'NNE', 'NE', 'ENE', 'E', 'ESE', 'SE', 'SSE', 'S', 'SSW', 'SW', 'WSW', 'W', 'WNW', 'NW', 'NNW'][Math.round(((deg % 360) + 360) % 360 / 22.5) % 16];

/* ---------- Unit conversion (NWS returns SI) ---------- */
function conv(uom, v) {
  if (v == null) return null;
  switch ((uom || '').replace('unit:', 'wmoUnit:')) {
    case 'wmoUnit:degC': return v * 9 / 5 + 32;
    case 'wmoUnit:degF': return v;
    case 'wmoUnit:km_h-1': return v / 1.609344;
    case 'wmoUnit:m_s-1': return v * 2.236936;
    case 'wmoUnit:mm': return v / 25.4;
    case 'wmoUnit:m': return v * 39.3701;           // depth in metres -> inches
    case 'wmoUnit:Pa': return v / 3386.389;          // Pa -> inHg
    default: return v;
  }
}
function parseIsoDurHours(d) {
  const m = /P(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?)?/.exec(d || '');
  if (!m) return 1;
  return Math.max(1, (+m[1] || 0) * 24 + (+m[2] || 0));
}

/* ---------- Time helpers (local time of the place via fixed UTC offset) ---------- */
function tz(bundle) { return bundle?.utcOffset ?? 0; }
function localDate(t, off) { return new Date((t + off) * 1000); }
function dateKey(t, off) { return localDate(t, off).toISOString().slice(0, 10); }
function hourLabel(t, off) { const h = localDate(t, off).getUTCHours(); return h === 0 ? '12a' : h === 12 ? '12p' : h < 12 ? h + 'a' : (h - 12) + 'p'; }
const DOW = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
function dayLabel(key, todayKey) {
  if (key === todayKey) return 'Today';
  const d = new Date(key + 'T00:00:00Z'); return DOW[d.getUTCDay()];
}
function shortDate(key) { const d = new Date(key + 'T00:00:00Z'); return (d.getUTCMonth() + 1) + '/' + d.getUTCDate(); }
function ago(ms) { const m = Math.round((Date.now() - ms) / 60000); if (m < 1) return 'just now'; if (m < 60) return m + ' min ago'; const h = Math.round(m / 60); return h + ' h ago'; }

/* ---------- Networking ---------- */
async function getJSON(url, opts = {}) {
  const ctrl = new AbortController(); const to = setTimeout(() => ctrl.abort(), opts.timeout || 20000);
  try {
    const r = await fetch(url, { signal: ctrl.signal, headers: opts.headers || {} });
    const j = await r.json().catch(() => null);
    if (!r.ok) { const e = new Error((j && (j.reason || j.detail || j.title)) || ('HTTP ' + r.status)); e.status = r.status; throw e; }
    return j;
  } finally { clearTimeout(to); }
}
const NWS_HDR = { Accept: 'application/geo+json' };

async function fetchOpenMeteo(src, place) {
  let lastErr = null;
  for (const id of src.ids) {
    const u = new URL('https://api.open-meteo.com/v1/forecast');
    u.search = new URLSearchParams({
      latitude: place.lat.toFixed(4), longitude: place.lon.toFixed(4),
      hourly: Object.values(OM_VARS).join(','), daily: 'sunrise,sunset',
      models: id, temperature_unit: 'fahrenheit', wind_speed_unit: 'mph', precipitation_unit: 'inch',
      timeformat: 'unixtime', timezone: 'auto', past_days: '1', forecast_days: '11',
    }).toString();
    try {
      const j = await getJSON(u);
      const h = j.hourly || {};
      const pick = name => h[name] || h[name + '_' + id] || null;
      const series = {};
      for (const [k, name] of Object.entries(OM_VARS)) series[k] = pick(name);
      if (!series.temp || !nums(series.temp).length) { lastErr = new Error('no data for ' + id); continue; }
      const map = {};
      for (const k of Object.keys(OM_VARS)) {
        const m = new Map(); const arr = series[k] || [];
        h.time.forEach((t, i) => { const v = arr[i]; if (v != null) m.set(t, v); });
        map[k] = m;
      }
      const daily = j.daily || {};
      const sun = (daily.sunrise || []).map((r, i) => [r, (daily.sunset || [])[i]]);
      return { ok: true, modelId: id, series: map, utcOffset: j.utc_offset_seconds, timezone: j.timezone, sun };
    } catch (e) { lastErr = e; }
  }
  return { ok: false, error: lastErr ? lastErr.message : 'unavailable' };
}

async function nwsPoint(place) {
  const key = 'pt.' + place.lat.toFixed(4) + ',' + place.lon.toFixed(4);
  const cached = store.get(key, null);
  if (cached && Date.now() - cached.at < 7 * 864e5) return cached;
  const j = await getJSON(`https://api.weather.gov/points/${place.lat.toFixed(4)},${place.lon.toFixed(4)}`, { headers: NWS_HDR });
  const p = j.properties;
  const out = {
    at: Date.now(), grid: p.forecastGridData, forecast: p.forecast, stations: p.observationStations,
    office: p.gridId, tz: p.timeZone,
    city: p.relativeLocation?.properties?.city, state: p.relativeLocation?.properties?.state,
  };
  store.set(key, out);
  return out;
}

async function fetchNwsGrid(pt) {
  const j = await getJSON(pt.grid, { headers: NWS_HDR, timeout: 25000 });
  const p = j.properties; const map = {};
  for (const [k, [name, mode]] of Object.entries(NWS_VARS)) {
    const prop = p[name]; const m = new Map();
    if (prop && prop.values) {
      for (const { validTime, value } of prop.values) {
        if (value == null) continue;
        const [start, dur] = validTime.split('/');
        const t0 = Math.floor(Date.parse(start) / 1000 / 3600) * 3600; const hrs = parseIsoDurHours(dur);
        const v = conv(prop.uom, value);
        for (let i = 0; i < hrs; i++) m.set(t0 + i * 3600, mode === 'sum' ? v / hrs : v);
      }
    }
    map[k] = m;
  }
  if (!map.temp.size) throw new Error('NWS grid empty');
  return { ok: true, series: map, updated: Date.parse(p.updateTime || p.validTimes?.split('/')[0] || '') || null };
}

async function fetchNwsText(pt) {
  const j = await getJSON(pt.forecast, { headers: NWS_HDR });
  return (j.properties?.periods || []).slice(0, 4).map(p => ({ name: p.name, text: p.detailedForecast, isDay: p.isDaytime }));
}

async function fetchObservation(pt, place) {
  const j = await getJSON(pt.stations, { headers: NWS_HDR });
  const st = (j.features || []).map(f => ({
    id: f.properties.stationIdentifier, name: f.properties.name,
    dist: haversineMi(place.lat, place.lon, f.geometry.coordinates[1], f.geometry.coordinates[0]),
  })).sort((a, b) => a.dist - b.dist).slice(0, 4);
  for (const s of st) {
    try {
      const o = await getJSON(`https://api.weather.gov/stations/${s.id}/observations/latest`, { headers: NWS_HDR });
      const p = o.properties; const ts = Date.parse(p.timestamp);
      if (p.temperature?.value == null || Date.now() - ts > 3 * 3600e3) continue;
      const g = k => conv(p[k]?.unitCode, p[k]?.value);
      return {
        station: s, time: ts, text: p.textDescription,
        temp: g('temperature'), dew: g('dewpoint'), rh: p.relativeHumidity?.value,
        wind: g('windSpeed'), gust: g('windGust'), wdir: p.windDirection?.value,
        pressure: g('barometricPressure') || g('seaLevelPressure'),
        vis: p.visibility?.value != null ? p.visibility.value / 1609.344 : null,
        feels: g('heatIndex') ?? g('windChill'),
      };
    } catch { /* try next station */ }
  }
  throw new Error('no recent station report');
}

async function fetchAlerts(place) {
  const j = await getJSON(`https://api.weather.gov/alerts/active?point=${place.lat.toFixed(4)},${place.lon.toFixed(4)}`, { headers: NWS_HDR });
  const rank = { Extreme: 0, Severe: 1, Moderate: 2, Minor: 3, Unknown: 4 };
  return (j.features || []).map(f => f.properties).map(p => ({
    id: p.id, event: p.event, severity: p.severity || 'Unknown', urgency: p.urgency, headline: p.headline,
    description: p.description, instruction: p.instruction, sender: p.senderName,
    onset: Date.parse(p.onset || p.effective), ends: Date.parse(p.ends || p.expires),
  })).sort((a, b) => (rank[a.severity] ?? 5) - (rank[b.severity] ?? 5));
}

/* ---------- Load everything for a place ---------- */
async function loadPlace(place, force = false) {
  const cached = state.data[place.id];
  if (!force && cached && Date.now() - cached.fetchedAt < CACHE_MS) return cached;
  const omJobs = SOURCES.filter(s => s.kind !== 'nws').map(s => fetchOpenMeteo(s, place).then(r => [s.id, r]));
  const ptJob = nwsPoint(place);
  const gridJob = ptJob.then(fetchNwsGrid);
  const textJob = ptJob.then(fetchNwsText);
  const obsJob = ptJob.then(pt => fetchObservation(pt, place));
  const alertJob = fetchAlerts(place);
  const [omRes, pt, grid, text, obs, alerts] = await Promise.allSettled([Promise.all(omJobs), ptJob, gridJob, textJob, obsJob, alertJob]);

  const sources = {};
  for (const [id, r] of (omRes.value || [])) sources[id] = r;
  sources.nws = grid.status === 'fulfilled' ? grid.value : { ok: false, error: grid.reason?.message || 'unavailable' };

  const firstOm = Object.values(sources).find(s => s.ok && s.utcOffset != null);
  const bundle = {
    fetchedAt: Date.now(), sources,
    utcOffset: firstOm ? firstOm.utcOffset : -5 * 3600,
    timezone: firstOm?.timezone, sun: firstOm?.sun || [],
    point: pt.status === 'fulfilled' ? pt.value : null,
    nwsText: text.status === 'fulfilled' ? text.value : null,
    obs: obs.status === 'fulfilled' ? obs.value : null,
    obsErr: obs.status === 'rejected' ? obs.reason?.message : null,
    alerts: alerts.status === 'fulfilled' ? alerts.value : null,
    alertErr: alerts.status === 'rejected' ? alerts.reason?.message : null,
  };
  bundle.placeId = place.id;
  buildGrid(bundle);
  state.data[place.id] = bundle;
  try { recordNwsSnapshot(place, bundle); } catch {}
  return bundle;
}

/* Align every source onto one hourly grid: yesterday 00:00 local -> +10 days */
function buildGrid(b) {
  const off = b.utcOffset; const nowH = Math.floor(Date.now() / 3600e3) * 3600;
  const todayKey = dateKey(nowH, off);
  const startOfToday = Date.parse(todayKey + 'T00:00:00Z') / 1000 - off;
  const start = startOfToday - 24 * 3600; const end = startOfToday + 11 * 24 * 3600;
  const times = []; for (let t = start; t < end; t += 3600) times.push(t);
  b.times = times; b.nowH = nowH; b.todayKey = todayKey; b.nowIdx = times.indexOf(nowH);
  b.cols = {};
  for (const s of SOURCES) {
    const src = b.sources[s.id]; if (!src || !src.ok) continue;
    const cols = {};
    for (const k of Object.keys(OM_VARS)) {
      const m = src.series[k]; cols[k] = m ? times.map(t => m.has(t) ? m.get(t) : null) : times.map(() => null);
    }
    b.cols[s.id] = cols;
  }
  b.dayKeys = [...new Set(times.map(t => dateKey(t, off)))].filter(k => k >= todayKey).slice(0, 10);
  b.daily = computeDaily(b);
}

const okIds = (b, onlyEnabled = true) => SOURCES.map(s => s.id).filter(id => b.cols[id] && (!onlyEnabled || state.enabled.has(id)));

/* Per-source daily summaries, only where a source covers most of the day */
function computeDaily(b) {
  const off = b.utcOffset; const out = {};
  for (const key of b.dayKeys) {
    const idx = []; b.times.forEach((t, i) => { if (dateKey(t, off) === key) idx.push(i); });
    const per = {};
    for (const id of Object.keys(b.cols)) {
      const c = b.cols[id];
      const have = idx.filter(i => c.temp[i] != null);
      if (!have.length) continue;
      const span = (b.times[have[have.length - 1]] - b.times[have[0]]) / 3600;
      if (span < 18) continue;
      const pick = k => idx.map(i => c[k][i]);
      const dayIdx = idx.filter(i => { const h = localDate(b.times[i], off).getUTCHours(); return h >= 8 && h <= 18; });
      per[id] = {
        hi: max(pick('temp')), lo: min(pick('temp')),
        feelsHi: max(pick('feels')), feelsLo: min(pick('feels')),
        precip: sum(pick('precip')) ?? null, snow: sum(pick('snow')),
        pop: max(pick('pop')), wind: max(pick('wind')), gust: max(pick('gust')),
        cloud: mean(pick('cloud')), cloudDay: mean(dayIdx.map(i => c.cloud[i])), dew: mean(pick('dew')),
        thunder: pick('code').some(v => v != null && v >= 95),
      };
    }
    out[key] = per;
  }
  return out;
}

function dayLead(b, key) { const n = Math.round((Date.parse(key + 'T12:00:00Z') - Date.parse(b.todayKey + 'T12:00:00Z')) / 864e5); return leadFor(Math.max(0, n) * 24); }

function dayConsensus(b, key) {
  const per = b.daily[key] || {}; const ids = Object.keys(per).filter(id => state.enabled.has(id));
  const g = k => ids.map(id => per[id][k]);
  const L = dayLead(b, key); const cmb = (k, kind) => combine(b.placeId, ids.map(id => [id, per[id][k]]), L, kind);
  const n = ids.length;
  if (!n) return null;
  const rainIds = ids.filter(id => per[id].precip != null);
  const wet = rainIds.filter(id => per[id].precip >= 0.05).length;
  const hiSpread = (max(g('hi')) ?? 0) - (min(g('hi')) ?? 0);
  const loSpread = (max(g('lo')) ?? 0) - (min(g('lo')) ?? 0);
  const tSpread = Math.max(hiSpread, loSpread);
  const wetFrac = rainIds.length ? wet / rainIds.length : 0;
  let tc = tSpread <= 4 ? 2 : tSpread <= 8 ? 1 : 0;
  let pc = (wetFrac > 0.25 && wetFrac < 0.75) ? 0 : (wetFrac > 0.15 && wetFrac < 0.85) ? 1 : 2;
  let conf = n < 3 ? null : Math.min(tc, pc);
  return {
    n, ids, hi: cmb('hi', 'temp'), lo: cmb('lo', 'temp'), hiMin: min(g('hi')), hiMax: max(g('hi')), loMin: min(g('lo')), loMax: max(g('lo')),
    precip: median(g('precip')), precipMax: max(g('precip')), snow: median(g('snow')),
    pop: mean(g('pop')), wet, rainN: rainIds.length, tSpread, conf, tc, pc,
    gust: median(g('gust')), cloudDay: mean(g('cloudDay')), thunder: ids.filter(id => per[id].thunder).length,
  };
}

function hourConsensus(b, i) {
  const ids = okIds(b).filter(id => b.cols[id].temp[i] != null);
  const g = k => ids.map(id => b.cols[id][k][i]);
  const L = leadFor(Math.max(0, (b.times[i] - b.nowH) / 3600));
  const cmb = (k, kind) => combine(b.placeId, ids.map(id => [id, b.cols[id][k][i]]), L, kind);
  return {
    n: ids.length, temp: cmb('temp', 'temp'), tMin: min(g('temp')), tMax: max(g('temp')),
    precip: median(g('precip')), pop: mean(g('pop')), snow: median(g('snow')), cloud: median(g('cloud')),
    wind: median(g('wind')), gust: median(g('gust')), feels: cmb('feels', 'temp'),
    thunder: g('code').filter(v => v != null && v >= 95).length / Math.max(1, nums(g('code')).length),
  };
}

/* ---------- Icons (derived from the consensus, not any one model) ---------- */
function isNight(b, t) {
  for (const [r, s] of b.sun) if (t >= r && t < s) return false;
  if (!b.sun.length) { const h = localDate(t, b.utcOffset).getUTCHours(); return h < 7 || h >= 18; }
  return true;
}
function hourIcon(b, i, c) {
  if (c.thunder >= 0.3 && (c.precip ?? 0) > 0) return '⛈️';
  if ((c.precip ?? 0) >= 0.01) return ((c.snow ?? 0) > 0 || (c.temp ?? 99) <= 32) ? '🌨️' : '🌧️';
  const night = isNight(b, b.times[i]); const cl = c.cloud ?? 0;
  if (cl < 25) return night ? '🌙' : '☀️';
  if (cl < 65) return night ? '☁️' : '⛅';
  return '☁️';
}
function dayIcon(c) {
  if (!c) return '';
  if (c.thunder >= Math.max(2, c.n * 0.3) && (c.precip ?? 0) >= 0.05) return '⛈️';
  if ((c.precip ?? 0) >= 0.05) return ((c.snow ?? 0) >= 0.2) ? '🌨️' : '🌧️';
  if ((c.precip ?? 0) >= 0.01 || c.wet >= Math.max(2, c.rainN * 0.3)) return '🌦️';
  const cl = c.cloudDay ?? 50; return cl < 25 ? '☀️' : cl < 65 ? '⛅' : '☁️';
}
function condText(c) {
  if (!c) return '';
  if (c.thunder >= 0.3 && (c.precip ?? 0) > 0) return 'Thunderstorms';
  if ((c.precip ?? 0) >= 0.01) return ((c.snow ?? 0) > 0 || (c.temp ?? 99) <= 32) ? 'Snow' : 'Rain';
  const cl = c.cloud ?? 0; return cl < 25 ? 'Clear' : cl < 65 ? 'Partly cloudy' : 'Cloudy';
}
const CONF = [{ k: 'L', t: 'Low' }, { k: 'M', t: 'Medium' }, { k: 'H', t: 'High' }];
function confBadge(conf) {
  if (conf == null) return '<span class="conf">— n/a</span>';
  const c = CONF[conf]; return `<span class="conf conf-${c.k}" title="Model agreement"><span class="dot"></span>${c.t}</span>`;
}

/* ---------- Rendering: Now ---------- */
function skeleton(n = 3) { return Array.from({ length: n }, () => '<div class="skeleton"></div>').join(''); }

function renderAlerts(b) {
  if (b.alertErr) return `<div class="card small err">Couldn't check NWS alerts (${esc(b.alertErr)}).</div>`;
  if (!b.alerts || !b.alerts.length) return '';
  return b.alerts.map(a => {
    const until = a.ends ? new Date(a.ends).toLocaleString([], { weekday: 'short', hour: 'numeric', minute: '2-digit' }) : '';
    return `<details class="alert">
      <summary><span class="sev-bar sev-${esc(a.severity)}"></span>
        <div><div class="alert-title">⚠️ ${esc(a.event)}<span class="sev-label sev-${esc(a.severity)}">${esc(a.severity)}</span></div>
        <div class="alert-meta">${until ? 'Until ' + esc(until) + ' · ' : ''}${esc(a.sender || '')} · tap for details</div></div>
      </summary>
      <div class="alert-body">${a.headline ? `<h4>${esc(a.headline)}</h4>` : ''}${esc(a.description || '')}${a.instruction ? `<h4>What to do</h4>${esc(a.instruction)}` : ''}</div>
    </details>`;
  }).join('');
}

function renderCurrent(b) {
  const i = b.nowIdx; const c = i >= 0 ? hourConsensus(b, i) : null; const o = b.obs;
  const temp = o?.temp ?? c?.temp; const feels = o ? (o.feels ?? o.temp) : c?.feels;
  const cond = o?.text || condText(c);
  const wind = o ? o.wind : c?.wind; const gust = o ? o.gust : c?.gust; const wdir = o ? o.wdir : null;
  const stats = [
    ['Wind', wind == null ? '—' : `${compass(wdir)} ${r0(wind)} mph`],
    ['Gusts', gust == null ? '—' : r0(gust) + ' mph'],
    ['Humidity', o?.rh == null ? '—' : r0(o.rh) + '%'],
    ['Dew point', o?.dew == null ? '—' : r0(o.dew) + '°'],
    ['Pressure', o?.pressure == null ? '—' : o.pressure.toFixed(2) + ' in'],
    ['Visibility', o?.vis == null ? '—' : (o.vis >= 10 ? '10+' : o.vis.toFixed(1)) + ' mi'],
  ];
  const src = o
    ? `Observed at ${esc(o.station.id)} · ${esc(o.station.name)} · ${o.station.dist.toFixed(1)} mi away · ${ago(o.time)}`
    : `No recent station report${b.obsErr ? ` (${esc(b.obsErr)})` : ''}; showing model consensus for this hour.`;
  return `<div class="card">
    <div class="current">
      <div class="big">${r0(temp)}°</div>
      <div><div class="cond">${esc(cond || '')}</div>
        <div class="feels">Feels like ${r0(feels)}° ${c && c.n >= 2 ? `· models ${r0(c.tMin)}–${r0(c.tMax)}° now` : ''}</div></div>
    </div>
    <div class="stats">${stats.map(([k, v]) => `<div class="stat"><div class="k">${k}</div><div class="v">${v}</div></div>`).join('')}</div>
    <div class="obs-src">${src}</div>
  </div>`;
}

function renderAgreement(b) {
  const days = b.dayKeys.map(k => ({ k, c: dayConsensus(b, k) })).filter(d => d.c && d.c.conf != null);
  if (!days.length) return '';
  const lines = [];
  const name = k => k === b.todayKey ? 'today' : dayLabel(k, b.todayKey) + ' ' + shortDate(k);
  // Rain outlook: next wet day by consensus
  const wetDays = days.filter(d => (d.c.precip ?? 0) >= 0.05);
  if (wetDays.length) {
    const d = wetDays[0];
    lines.push(`🌧️ Next notable rain: <b>${name(d.k)}</b> — ${d.c.wet} of ${d.c.rainN} sources show ≥0.05", consensus ${fmtIn(d.c.precip)}" (up to ${fmtIn(d.c.precipMax)}").`);
  } else {
    const anyWet = days.find(d => d.c.wet > 0);
    lines.push(anyWet ? `🌤️ Mostly dry next 10 days; ${anyWet.c.wet} of ${anyWet.c.rainN} sources hint at rain ${name(anyWet.k)}.` : '☀️ All sources agree: dry for the next 10 days.');
  }
  // Least certain day in the first 7
  const first7 = days.slice(0, 7);
  const worst = first7.slice().sort((a, b) => (a.c.conf - b.c.conf) || (b.c.tSpread - a.c.tSpread))[0];
  if (worst && worst.c.conf < 2) {
    const why = worst.c.tc <= worst.c.pc
      ? `highs range ${r0(worst.c.hiMin)}–${r0(worst.c.hiMax)}°F across sources`
      : `rain is a split call (${worst.c.wet} of ${worst.c.rainN} sources wet)`;
    lines.push(`⚖️ Least certain this week: <b>${name(worst.k)}</b> — ${why}.`);
  }
  const solid = []; for (const d of first7) { if (d.c.conf === 2) solid.push(d); else break; }
  if (solid.length >= 2) lines.push(`✅ Strong agreement through <b>${name(solid[solid.length - 1].k)}</b> (temps within ${r0(max(solid.map(d => d.c.tSpread)))}°).`);
  return `<div class="card agree"><h2>Forecast confidence</h2>${lines.map(l => `<p>${l}</p>`).join('')}</div>`;
}

function renderHourly(b) {
  if (b.nowIdx < 0) return '';
  const cells = [];
  for (let i = b.nowIdx; i < Math.min(b.times.length, b.nowIdx + 25); i++) {
    const c = hourConsensus(b, i); if (!c.n) continue;
    const spread = c.n >= 2 ? Math.round((c.tMax - c.tMin) / 2) : null;
    cells.push(`<div class="hr ${i === b.nowIdx ? 'now' : ''}">
      <div class="t">${i === b.nowIdx ? 'Now' : hourLabel(b.times[i], b.utcOffset)}</div>
      <div class="i">${hourIcon(b, i, c)}</div>
      <div class="v">${r0(c.temp)}°</div>
      <div class="s">${spread != null ? '±' + spread + '°' : ''}</div>
      <div class="p">${c.pop != null && c.pop >= 10 ? Math.round(c.pop / 5) * 5 + '%' : (c.precip ?? 0) >= 0.01 ? fmtIn(c.precip) + '"' : ''}</div>
    </div>`);
  }
  return `<div class="card"><h2>Next 24 hours <span class="h2-note">· ${consensusName(b.placeId).toLowerCase()}, ± = model spread</span></h2><div class="hours">${cells.join('')}</div></div>`;
}

function renderDaily(b) {
  const rows = b.dayKeys.map(k => ({ k, c: dayConsensus(b, k) })).filter(d => d.c);
  if (!rows.length) return '';
  const lo = min(rows.map(d => d.c.loMin)), hi = max(rows.map(d => d.c.hiMax)); const span = Math.max(1, hi - lo);
  const pct = v => ((v - lo) / span * 100).toFixed(1) + '%';
  const html = rows.map(({ k, c }) => {
    const open = state.openDay === k;
    const pr = (c.precip ?? 0) >= 0.01 ? fmtIn(c.precip) + '"' : c.pop != null && c.pop >= 15 ? Math.round(c.pop / 5) * 5 + '%' : '';
    const detail = open ? `<div class="day-detail">
        Highs ${r0(c.hiMin)}–${r0(c.hiMax)}°, lows ${r0(c.loMin)}–${r0(c.loMax)}° across ${c.n} sources.
        Rain: ${c.wet} of ${c.rainN} sources ≥0.05" (consensus ${fmtIn(c.precip)}", max ${fmtIn(c.precipMax)}")${c.pop != null ? `, avg chance ${r0(c.pop)}%` : ''}.
        ${c.gust != null ? `Peak gusts ~${r0(c.gust)} mph.` : ''} ${c.snow >= 0.1 ? `Snow ~${fmtIn(c.snow, 1)}".` : ''}
        Agreement: ${confBadge(c.conf)}
      </div>` : '';
    return `<div class="day" data-day="${k}">
      <div><div class="dn">${dayLabel(k, b.todayKey)}</div><div class="dd">${shortDate(k)}</div></div>
      <div class="di">${dayIcon(c)}</div>
      <div class="dp">${pr}</div>
      <div class="dr"><span class="lo">${r0(c.lo)}°</span>
        <div class="rangebar" title="Bar: consensus low–high. Shaded: full model range.">
          <div class="spread" style="left:${pct(c.loMin)};right:calc(100% - ${pct(c.hiMax)})"></div>
          <div class="cons" style="left:${pct(c.lo)};right:calc(100% - ${pct(c.hi)})"></div>
        </div><span class="hi">${r0(c.hi)}°</span></div>
      ${detail}
    </div>`;
  }).join('');
  return `<div class="card"><h2>10 days <span class="h2-note">· tap a day · grey = model range</span></h2><div class="days">${html}</div></div>`;
}

function renderNwsText(b) {
  if (!b.nwsText || !b.nwsText.length) return '';
  return `<div class="card"><h2>NWS forecaster says</h2>${b.nwsText.slice(0, 3).map(p => `<div class="nws-period"><b>${esc(p.name)}</b><span>${esc(p.text)}</span></div>`).join('')}</div>`;
}

function renderSourceStatus(b) {
  const parts = SOURCES.map(s => {
    const r = b.sources[s.id];
    return `<span><span class="sw-inline" style="background:${s.color}"></span>${s.name} ${r && r.ok ? '✓' : '✕'}</span>`;
  }).join('');
  return `<div class="foot">
    <div class="src-status">${parts}</div>
    <div style="margin-top:8px">Updated ${ago(b.fetchedAt)}. Forecast data: <a href="https://open-meteo.com/" target="_blank" rel="noopener">Open-Meteo</a> (CC BY 4.0) and NOAA / National Weather Service. Not an official warning source — for life-safety decisions rely on NWS warnings and local officials.</div>
  </div>`;
}

function renderNow() {
  const el = $('#view-now'); const place = activePlace();
  if (!place) { el.innerHTML = `<div class="card empty">No place yet.<br><br><a href="#places" class="btn primary">Add a place</a></div>`; return; }
  const b = state.data[place.id];
  if (!b) { el.innerHTML = skeleton(4); return; }
  el.innerHTML = renderAlerts(b) + renderCurrent(b) + renderAgreement(b) + renderHourly(b) + renderDaily(b) + renderNwsText(b) + renderSourceStatus(b);
  el.querySelectorAll('.day').forEach(d => d.addEventListener('click', () => { state.openDay = state.openDay === d.dataset.day ? null : d.dataset.day; renderNow(); }));
}

/* ---------- Rendering: Compare ---------- */
let chart = null;

function seriesFor(b, id, plot, i0, i1) {
  const col = b.cols[id]?.[plot.key]; if (!col) return null;
  const out = []; let acc = 0, seen = false;
  for (let i = i0; i < i1; i++) {
    let v = col[i];
    if (plot.cumulative) {
      // only accumulate while the source still has data (temp present marks coverage)
      if (b.cols[id].temp[i] == null) { out.push(null); continue; }
      acc += v ?? 0; seen = true; v = acc;
    }
    out.push(v);
  }
  return nums(out).length ? out : null;
}

function renderCompare() {
  const el = $('#view-compare'); const place = activePlace();
  if (!place) { el.innerHTML = `<div class="card empty">Add a place first.</div>`; return; }
  const b = state.data[place.id];
  if (!b) { el.innerHTML = skeleton(2); return; }
  const plot = PLOTS[state.plot];
  const i0 = Math.max(0, b.nowIdx); const i1 = Math.min(b.times.length, i0 + RANGES[state.range] + 1);

  const legend = SOURCES.map(s => {
    const has = !!b.cols[s.id]; const on = has && state.enabled.has(s.id);
    return `<button class="src ${on ? '' : 'off'}" data-src="${s.id}" ${has ? '' : 'disabled'} title="${esc(s.full)}">
      <span class="sw" style="background:${s.color}"></span>${s.name}${has ? '' : ' <span class="note">n/a</span>'}</button>`;
  }).join('') + `<span class="src" style="cursor:default"><span class="sw cons"></span>${(plot.key === 'temp' || plot.key === 'feels') ? consensusName(b.placeId) : 'Consensus'}</span>`;

  el.innerHTML = `
    <div class="chips chip-row">${Object.entries(PLOTS).map(([k, p]) => `<button class="chip ${k === state.plot ? 'on' : ''}" data-plot="${k}">${p.label}</button>`).join('')}</div>
    <div class="card">
      <div class="row"><h2 style="margin:0">${plot.label} <span class="h2-note">(${plot.unit})</span></h2><span class="spacer"></span>
        <div class="seg">${Object.keys(RANGES).map(r => `<button data-range="${r}" class="${r === state.range ? 'on' : ''}">${r}</button>`).join('')}</div></div>
      <div class="chart-box"><canvas id="cmpChart" aria-label="${esc(plot.label)} by forecast source" role="img"></canvas></div>
      <div class="legend">${legend}</div>
      <p class="chart-insight" id="cmpInsight"></p>
    </div>
    <div class="card"><h2>Daily by source <span class="h2-note">· ${plot.daily === 'hilo' ? 'high / low' : plot.daily === 'sum' ? 'daily total' : plot.daily === 'max' ? 'daily max' : 'daily mean'}</span></h2>
      <div class="table-wrap">${dailyTable(b, plot)}</div>
      <div class="foot" style="padding:8px 0 0">Underline marks the single highest (orange) and lowest (blue) source each day. Toggle sources above to drop them from the consensus.</div>
    </div>
    ${renderSourceStatus(b)}`;

  el.querySelectorAll('[data-plot]').forEach(x => x.addEventListener('click', () => { state.plot = x.dataset.plot; store.set('plot', state.plot); renderCompare(); }));
  el.querySelectorAll('[data-range]').forEach(x => x.addEventListener('click', () => { state.range = x.dataset.range; store.set('range', state.range); renderCompare(); }));
  el.querySelectorAll('[data-src]').forEach(x => x.addEventListener('click', () => {
    const id = x.dataset.src;
    if (state.enabled.has(id)) { if (state.enabled.size <= 1) return toast('Keep at least one source'); state.enabled.delete(id); } else state.enabled.add(id);
    store.set('enabled', [...state.enabled]); renderCompare();
  }));

  drawChart(b, plot, i0, i1);
}

function drawChart(b, plot, i0, i1) {
  const css = getComputedStyle(document.documentElement);
  const ink = css.getPropertyValue('--ink').trim(), muted = css.getPropertyValue('--muted').trim(), grid = css.getPropertyValue('--grid').trim();
  const xs = b.times.slice(i0, i1).map(t => t * 1000);
  const ids = okIds(b);
  const series = {}; for (const id of ids) { const s = seriesFor(b, id, plot, i0, i1); if (s) series[id] = s; }
  const lo = [], hi = [], md = [];
  const tempLike = plot.key === 'temp' || plot.key === 'feels';
  xs.forEach((x, j) => {
    const vals = Object.values(series).map(s => s[j]); const n = nums(vals);
    lo.push(n.length >= 2 ? Math.min(...n) : null); hi.push(n.length >= 2 ? Math.max(...n) : null);
    const L = leadFor(Math.max(0, (x / 1000 - b.nowH) / 3600));
    md.push(!n.length ? null : tempLike ? combine(b.placeId, Object.entries(series).map(([id, s]) => [id, s[j]]), L, 'temp') : median(n));
  });
  const pts = arr => xs.map((x, j) => ({ x, y: arr[j] }));

  const datasets = [
    { label: 'range-lo', data: pts(lo), borderWidth: 0, pointRadius: 0, fill: false, _band: true, spanGaps: true },
    { label: 'Model range', data: pts(hi), borderWidth: 0, pointRadius: 0, fill: '-1', backgroundColor: 'rgba(195,194,183,0.14)', _band: true, spanGaps: true },
    ...Object.entries(series).map(([id, s]) => ({
      label: SRC[id].name, data: pts(s), borderColor: SRC[id].color, backgroundColor: SRC[id].color,
      borderWidth: 2, pointRadius: 0, pointHoverRadius: 4, tension: 0.25, spanGaps: true, _src: id,
    })),
    { label: tempLike ? consensusName(b.placeId) : 'Consensus', data: pts(md), borderColor: ink, backgroundColor: ink, borderWidth: 3, borderDash: [6, 4], pointRadius: 0, pointHoverRadius: 4, tension: 0.25, spanGaps: true },
  ];

  // Ticks at local midnight (and noon on short ranges)
  const off = b.utcOffset; const ticks = []; const step = RANGES[state.range] <= 48 ? 6 : 24;
  for (const t of b.times.slice(i0, i1)) { const h = localDate(t, off).getUTCHours(); if (h % step === 0) ticks.push(t * 1000); }

  const crosshair = {
    id: 'crosshair',
    afterDatasetsDraw(c) {
      const { ctx, chartArea: a } = c;
      const nowX = c.scales.x.getPixelForValue(Date.now());
      if (nowX >= a.left && nowX <= a.right) { ctx.save(); ctx.strokeStyle = muted; ctx.setLineDash([2, 3]); ctx.beginPath(); ctx.moveTo(nowX, a.top); ctx.lineTo(nowX, a.bottom); ctx.stroke(); ctx.restore(); }
      const act = c.tooltip?.getActiveElements?.() || [];
      if (act.length) { const x = act[0].element.x; ctx.save(); ctx.strokeStyle = ink; ctx.globalAlpha = 0.5; ctx.beginPath(); ctx.moveTo(x, a.top); ctx.lineTo(x, a.bottom); ctx.stroke(); ctx.restore(); }
    },
  };

  if (chart) { chart.destroy(); chart = null; }
  const dec = plot.dec ?? 0;
  chart = new Chart($('#cmpChart'), {
    type: 'line',
    data: { datasets },
    plugins: [crosshair],
    options: {
      animation: false, responsive: true, maintainAspectRatio: false, parsing: false, normalized: true,
      interaction: { mode: 'index', intersect: false },
      layout: { padding: { top: 4, right: 4 } },
      plugins: {
        legend: { display: false },
        tooltip: {
          backgroundColor: 'rgba(35,35,33,0.96)', borderColor: 'rgba(255,255,255,0.12)', borderWidth: 1,
          titleColor: ink, bodyColor: ink, padding: 10, boxWidth: 10, boxHeight: 10, usePointStyle: false,
          filter: it => !it.dataset._band && it.raw.y != null,
          itemSort: (a, b2) => (b2.raw.y ?? -1e9) - (a.raw.y ?? -1e9),
          callbacks: {
            title: items => { if (!items.length) return ''; const t = items[0].raw.x / 1000; const d = localDate(t, off); return `${DOW[d.getUTCDay()]} ${shortDate(dateKey(t, off))} ${hourLabel(t, off)}`; },
            label: it => ` ${it.dataset.label}: ${it.raw.y.toFixed(dec)}${plot.unit === '%' ? '%' : plot.unit.startsWith('°') ? '°' : ' ' + plot.unit}`,
            labelColor: it => ({ borderColor: it.dataset.borderColor, backgroundColor: it.dataset.borderColor }),
          },
        },
      },
      scales: {
        x: {
          type: 'linear', min: xs[0], max: xs[xs.length - 1],
          afterBuildTicks: ax => { ax.ticks = ticks.map(v => ({ value: v })); },
          ticks: {
            color: muted, maxRotation: 0, autoSkip: false,
            callback: v => { const t = v / 1000; const h = localDate(t, off).getUTCHours(); return h === 0 ? dayLabel(dateKey(t, off), b.todayKey) : hourLabel(t, off); },
          },
          grid: { color: c => { const t = c.tick?.value / 1000; return t && localDate(t, off).getUTCHours() === 0 ? '#383835' : grid; } },
          border: { color: '#383835' },
        },
        y: {
          min: plot.min, max: plot.max, beginAtZero: plot.cumulative || plot.min === 0,
          ticks: { color: muted, maxTicksLimit: 6, callback: v => plot.cumulative ? (+v).toFixed(plot.dec ?? 1) : Math.round(v) },
          grid: { color: grid }, border: { display: false },
        },
      },
    },
  });

  // One-line insight: where do sources disagree most?
  let worstJ = -1, worstW = -1; hi.forEach((h, j) => { if (h != null && lo[j] != null && h - lo[j] > worstW) { worstW = h - lo[j]; worstJ = j; } });
  const ins = $('#cmpInsight');
  if (ins && worstJ >= 0) {
    const t = xs[worstJ] / 1000; const d = localDate(t, off);
    const when = `${DOW[d.getUTCDay()]} ${hourLabel(t, off)}`;
    const vals = Object.entries(series).map(([id, s]) => [id, s[worstJ]]).filter(x => x[1] != null).sort((a, c) => c[1] - a[1]);
    const u = plot.unit === '%' ? '%' : plot.unit.startsWith('°') ? '°' : ' ' + plot.unit;
    if (vals.length >= 2) ins.innerHTML = `Biggest disagreement: <b>${when}</b>, spread of ${worstW.toFixed(plot.dec ?? 0)}${u} — ${SRC[vals[0][0]].name} highest (${vals[0][1].toFixed(plot.dec ?? 0)}${u}), ${SRC[vals[vals.length - 1][0]].name} lowest (${vals[vals.length - 1][1].toFixed(plot.dec ?? 0)}${u}).`;
  }
}

function dailyTable(b, plot) {
  const keys = b.dayKeys; const ids = okIds(b, false);
  const val = (per, id) => {
    const d = per[id]; if (!d) return null;
    switch (plot.key) {
      case 'temp': return [d.hi, d.lo];
      case 'feels': return [d.feelsHi, d.feelsLo];
      case 'precip': return d.precip;
      case 'snow': return d.snow;
      case 'pop': return d.pop;
      case 'wind': return d.wind;
      case 'gust': return d.gust;
      case 'cloud': return d.cloud;
      case 'dew': return d.dew;
    }
  };
  const fmt = v => v == null ? '<span class="muted">—</span>' : Array.isArray(v) ? `${r0(v[0])}° <span class="lo">${r0(v[1])}°</span>` : plot.cumulative ? fmtIn(v, plot.dec ?? 2) : r0(v) + (plot.unit === '%' ? '%' : '');
  const head = `<tr><th>Source</th>${keys.map(k => `<th>${dayLabel(k, b.todayKey)}<br><span style="font-weight:400">${shortDate(k)}</span></th>`).join('')}</tr>`;
  const extremes = {};
  for (const k of keys) {
    const per = b.daily[k] || {}; const list = ids.filter(id => state.enabled.has(id)).map(id => [id, val(per, id)]).filter(x => x[1] != null).map(([id, v]) => [id, Array.isArray(v) ? v[0] : v]);
    if (list.length >= 3) {
      list.sort((a, c) => c[1] - a[1]); const L = list.length; const e = {};
      const same = (x, y) => Math.abs(x - y) < (plot.cumulative ? 0.005 : 0.5);
      if (!same(list[0][1], list[1][1])) e.hi = list[0][0];           // only mark a unique outlier
      if (!same(list[L - 1][1], list[L - 2][1])) e.lo = list[L - 1][0];
      extremes[k] = e;
    }
  }
  const rows = ids.map(id => {
    const off = !state.enabled.has(id);
    return `<tr style="${off ? 'opacity:.4' : ''}"><td><span class="sw-inline" style="background:${SRC[id].color}"></span>${SRC[id].name}</td>${keys.map(k => {
      const e = extremes[k]; const cls = !off && e ? (e.hi === id ? 'hi-out' : e.lo === id ? 'lo-out' : '') : '';
      return `<td class="${cls}">${fmt(val(b.daily[k] || {}, id))}</td>`;
    }).join('')}</tr>`;
  }).join('');
  const tempLike = plot.daily === 'hilo';
  const consRow = `<tr class="cons"><td>${tempLike ? consensusName(b.placeId) : 'Consensus'}</td>${keys.map(k => {
    const per = b.daily[k] || {}; const live = ids.filter(id => state.enabled.has(id)).map(id => [id, val(per, id)]).filter(x => x[1] != null);
    if (!live.length) return '<td>—</td>';
    const L = dayLead(b, k);
    return `<td>${fmt(tempLike ? [combine(b.placeId, live.map(([id, v]) => [id, v[0]]), L, 'temp'), combine(b.placeId, live.map(([id, v]) => [id, v[1]]), L, 'temp')] : median(live.map(x => x[1])))}</td>`;
  }).join('')}</tr>`;
  return `<table class="grid">${head}${rows}${consRow}</table>`;
}

/* ---------- Rendering: Places ---------- */
let searchTimer = null;
function renderPlaces() {
  const el = $('#view-places');
  el.innerHTML = `
    <div class="card">
      <h2>Add a place</h2>
      <div class="search"><input id="q" type="search" placeholder="City or ZIP (US)" autocomplete="off" enterkeyhint="search">
        <button class="btn" id="gps" title="Use my location">📍</button></div>
      <div class="list" id="results" style="margin-top:6px"></div>
    </div>
    <div class="card"><h2>Saved places</h2><div class="list" id="saved"></div></div>
    <div class="foot">Places are saved on this device only. US locations only. NWS alerts and station data cover all states; HRRR and NBM cover the lower 48.</div>`;
  renderSaved();
  const q = $('#q');
  q.addEventListener('input', () => { clearTimeout(searchTimer); searchTimer = setTimeout(() => doSearch(q.value.trim()), 350); });
  $('#gps').addEventListener('click', useGps);
}
function renderSaved() {
  const el = $('#saved'); if (!el) return;
  if (!state.places.length) { el.innerHTML = '<div class="muted small">None yet — search above or use 📍.</div>'; return; }
  el.innerHTML = state.places.map(p => `<div class="list-item" data-id="${esc(p.id)}">
    <span class="check">${p.id === state.activeId ? '✓' : ''}</span>
    <div class="li-main"><div class="li-title">${esc(p.name)}</div><div class="li-sub">${esc(p.sub || '')} · ${p.lat.toFixed(3)}, ${p.lon.toFixed(3)}</div></div>
    <button class="del" data-del="${esc(p.id)}" aria-label="Remove ${esc(p.name)}">×</button></div>`).join('');
  el.querySelectorAll('.list-item').forEach(li => li.addEventListener('click', e => {
    if (e.target.closest('[data-del]')) return;
    setActive(li.dataset.id); location.hash = '#now';
  }));
  el.querySelectorAll('[data-del]').forEach(btn => btn.addEventListener('click', e => {
    e.stopPropagation(); const id = btn.dataset.del;
    state.places = state.places.filter(p => p.id !== id); store.set('places', state.places);
    if (state.activeId === id) setActive(state.places[0]?.id || null, false);
    renderSaved();
  }));
}
async function doSearch(q) {
  const box = $('#results'); if (!box) return;
  if (q.length < 2) { box.innerHTML = ''; return; }
  box.innerHTML = '<div class="muted small" style="padding:8px 2px">Searching…</div>';
  try {
    const u = new URL('https://geocoding-api.open-meteo.com/v1/search');
    u.search = new URLSearchParams({ name: q, count: '10', language: 'en', format: 'json', countryCode: 'US' }).toString();
    const j = await getJSON(u);
    const res = (j.results || []).filter(r => r.country_code === 'US' || !r.country_code);
    if (!res.length) { box.innerHTML = '<div class="muted small" style="padding:8px 2px">No US matches.</div>'; return; }
    box.innerHTML = res.map((r, i) => `<div class="list-item" data-i="${i}"><span class="check">+</span><div class="li-main"><div class="li-title">${esc(r.name)}</div><div class="li-sub">${esc([r.admin2, r.admin1].filter(Boolean).join(', '))}</div></div></div>`).join('');
    box.querySelectorAll('[data-i]').forEach(li => li.addEventListener('click', () => {
      const r = res[+li.dataset.i];
      addPlace({ id: 'g' + r.id, name: r.name, sub: [r.admin2, r.admin1].filter(Boolean).join(', '), lat: r.latitude, lon: r.longitude });
    }));
  } catch (e) { box.innerHTML = `<div class="err" style="padding:8px 2px">Search failed: ${esc(e.message)}</div>`; }
}
function useGps() {
  if (!navigator.geolocation) return toast('Location not available in this browser');
  toast('Finding you…');
  navigator.geolocation.getCurrentPosition(async pos => {
    const lat = +pos.coords.latitude.toFixed(4), lon = +pos.coords.longitude.toFixed(4);
    let name = 'My location', sub = '';
    try { const pt = await nwsPoint({ lat, lon }); if (pt.city) { name = pt.city; sub = pt.state + ' · near you'; } } catch { sub = 'Outside NWS coverage?'; }
    addPlace({ id: `gps-${lat},${lon}`, name, sub, lat, lon });
  }, err => toast('Location error: ' + err.message), { enableHighAccuracy: false, timeout: 15000, maximumAge: 300000 });
}
function addPlace(p) {
  if (!state.places.find(x => x.id === p.id)) { state.places.push(p); store.set('places', state.places); }
  setActive(p.id); location.hash = '#now'; toast('Added ' + p.name);
}

/* ---------- App shell ---------- */
function setActive(id, load = true) {
  state.activeId = id; store.set('active', id); state.openDay = null;
  updateHeader(); if (load && id) refresh(false); else renderAll();
}
function updateHeader() {
  const p = activePlace();
  $('#placeName').textContent = p ? p.name : 'Add a place';
  const b = p && state.data[p.id];
  $('#placeSub').textContent = p ? [p.sub, b ? 'updated ' + ago(b.fetchedAt) : (state.loading ? 'loading…' : '')].filter(Boolean).join(' · ') : '';
}
const TABS = ['now', 'compare', 'skill', 'places'];
function currentTab() { const h = location.hash.replace('#', ''); return TABS.includes(h) ? h : 'now'; }
function renderAll() {
  const tab = currentTab();
  for (const t of TABS) $('#view-' + t).hidden = t !== tab;
  document.querySelectorAll('.tab').forEach(a => a.classList.toggle('active', a.dataset.tab === tab));
  if (tab !== 'compare' && chart) { chart.destroy(); chart = null; }
  if (tab !== 'skill' && skillChart) { skillChart.destroy(); skillChart = null; }
  if (tab === 'now') renderNow(); else if (tab === 'compare') renderCompare(); else if (tab === 'skill') renderSkill(); else renderPlaces();
  updateHeader();
}
async function refresh(force) {
  const p = activePlace(); if (!p) return renderAll();
  state.loading = true; $('#refreshBtn').classList.add('spin'); renderAll();
  try {
    const b = await loadPlace(p, force);
    const okN = Object.values(b.sources).filter(s => s.ok).length;
    if (!okN) toast('Could not reach forecast sources — check your connection');
    else ensureSkill(p, b);   // grades sources in the background (cached ~6 h)
  } catch (e) { toast('Load failed: ' + e.message); }
  finally { state.loading = false; $('#refreshBtn').classList.remove('spin'); if (activePlace()?.id === p.id) renderAll(); }
}
let toastTimer = null;
function toast(msg) { const t = $('#toast'); t.textContent = msg; t.classList.add('show'); clearTimeout(toastTimer); toastTimer = setTimeout(() => t.classList.remove('show'), 2600); }

window.addEventListener('hashchange', renderAll);
$('#placeBtn').addEventListener('click', () => { location.hash = '#places'; });
$('#refreshBtn').addEventListener('click', () => refresh(true));
document.addEventListener('visibilitychange', () => { if (!document.hidden) { const p = activePlace(); const b = p && state.data[p.id]; if (b && Date.now() - b.fetchedAt > CACHE_MS) refresh(false); } });
setInterval(updateHeader, 60000);

if ('serviceWorker' in navigator && location.protocol === 'https:') navigator.serviceWorker.register('sw.js').catch(() => {});

renderAll();
refresh(false);
