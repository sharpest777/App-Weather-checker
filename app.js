'use strict';

// ---------- Nastavení ----------

const CITIES = {
  praha: { name: 'Praha', lat: 50.0755, lon: 14.4378 },
  brno: { name: 'Brno', lat: 49.1951, lon: 16.6068 },
  ostrava: { name: 'Ostrava', lat: 49.8209, lon: 18.2625 },
};
const STORAGE_KEY = 'weather.location';
const DAYS = 7;
const CHART_HOURS = 48;

// ---------- Pomocné funkce ----------

const $ = (sel) => document.querySelector(sel);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const round = (n) => (n == null || Number.isNaN(n) ? null : Math.round(n));
const fmtTemp = (n) => (n == null ? '–' : `${round(n)}°`);
const fmtRain = (n) => (n == null ? '–' : `${n < 10 ? n.toFixed(1).replace('.', ',') : Math.round(n)} mm`);

function storageGet() {
  try { return JSON.parse(localStorage.getItem(STORAGE_KEY)); } catch { return null; }
}
function storageSet(value) {
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(value)); } catch { /* bez úložiště to funguje taky */ }
}

// Klíč hodiny "RRRR-MM-DDTHH" v časovém pásmu místa – podle něj se párují data ze všech zdrojů
function hourKey(date, tz) {
  const p = Object.fromEntries(
    new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', hourCycle: 'h23' })
      .formatToParts(date).map((x) => [x.type, x.value]),
  );
  return `${p.year}-${p.month}-${p.day}T${p.hour}`;
}
const dayOf = (key) => key.slice(0, 10);

function dayLabel(dateStr, index) {
  if (index === 0) return 'Dnes';
  if (index === 1) return 'Zítra';
  const d = new Date(`${dateStr}T12:00:00`);
  const s = d.toLocaleDateString('cs-CZ', { weekday: 'long', day: 'numeric', month: 'numeric' });
  return s.charAt(0).toUpperCase() + s.slice(1);
}

// ---------- Symboly počasí ----------

function yrSymbol(code) {
  if (!code) return { emoji: '', text: '' };
  const night = code.endsWith('_night');
  const base = code.replace(/_(day|night|polartwilight)$/, '');
  if (base.includes('thunder')) return { emoji: '⛈️', text: 'bouřky' };
  if (base.includes('snow')) return { emoji: '🌨️', text: 'sněžení' };
  if (base.includes('sleet')) return { emoji: '🌨️', text: 'déšť se sněhem' };
  if (base.includes('rainshowers')) return { emoji: '🌦️', text: 'přeháňky' };
  if (base.includes('rain')) return { emoji: '🌧️', text: base.startsWith('heavy') ? 'silný déšť' : base.startsWith('light') ? 'slabý déšť' : 'déšť' };
  return {
    clearsky: { emoji: night ? '🌙' : '☀️', text: 'jasno' },
    fair: { emoji: night ? '🌙' : '🌤️', text: 'skoro jasno' },
    partlycloudy: { emoji: '⛅', text: 'polojasno' },
    cloudy: { emoji: '☁️', text: 'zataženo' },
    fog: { emoji: '🌫️', text: 'mlha' },
  }[base] || { emoji: '🌡️', text: base };
}

function wmoSymbol(code) {
  if (code == null) return { emoji: '', text: '' };
  if (code === 0) return { emoji: '☀️', text: 'jasno' };
  if (code === 1) return { emoji: '🌤️', text: 'skoro jasno' };
  if (code === 2) return { emoji: '⛅', text: 'polojasno' };
  if (code === 3) return { emoji: '☁️', text: 'zataženo' };
  if (code <= 48) return { emoji: '🌫️', text: 'mlha' };
  if (code <= 57) return { emoji: '🌦️', text: 'mrholení' };
  if (code <= 67) return { emoji: '🌧️', text: 'déšť' };
  if (code <= 77) return { emoji: '🌨️', text: 'sněžení' };
  if (code <= 82) return { emoji: '🌦️', text: 'přeháňky' };
  if (code <= 86) return { emoji: '🌨️', text: 'sněhové přeháňky' };
  return { emoji: '⛈️', text: 'bouřky' };
}

// ---------- Zdroje dat ----------

async function getJson(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

// yr.no (MET Norway) – hodinová předpověď na cca 9 dní
async function loadYr(loc) {
  const url = `https://api.met.no/weatherapi/locationforecast/2.0/compact?lat=${loc.lat.toFixed(4)}&lon=${loc.lon.toFixed(4)}`;
  const data = await getJson(url);
  return data.properties.timeseries.map((t) => ({
    time: new Date(t.time),
    temp: t.data.instant.details.air_temperature,
    wind: t.data.instant.details.wind_speed,
    rain1: t.data.next_1_hours?.details?.precipitation_amount,
    rain6: t.data.next_6_hours?.details?.precipitation_amount,
    symbol: t.data.next_1_hours?.summary?.symbol_code || t.data.next_6_hours?.summary?.symbol_code,
  }));
}

// ICON (DWD) a ECMWF přes Open-Meteo
const OM_MODELS = { icon: 'icon_seamless', ecmwf: 'ecmwf_ifs025' };
async function loadOpenMeteo(loc) {
  const params = new URLSearchParams({
    latitude: loc.lat, longitude: loc.lon,
    hourly: 'temperature_2m,precipitation,wind_speed_10m,weather_code',
    daily: 'temperature_2m_max,temperature_2m_min,precipitation_sum,weather_code',
    models: Object.values(OM_MODELS).join(','),
    timezone: 'auto', forecast_days: String(DAYS), wind_speed_unit: 'ms',
  });
  return getJson(`https://api.open-meteo.com/v1/forecast?${params}`);
}

// Textová předpověď ČHMÚ – stahuje ji GitHub Action do data/chmi.json
let chmiCache = null;
async function loadChmi() {
  if (!chmiCache) chmiCache = getJson(`data/chmi.json?t=${Date.now()}`).catch((e) => { chmiCache = null; throw e; });
  return chmiCache;
}

// ---------- Převod dat do společné podoby ----------

// Vrátí { hourly: Map(klíč hodiny -> {temp, rain, wind, symbol}), daily: Map(datum -> {max, min, rain, symbol}) }
function normalizeYr(series, tz) {
  const hourly = new Map();
  const daily = new Map();
  let coveredUntil = 0;
  for (const s of series) {
    const key = hourKey(s.time, tz);
    hourly.set(key, { temp: s.temp, rain: s.rain1 ?? null, wind: s.wind, symbol: yrSymbol(s.symbol) });

    const day = dayOf(key);
    const d = daily.get(day) || { max: -Infinity, min: Infinity, rain: 0, symbols: [] };
    d.max = Math.max(d.max, s.temp);
    d.min = Math.min(d.min, s.temp);
    // Srážky: do ~60 h jsou hodinové, dál po 6 hodinách – nesčítat je dvakrát
    const t = s.time.getTime();
    if (t >= coveredUntil) {
      if (s.rain1 != null) { d.rain += s.rain1; coveredUntil = t + 3600e3; }
      else if (s.rain6 != null) { d.rain += s.rain6; coveredUntil = t + 6 * 3600e3; }
    }
    const h = Number(key.slice(11));
    if (s.symbol && h >= 9 && h <= 18) d.symbols.push(s.symbol);
    daily.set(day, d);
  }
  for (const d of daily.values()) {
    // Symbol dne: nejčastější přes den
    const counts = {};
    for (const sym of d.symbols) counts[sym] = (counts[sym] || 0) + 1;
    const top = Object.entries(counts).sort((a, b) => b[1] - a[1])[0];
    d.symbol = yrSymbol(top?.[0]);
  }
  return { hourly, daily };
}

function normalizeOpenMeteo(om, model) {
  const hourly = new Map();
  const daily = new Map();
  const h = om.hourly;
  h.time.forEach((time, i) => {
    hourly.set(time.slice(0, 13), {
      temp: h[`temperature_2m_${model}`][i],
      rain: h[`precipitation_${model}`][i],
      wind: h[`wind_speed_10m_${model}`][i],
      symbol: wmoSymbol(h[`weather_code_${model}`][i]),
    });
  });
  const d = om.daily;
  d.time.forEach((day, i) => {
    daily.set(day, {
      max: d[`temperature_2m_max_${model}`][i],
      min: d[`temperature_2m_min_${model}`][i],
      rain: d[`precipitation_sum_${model}`][i],
      symbol: wmoSymbol(d[`weather_code_${model}`][i]),
    });
  });
  return { hourly, daily };
}

// ---------- ČHMÚ: v jakém kraji místo leží ----------

function inRing(lon, lat, ring) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i];
    const [xj, yj] = ring[j];
    if ((yi > lat) !== (yj > lat) && lon < ((xj - xi) * (lat - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}
function inPolygon(lon, lat, rings) {
  return inRing(lon, lat, rings[0]) && !rings.slice(1).some((r) => inRing(lon, lat, r));
}
// ČHMÚ píše názvy ve tvaru „pro Jihočeský kraj“, „pro Prahu“
const regionLabel = (region) => region.name.replace(/^pro /, '').replace(/^Prahu$/, 'Praha');

function findRegion(chmi, loc) {
  return chmi.regions.find((r) => {
    const g = r.geometry;
    if (g.type === 'Polygon') return inPolygon(loc.lon, loc.lat, g.coordinates);
    if (g.type === 'MultiPolygon') return g.coordinates.some((p) => inPolygon(loc.lon, loc.lat, p));
    return false;
  });
}

// ---------- Vykreslení ----------

const SOURCES = [
  { id: 'yr', label: 'yr.no' },
  { id: 'icon', label: 'ICON' },
  { id: 'ecmwf', label: 'ECMWF' },
];

function renderNow(loc, data, region, tz) {
  const key = hourKey(new Date(), tz);
  const cur = Object.fromEntries(SOURCES.map((s) => [s.id, data[s.id]?.hourly.get(key)]));
  const main = cur.yr || cur.icon || cur.ecmwf;
  const regionName = region ? regionLabel(region) : '';

  const temps = SOURCES.map((s) => cur[s.id]?.temp).filter((t) => t != null);
  let agree = '';
  if (temps.length >= 2) {
    const spread = Math.max(...temps) - Math.min(...temps);
    agree = spread <= 1.5
      ? '✅ Zdroje se teď shodují.'
      : `⚠️ Zdroje se teď rozcházejí o ${round(spread)} °C.`;
  }

  $('#now').innerHTML = `
    <div class="now-head">
      <span class="now-place">${esc(loc.name)}</span>
      <span class="muted">${esc(regionName)}</span>
    </div>
    ${main ? `
      <div class="now-main">
        <span class="now-emoji">${main.symbol.emoji}</span>
        <div>
          <div class="now-temp">${fmtTemp(main.temp)}</div>
          <div class="now-desc">${esc(main.symbol.text)}${main.wind != null ? ` · vítr ${round(main.wind)} m/s` : ''}</div>
        </div>
      </div>
      <div class="models">
        ${SOURCES.map((s) => `<span><span class="src ${s.id}">${s.label}</span> ${fmtTemp(cur[s.id]?.temp)}</span>`).join('')}
      </div>
      <div class="agree">${agree}</div>
    ` : '<p class="error">Aktuální data se nepodařilo načíst.</p>'}
  `;
}

function renderChart(data, tz) {
  const start = new Date();
  const keys = [];
  for (let i = 0; i < CHART_HOURS; i++) keys.push(hourKey(new Date(start.getTime() + i * 3600e3), tz));

  // Graf se kreslí v šířce kontejneru, aby byly popisky čitelné i na mobilu
  const W = Math.max(300, $('#chart').clientWidth || 700);
  const narrow = W < 500;
  const H = narrow ? 200 : 240, padL = 32, padR = 8, padT = 10, padB = 34;
  const labelEvery = narrow ? 12 : 6;
  const barW = Math.max(2, (W - padL - padR) / CHART_HOURS - 2);
  const temps = [];
  for (const s of SOURCES) for (const k of keys) { const t = data[s.id]?.hourly.get(k)?.temp; if (t != null) temps.push(t); }
  if (!temps.length) { $('#chart').innerHTML = '<p class="muted">Data nejsou k dispozici.</p>'; return; }

  const tMin = Math.floor(Math.min(...temps)) - 1;
  const tMax = Math.ceil(Math.max(...temps)) + 1;
  const x = (i) => padL + (i / (keys.length - 1)) * (W - padL - padR);
  const y = (t) => padT + (1 - (t - tMin) / (tMax - tMin)) * (H - padT - padB);

  // Srážky (yr.no) jako sloupce u spodního okraje, 5 mm = plná výška 60 px
  const rainBars = keys.map((k, i) => {
    const r = data.yr?.hourly.get(k)?.rain;
    if (!r) return '';
    const h = Math.min(60, (r / 5) * 60);
    return `<rect x="${x(i) - barW / 2}" y="${H - padB - h}" width="${barW}" height="${h}" fill="var(--c-rain)" rx="1"/>`;
  }).join('');

  const lines = SOURCES.map((s) => {
    let d = '';
    let pen = false;
    keys.forEach((k, i) => {
      const t = data[s.id]?.hourly.get(k)?.temp;
      if (t == null) { pen = false; return; }
      d += `${pen ? 'L' : 'M'}${x(i).toFixed(1)},${y(t).toFixed(1)}`;
      pen = true;
    });
    return d ? `<path d="${d}" fill="none" stroke="var(--c-${s.id})" stroke-width="2.2" stroke-linejoin="round"/>` : '';
  }).join('');

  const step = tMax - tMin > 12 ? 4 : 2;
  let grid = '';
  for (let t = Math.ceil(tMin / step) * step; t <= tMax; t += step) {
    grid += `<line class="grid" x1="${padL}" x2="${W - padR}" y1="${y(t)}" y2="${y(t)}"/><text x="${padL - 6}" y="${y(t) + 4}" text-anchor="end">${t}°</text>`;
  }
  keys.forEach((k, i) => {
    const h = Number(k.slice(11));
    if (h % labelEvery === 0) {
      const label = h === 0 ? new Date(`${dayOf(k)}T12:00`).toLocaleDateString('cs-CZ', { weekday: 'short' }) : `${h}:00`;
      grid += `<line class="grid" x1="${x(i)}" x2="${x(i)}" y1="${padT}" y2="${H - padB}" stroke-dasharray="${h === 0 ? '' : '2 4'}"/>
               <text x="${x(i)}" y="${H - padB + 16}" text-anchor="middle">${label}</text>`;
    }
  });

  $('#chart').innerHTML = `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Graf teploty na 48 hodin">${grid}${rainBars}${lines}</svg>`;
}

function renderDays(data, tz) {
  const today = dayOf(hourKey(new Date(), tz));
  const days = [...(data.icon?.daily.keys() || data.yr?.daily.keys() || [])].filter((d) => d >= today).slice(0, DAYS);
  if (!days.length) { $('#days').innerHTML = '<p class="muted">Data nejsou k dispozici.</p>'; return; }

  $('#days').innerHTML = days.map((day, i) => `
    <div class="day">
      <div class="day-name">${dayLabel(day, i)}</div>
      <div class="day-rows">
        ${SOURCES.map((s) => {
          const d = data[s.id]?.daily.get(day);
          if (!d || !Number.isFinite(d.max)) return `<span class="src ${s.id}">${s.label}</span><span class="muted">–</span>`;
          return `<span class="src ${s.id}">${s.label}</span>
                  <span>${d.symbol.emoji} ${fmtTemp(d.max)} / ${fmtTemp(d.min)} <span class="rain">· ${fmtRain(d.rain)}</span></span>`;
        }).join('')}
      </div>
    </div>
  `).join('');
}

function renderChmi(chmi, region, error) {
  const el = $('#chmi');
  if (error) { el.innerHTML = '<p class="muted">Text ČHMÚ se nepodařilo načíst.</p>'; return; }
  if (!region) { el.innerHTML = '<p class="muted">Textová předpověď ČHMÚ je jen pro místa v Česku.</p>'; return; }

  const now = Date.now();
  const forecasts = region.forecasts.filter((f) => new Date(f.end).getTime() > now);
  if (!forecasts.length) { el.innerHTML = '<p class="muted">Pro tento kraj teď není aktuální předpověď.</p>'; return; }

  el.innerHTML = `
    <p class="muted">${esc(regionLabel(region))}</p>
    ${forecasts.map((f) => {
      const intro = f.items.find((it) => it.name === 'textIntro');
      const rest = f.items.filter((it) => it.name !== 'textIntro');
      return `
        <div class="chmi-block">
          <h3>${esc(f.headline)}</h3>
          ${intro ? `<p class="chmi-intro">${esc(intro.text)}</p>` : ''}
          ${rest.map((it) => `<p>${it.headline ? `<span class="muted">${esc(it.headline)}</span> ` : ''}${esc(it.text)}</p>`).join('')}
          <p class="chmi-meta muted">Vydáno ${new Date(f.sent).toLocaleString('cs-CZ', { day: 'numeric', month: 'numeric', hour: '2-digit', minute: '2-digit' })}${f.author ? ` · ${esc(f.author)}` : ''}</p>
        </div>`;
    }).join('')}
  `;
}

// ---------- Radar (RainViewer) ----------

const radar = {
  map: null,
  marker: null,
  host: '',
  frames: [],
  layers: [], // vrstva pro každý snímek, vytváří se až při prvním zobrazení
  index: 0,
  timer: null,
};

function initRadar() {
  if (!window.L) { $('#radar').innerHTML = '<p class="muted" style="padding:12px">Mapu se nepodařilo načíst.</p>'; return; }
  radar.map = L.map('radar', {
    zoomControl: true,
    scrollWheelZoom: false,
    dragging: !L.Browser.mobile, // na mobilu jedním prstem rolovat stránku, dvěma prsty mapu
    attributionControl: false,
    minZoom: 4,
    maxZoom: 10,
  });
  radar.map.setView([49.8, 15.5], 6); // celé Česko, než se vybere místo
  L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 19, className: 'basemap' }).addTo(radar.map);

  $('#radar-slider').addEventListener('input', (e) => { stopRadar(); showFrame(Number(e.target.value)); });
  $('#radar-play').addEventListener('click', () => (radar.timer ? stopRadar() : playRadar()));
}

async function loadRadarFrames() {
  if (!radar.map) return;
  try {
    const data = await getJson('https://api.rainviewer.com/public/weather-maps.json');
    radar.layers.forEach((l) => l && radar.map.removeLayer(l));
    radar.host = data.host;
    radar.frames = [...(data.radar?.past || []), ...(data.radar?.nowcast || [])];
    radar.layers = radar.frames.map(() => null);
    $('#radar-slider').max = String(Math.max(0, radar.frames.length - 1));
    showFrame((data.radar?.past?.length || 1) - 1); // poslední naměřený snímek
  } catch {
    $('#radar-time').textContent = 'radar nedostupný';
  }
}

function radarLayer(i) {
  if (!radar.layers[i]) {
    // Barevné schéma 2, vyhlazení 1, sníh odlišen 1. RainViewer má radar jen do zoomu 7, víc se dopočítá zvětšením.
    radar.layers[i] = L.tileLayer(`${radar.host}${radar.frames[i].path}/256/{z}/{x}/{y}/2/1_1.png`, {
      opacity: 0, maxNativeZoom: 7, maxZoom: 10, zIndex: 10,
    }).addTo(radar.map);
  }
  return radar.layers[i];
}

function showFrame(i) {
  if (!radar.frames.length) return;
  radar.index = i;
  radar.layers.forEach((l, j) => l && j !== i && l.setOpacity(0));
  radarLayer(i).setOpacity(0.75);
  radarLayer((i + 1) % radar.frames.length); // dopředu načíst další snímek animace
  $('#radar-slider').value = String(i);
  const t = new Date(radar.frames[i].time * 1000);
  $('#radar-time').textContent = t.toLocaleTimeString('cs-CZ', { hour: '2-digit', minute: '2-digit' });
}

function playRadar() {
  $('#radar-play').textContent = '⏸';
  $('#radar-play').setAttribute('aria-label', 'Zastavit animaci');
  radar.timer = setInterval(() => showFrame((radar.index + 1) % radar.frames.length), 700);
}

function stopRadar() {
  clearInterval(radar.timer);
  radar.timer = null;
  $('#radar-play').textContent = '▶';
  $('#radar-play').setAttribute('aria-label', 'Přehrát animaci');
}

function moveRadar(loc) {
  if (!radar.map) return;
  radar.map.setView([loc.lat, loc.lon], 7);
  if (radar.marker) radar.marker.setLatLng([loc.lat, loc.lon]);
  else radar.marker = L.circleMarker([loc.lat, loc.lon], { radius: 6, color: '#fff', weight: 2, fillColor: '#ef4444', fillOpacity: 1 }).addTo(radar.map);
}

// ---------- Hlavní logika ----------

let currentLoc = null;

async function show(loc) {
  currentLoc = loc;
  storageSet(loc.geo ? { geo: true } : loc);
  document.querySelectorAll('.chip[data-city]').forEach((b) => b.setAttribute('aria-pressed', String(CITIES[b.dataset.city].name === loc.name)));
  $('#geo-btn').setAttribute('aria-pressed', String(!!loc.geo));
  $('#now').innerHTML = `<p class="muted">Načítám ${esc(loc.name)}…</p>`;
  moveRadar(loc);

  const [yr, om, chmi] = await Promise.allSettled([loadYr(loc), loadOpenMeteo(loc), loadChmi()]);
  if (loc !== currentLoc) return; // mezitím si uživatel vybral jiné místo

  const tz = om.status === 'fulfilled' ? om.value.timezone : 'Europe/Prague';
  const data = {
    yr: yr.status === 'fulfilled' ? normalizeYr(yr.value, tz) : null,
    icon: om.status === 'fulfilled' ? normalizeOpenMeteo(om.value, OM_MODELS.icon) : null,
    ecmwf: om.status === 'fulfilled' ? normalizeOpenMeteo(om.value, OM_MODELS.ecmwf) : null,
  };
  const region = chmi.status === 'fulfilled' ? findRegion(chmi.value, loc) : null;

  renderNow(loc, data, region, tz);
  renderChart(data, tz);
  renderDays(data, tz);
  renderChmi(chmi.value, region, chmi.status === 'rejected');

  const failed = [yr.status === 'rejected' && 'yr.no', om.status === 'rejected' && 'ICON/ECMWF'].filter(Boolean);
  const chmiTime = chmi.status === 'fulfilled' ? ` · ČHMÚ staženo ${new Date(chmi.value.updated).toLocaleString('cs-CZ', { hour: '2-digit', minute: '2-digit', day: 'numeric', month: 'numeric' })}` : '';
  $('#updated').textContent = `Načteno ${new Date().toLocaleTimeString('cs-CZ', { hour: '2-digit', minute: '2-digit' })}${chmiTime}${failed.length ? ` · nepodařilo se: ${failed.join(', ')}` : ''}`;
}

// Vyhledávání míst (Open-Meteo geocoding)
let searchTimer = null;
function setupSearch() {
  const input = $('#search');
  const list = $('#search-results');
  const close = () => { list.hidden = true; list.innerHTML = ''; };

  input.addEventListener('input', () => {
    clearTimeout(searchTimer);
    const q = input.value.trim();
    if (q.length < 2) { close(); return; }
    searchTimer = setTimeout(async () => {
      try {
        const res = await getJson(`https://geocoding-api.open-meteo.com/v1/search?${new URLSearchParams({ name: q, count: 8, language: 'cs' })}`);
        const items = res.results || [];
        if (!items.length) { list.innerHTML = '<li class="muted">Nic nenalezeno</li>'; list.hidden = false; return; }
        list.innerHTML = items.map((r, i) => `<li tabindex="0" data-i="${i}">${esc(r.name)} <small>${esc([r.admin1, r.country].filter(Boolean).join(', '))}</small></li>`).join('');
        list.hidden = false;
        list.querySelectorAll('li[data-i]').forEach((li) => {
          const pick = () => {
            const r = items[Number(li.dataset.i)];
            input.value = '';
            close();
            show({ name: r.name, lat: r.latitude, lon: r.longitude });
          };
          li.addEventListener('click', pick);
          li.addEventListener('keydown', (e) => { if (e.key === 'Enter') pick(); });
        });
      } catch {
        list.innerHTML = '<li class="muted">Vyhledávání nefunguje</li>';
        list.hidden = false;
      }
    }, 300);
  });
  input.addEventListener('keydown', (e) => { if (e.key === 'Escape') { input.value = ''; close(); } });
  document.addEventListener('click', (e) => { if (!e.target.closest('.search')) close(); });
}

function setupGeo() {
  $('#geo-btn').addEventListener('click', () => {
    if (!navigator.geolocation) { alert('Tento prohlížeč neumí zjistit polohu.'); return; }
    $('#now').innerHTML = '<p class="muted">Zjišťuji polohu…</p>';
    navigator.geolocation.getCurrentPosition(
      (pos) => show({ name: 'Moje poloha', lat: pos.coords.latitude, lon: pos.coords.longitude, geo: true }),
      () => { $('#now').innerHTML = '<p class="error">Polohu se nepodařilo zjistit. Povol ji v prohlížeči, nebo vyber město.</p>'; },
      { enableHighAccuracy: false, timeout: 15000, maximumAge: 10 * 60e3 },
    );
  });
}

function init() {
  document.querySelectorAll('.chip[data-city]').forEach((b) => b.addEventListener('click', () => show(CITIES[b.dataset.city])));
  $('#refresh').addEventListener('click', () => { chmiCache = null; loadRadarFrames(); show(currentLoc); });
  initRadar();
  loadRadarFrames();
  setupSearch();
  setupGeo();

  // Poloha se neukládá přesně – po obnovení stránky se zjistí znovu
  const saved = storageGet();
  if (saved?.geo) $('#geo-btn').click();
  else show(saved && saved.lat ? saved : CITIES.praha);
}

init();
