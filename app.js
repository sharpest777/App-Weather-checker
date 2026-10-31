'use strict';

// ---------- Nastavení ----------

const CITIES = {
  praha: { name: 'Praha', lat: 50.0755, lon: 14.4378 },
  brno: { name: 'Brno', lat: 49.1951, lon: 16.6068 },
  ostrava: { name: 'Ostrava', lat: 49.8209, lon: 18.2625 },
};
const DAYS = 7;
const CHART_HOURS = 48;

// ---------- Pomocné funkce ----------

const $ = (sel) => document.querySelector(sel);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const round = (n) => (n == null || Number.isNaN(n) ? null : Math.round(n));
const fmtTemp = (n) => (n == null ? '–' : `${round(n)}°`);
const fmtRain = (n) => (n == null ? '–' : `${n < 10 ? n.toFixed(1).replace('.', ',') : Math.round(n)} mm`);

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
    dir: t.data.instant.details.wind_from_direction,
    cloud: t.data.instant.details.cloud_area_fraction,
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
    hourly: 'temperature_2m,precipitation,wind_speed_10m,wind_direction_10m,weather_code',
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

// Model ALADIN (ČHMÚ) pro okresní města – zpracovává ho GitHub Action do data/aladin.json
let aladinCache = null;
async function loadAladin() {
  if (!aladinCache) aladinCache = getJson(`data/aladin.json?t=${Date.now()}`).catch((e) => { aladinCache = null; throw e; });
  return aladinCache;
}

// ---------- Převod dat do společné podoby ----------

// Symbol z oblačnosti (0–1) a srážek – ALADIN vlastní symboly počasí nemá
function aladinSymbol(cloud, rain, temp, night) {
  if (rain >= 0.1) return temp <= 0 ? { emoji: '🌨️', text: 'sněžení' } : rain >= 2.5 ? { emoji: '🌧️', text: 'déšť' } : { emoji: '🌦️', text: 'slabý déšť' };
  if (cloud == null) return { emoji: '', text: '' };
  if (cloud < 0.2) return { emoji: night ? '🌙' : '☀️', text: 'jasno' };
  if (cloud < 0.5) return { emoji: night ? '🌙' : '🌤️', text: 'skoro jasno' };
  if (cloud < 0.8) return { emoji: '⛅', text: 'polojasno' };
  return { emoji: '☁️', text: 'zataženo' };
}

// Nejbližší okresní město do 20 km od místa; dál už by předpověď neodpovídala
const ALADIN_MAX_KM = 20;
function normalizeAladin(json, loc, tz) {
  let best = null;
  let bestKm = Infinity;
  for (const p of json.points) {
    const dx = (p.lon - loc.lon) * Math.cos((loc.lat * Math.PI) / 180) * 111;
    const dy = (p.lat - loc.lat) * 111;
    const km = Math.hypot(dx, dy);
    if (km < bestKm) { best = p; bestKm = km; }
  }
  if (!best || bestKm > ALADIN_MAX_KM) return null;

  const hourly = new Map();
  const daily = new Map();
  json.times.forEach((iso, i) => {
    const key = hourKey(new Date(iso), tz);
    const h = Number(key.slice(11));
    const night = h < 6 || h >= 20;
    const temp = best.t[i];
    // Srážky v datech platí za hodinu končící časem i; hodina začínající časem i je tedy i+1
    // (stejně jako u yr.no, kde jsou srážky „na příští hodinu“)
    const rainNext = best.p[i + 1] ?? null;
    hourly.set(key, {
      temp, rain: rainNext, wind: best.w[i], dir: best.d[i], cloud: best.c[i],
      symbol: aladinSymbol(best.c[i], rainNext, temp, night),
    });
    if (temp == null) return;
    const day = dayOf(key);
    const d = daily.get(day) || { max: -Infinity, min: Infinity, rain: 0, hours: 0, clouds: [] };
    d.max = Math.max(d.max, temp);
    d.min = Math.min(d.min, temp);
    d.rain += best.p[i] || 0;
    d.hours += 1;
    if (h >= 9 && h <= 18 && best.c[i] != null) d.clouds.push(best.c[i]);
    daily.set(day, d);
  });

  const today = dayOf(hourKey(new Date(), tz));
  for (const [day, d] of daily) {
    // Neúplný poslední den by ukazoval zkreslené maximum a minimum – vynechat (dnešek nechat)
    if (day !== today && d.hours < 18) { daily.delete(day); continue; }
    const cloud = d.clouds.length ? d.clouds.reduce((a, b) => a + b, 0) / d.clouds.length : null;
    // Den s aspoň 1 mm srážek dostane symbol deště (od 10 mm silného), jinak podle oblačnosti přes den
    d.symbol = d.rain >= 1
      ? (d.rain >= 10 ? { emoji: '🌧️', text: 'déšť' } : { emoji: '🌦️', text: 'přeháňky' })
      : aladinSymbol(cloud, 0, d.max, false);
  }
  return { hourly, daily, point: best.name };
}

// Vrátí { hourly: Map(klíč hodiny -> {temp, rain, wind, symbol}), daily: Map(datum -> {max, min, rain, symbol}) }
function normalizeYr(series, tz) {
  const hourly = new Map();
  const daily = new Map();
  let coveredUntil = 0;
  for (const s of series) {
    const key = hourKey(s.time, tz);
    hourly.set(key, {
      temp: s.temp, rain: s.rain1 ?? null, wind: s.wind, dir: s.dir,
      cloud: s.cloud == null ? null : s.cloud / 100, symbol: yrSymbol(s.symbol),
    });

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
      dir: h[`wind_direction_10m_${model}`][i],
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

// Popisky podle toho, odkud předpověď pochází
const SOURCES = [
  { id: 'cz', label: 'CZ', title: 'Český hydrometeorologický ústav (ČHMÚ), model ALADIN 1 km' },
  { id: 'yr', label: 'NOR', title: 'Norský meteorologický ústav (MET Norway), yr.no' },
  { id: 'icon', label: 'GER', title: 'Německá meteorologická služba (DWD), model ICON' },
  { id: 'ecmwf', label: 'EU', title: 'Evropské centrum pro střednědobé předpovědi (ECMWF)' },
];
const srcTag = (s) => `<span class="src ${s.id}" title="${esc(s.title)}">${s.label}</span>`;

// ---------- Ukazatele oblečení a větru ----------

// Pocitová teplota: při chladu a větru se počítá ochlazení větrem (wind chill), jinak skutečná teplota
function feelsLike(temp, wind) {
  const kmh = (wind ?? 0) * 3.6;
  if (temp > 10 || kmh < 4.8) return temp;
  const v = kmh ** 0.16;
  return 13.12 + 0.6215 * temp - 11.37 * v + 0.3965 * temp * v;
}

// Hranice se dají snadno upravit: od kolika °C (pocitově) stačí daný kus oblečení
const CLOTHES = [
  { id: 'triko', label: 'Triko', from: 20, icon: 'M8 3 3 6l2 4 2-1v12h10V9l2 1 2-4-5-3c-.6 1.6-2 2.5-4 2.5S8.6 4.6 8 3z' },
  { id: 'mikina', label: 'Mikina', from: 13, icon: 'M9 3h6l5 3 1 13h-3l-1-9v11H7V10l-1 9H3L4 6zM9 3c0 2.5 1.3 4 3 4s3-1.5 3-4M9 15h6' },
  { id: 'bunda', label: 'Bunda', from: -Infinity, icon: 'M8 3h8l4 3 1 13h-3l-1-9v11H7V10l-1 9H3L4 6zM12 6v15M8 3l4 3 4-3' },
];

// Síla větru v m/s: slabý do 4, střední do 8, silný od 8 (zhruba podle Beaufortovy stupnice)
const WINDS = [
  { id: 'slaby', label: 'Slabý', from: 0 },
  { id: 'stredni', label: 'Střední', from: 4 },
  { id: 'silny', label: 'Silný', from: 8 },
];

// Srážky v mm za hodinu: slabé do 2,5, střední do 8, slejvák od 8 (pod 0,1 mm = bez srážek)
const RAINS = [
  { id: 'slabe', label: 'Slabé', from: 0.1 },
  { id: 'stredni', label: 'Střední', from: 2.5 },
  { id: 'slejvak', label: 'Slejvák', from: 8 },
];

// Nejvyšší stupeň, jehož hranici hodnota dosáhla – nezáleží na pořadí stupňů ve stupnici
const levelOf = (scale, value) => scale
  .filter((lvl) => value >= lvl.from)
  .reduce((hit, lvl) => (!hit || lvl.from > hit.from ? lvl : hit), null) || scale[0];
const DIRS = ['S', 'SV', 'V', 'JV', 'J', 'JZ', 'Z', 'SZ'];
const dirName = (deg) => DIRS[Math.round(deg / 45) % 8];

function meter(scale, active, color) {
  return `<div class="meter" style="--meter: var(${color})">
    ${scale.map((lvl) => `<span class="seg${lvl === active ? ' on' : ''}">${lvl.label}</span>`).join('')}
  </div>`;
}

// Šipka větru je oranžová, když je den teplý (nejvyšší denní teplota aspoň tolik °C), jinak modrá
const WARM_DAY_FROM = 15;

// Srážky a oblačnost bere přednostně z CZ (ALADIN, 1 km), kde CZ není, z NOR (yr.no)
function preferredSource(data, key, field) {
  const cz = data.cz?.hourly.get(key)?.[field];
  if (cz != null) return { id: 'cz', label: 'CZ', hourly: (k) => data.cz.hourly.get(k)?.[field], now: cz };
  return { id: 'yr', label: 'NOR', hourly: (k) => data.yr?.hourly.get(k)?.[field], now: data.yr?.hourly.get(key)?.[field] };
}
const rainSource = (data, key) => preferredSource(data, key, 'rain');
const RAIN_SOON_HOURS = 6; // na kolik hodin dopředu hlídat déšť kvůli deštníku

// Oblačnost (podíl oblohy 0–1): jasno do 30 %, polojasno do 70 %, oblačno od 70 %
const CLOUDS = [
  { id: 'jasno', label: 'Jasno', from: 0 },
  { id: 'polojasno', label: 'Polojasno', from: 0.3 },
  { id: 'oblacno', label: 'Oblačno', from: 0.7 },
];

function renderGauges(cur, dayMax, rain, cloud) {
  if (cur.temp == null) return '';
  const feels = feelsLike(cur.temp, cur.wind);
  const cloth = levelOf(CLOTHES, feels);
  const feelsNote = Math.abs(feels - cur.temp) >= 1 ? ` · pocitově ${fmtTemp(feels)}` : '';

  let windHtml = '';
  if (cur.wind != null) {
    const w = levelOf(WINDS, cur.wind);
    // Šipka ukazuje, kam vítr fouká (opačně než směr, odkud fouká)
    const warm = (dayMax ?? cur.temp) >= WARM_DAY_FROM;
    const arrow = cur.dir != null
      ? `<svg class="gauge-icon wind-arrow ${warm ? 'warm' : 'cold'}" viewBox="0 0 24 24" style="transform: rotate(${cur.dir + 180}deg)" role="img" aria-label="${warm ? 'teplý' : 'chladný'} vítr"><title>${warm ? 'Teplý' : 'Chladný'} den</title><path d="M12 3l5 9h-3.5v9h-3v-9H7z"/></svg>`
      : '';
    windHtml = `
      <div class="gauge">
        ${arrow}
        <div class="gauge-body">
          <div class="gauge-title">Vítr <strong>${round(cur.wind)} m/s</strong>${cur.dir != null ? ` <span class="muted">od ${dirName(cur.dir)}</span>` : ''}</div>
          ${meter(WINDS, w, '--c-wind')}
        </div>
      </div>`;
  }

  let rainHtml = '';
  if (rain?.now != null) {
    const r = rain.now >= RAINS[0].from ? levelOf(RAINS, rain.now) : null;
    rainHtml = `
      <div class="gauge">
        ${r
          ? '<svg class="gauge-icon rain-drop" viewBox="0 0 24 24" aria-label="srážky"><path d="M12 2.5C9 7 6 10.5 6 14a6 6 0 0 0 12 0c0-3.5-3-7-6-11.5z"/></svg>'
          // Bez srážek: přeškrtnutá prázdná kapka
          : '<svg class="gauge-icon outline dry" viewBox="0 0 24 24" aria-label="sucho"><path d="M12 2.5C9 7 6 10.5 6 14a6 6 0 0 0 12 0c0-3.5-3-7-6-11.5zM4 4l16 16"/></svg>'}
        <div class="gauge-body">
          <div class="gauge-title">Srážky ${r ? `<strong>${fmtRain(rain.now)}/h</strong>` : '<strong>žádné</strong>'} <span class="muted">v příští hodině</span></div>
          ${meter(RAINS, r, '--c-rainmeter')}
        </div>
      </div>`;
  }

  let cloudHtml = '';
  if (cloud?.now != null) {
    const c = levelOf(CLOUDS, cloud.now);
    // Když má v příštích hodinách pršet středně nebo silně, místo mraku deštník
    const umbrella = (rain?.soonMax ?? 0) >= RAINS[1].from;
    const icon = umbrella
      ? `<svg class="gauge-icon umbrella" viewBox="0 0 24 24" role="img" aria-label="vezmi si deštník"><title>Do ${RAIN_SOON_HOURS} hodin má pršet až ${fmtRain(rain.soonMax)}/h</title><path class="canopy" d="M2 12a10 10 0 0 1 20 0z"/><path class="handle" d="M12 12v7a2 2 0 0 1-4 0"/></svg>`
      : '<svg class="gauge-icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M7 19a4.5 4.5 0 0 1-.6-8.96A6 6 0 0 1 17.8 9.1 4.95 4.95 0 0 1 17.5 19z"/></svg>';
    cloudHtml = `
      <div class="gauge">
        ${icon}
        <div class="gauge-body">
          <div class="gauge-title">Obloha <strong>${c.label.toLowerCase()}</strong> <span class="muted">${Math.round(cloud.now * 100)} % mraků${umbrella ? ' · vezmi deštník' : ''}</span></div>
          ${meter(CLOUDS, c, '--c-cloud')}
        </div>
      </div>`;
  }

  return `
    <div class="gauges">
      <div class="gauge">
        <svg class="gauge-icon outline" viewBox="0 0 24 24" aria-hidden="true"><path d="${cloth.icon}"/></svg>
        <div class="gauge-body">
          <div class="gauge-title">Oblečení: <strong>${cloth.label.toLowerCase()}</strong><span class="muted">${feelsNote}</span></div>
          ${meter(CLOTHES, cloth, '--c-cloth')}
        </div>
      </div>
      ${windHtml}
      ${rainHtml}
      ${cloudHtml}
    </div>`;
}

function renderNow(loc, data, region, tz) {
  const key = hourKey(new Date(), tz);
  const cur = Object.fromEntries(SOURCES.map((s) => [s.id, data[s.id]?.hourly.get(key)]));
  const main = cur.yr || cur.icon || cur.ecmwf;
  // Denní maximum z modelů s celým dnem (yr.no má pro dnešek jen zbývající hodiny)
  const today = dayOf(key);
  const dayMax = [data.icon, data.ecmwf, data.cz, data.yr].map((d) => d?.daily.get(today)?.max).find((t) => Number.isFinite(t));
  const regionName = region && regionLabel(region) !== loc.name ? regionLabel(region) : '';

  // Nejsilnější hodinové srážky v příštích hodinách (pro deštník u oblohy)
  const rain = rainSource(data, key);
  const soon = [];
  for (let i = 0; i < RAIN_SOON_HOURS; i++) soon.push(rain.hourly(hourKey(new Date(Date.now() + i * 3600e3), tz)) ?? 0);
  rain.soonMax = Math.max(...soon);

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
      <div class="now-grid">
        <div class="now-main">
          <span class="now-emoji">${main.symbol.emoji}</span>
          <div>
            <div class="now-temp">${fmtTemp(main.temp)}</div>
            <div class="now-desc">${esc(main.symbol.text)}</div>
          </div>
        </div>
        ${renderGauges(main, dayMax, rain, preferredSource(data, key, 'cloud'))}
      </div>
      <div class="models">
        ${SOURCES.map((s) => `<span>${srcTag(s)} ${fmtTemp(cur[s.id]?.temp)}</span>`).join('')}
      </div>
      <div class="agree">${agree}</div>
    ` : '<p class="error">Aktuální data se nepodařilo načíst.</p>'}
  `;
}

// Východ a západ slunce pro daný den (rovnice východu slunce, přesnost na pár minut).
// Vrací časy v ms; za polárním kruhem rise/set chybí a polarDay říká, jestli je celý den světlo.
function sunTimes(date, lat, lon) {
  const rad = Math.PI / 180;
  const jd = date.getTime() / 864e5 + 2440587.5;
  const n = Math.round(jd - 2451545 + 0.0008);
  const jStar = n - lon / 360;
  const M = (357.5291 + 0.98560028 * jStar) % 360;
  const C = 1.9148 * Math.sin(M * rad) + 0.02 * Math.sin(2 * M * rad) + 0.0003 * Math.sin(3 * M * rad);
  const lambda = (M + C + 180 + 102.9372) % 360;
  const jTransit = 2451545 + jStar + 0.0053 * Math.sin(M * rad) - 0.0069 * Math.sin(2 * lambda * rad);
  const sinDec = Math.sin(lambda * rad) * Math.sin(23.4397 * rad);
  const cosDec = Math.cos(Math.asin(sinDec));
  const cosW = (Math.sin(-0.833 * rad) - Math.sin(lat * rad) * sinDec) / (Math.cos(lat * rad) * cosDec);
  if (cosW > 1) return { polarDay: false };
  if (cosW < -1) return { polarDay: true };
  const w = Math.acos(cosW) / rad;
  const toMs = (j) => (j - 2440587.5) * 864e5;
  return { rise: toMs(jTransit - w / 360), set: toMs(jTransit + w / 360) };
}

function renderChart(data, tz, loc) {
  const start = new Date();
  const keys = [];
  for (let i = 0; i < CHART_HOURS; i++) keys.push(hourKey(new Date(start.getTime() + i * 3600e3), tz));

  // Graf se kreslí v šířce kontejneru, aby byly popisky čitelné i na mobilu
  const W = Math.max(300, $('#chart').clientWidth || 700);
  const narrow = W < 500;
  const H = narrow ? 250 : 290, padL = 30, padR = 10, padT = 26, padB = 50;
  const rainH = 46; // pás pro srážky u spodního okraje
  const labelEvery = narrow ? 12 : 6;
  const barW = Math.max(2, (W - padL - padR) / CHART_HOURS - 2);

  // Průměr dostupných zdrojů pro každou hodinu
  const series = keys.map((k) => SOURCES.map((s) => data[s.id]?.hourly.get(k)?.temp).filter((t) => t != null));
  const avgT = series.map((ts) => (ts.length ? avg(ts) : null));
  const temps = series.flat();
  if (!temps.length) { $('#chart').innerHTML = '<p class="muted">Data nejsou k dispozici.</p>'; return; }

  const tMin = Math.floor(Math.min(...temps)) - 1;
  const tMax = Math.ceil(Math.max(...temps)) + 1;
  const plotB = H - padB - rainH; // spodní okraj teplotní části
  const x = (i) => padL + (i / (keys.length - 1)) * (W - padL - padR);
  const y = (t) => padT + (1 - (t - tMin) / (tMax - tMin)) * (plotB - padT);

  // Den a noc podle skutečného východu a západu slunce: barevný pás pod grafem
  // a jemné svislé čáry v okamžiku východu a západu
  const t0 = start.getTime();
  const t1 = t0 + (CHART_HOURS - 1) * 3600e3;
  const xt = (t) => padL + ((t - t0) / (t1 - t0)) * (W - padL - padR);
  const fmtTime = (t) => new Date(t).toLocaleTimeString('cs-CZ', { hour: 'numeric', minute: '2-digit', timeZone: tz });
  const events = [];
  for (let d = -1; d <= 3; d++) {
    const st = sunTimes(new Date(t0 + d * 864e5), loc.lat, loc.lon);
    if (st.rise) events.push({ t: st.rise, day: true });
    if (st.set) events.push({ t: st.set, day: false });
  }
  events.sort((a, b) => a.t - b.t);
  const before = events.filter((e) => e.t <= t0).at(-1);
  let isDay = before ? before.day : sunTimes(start, loc.lat, loc.lon).polarDay;
  const stripY = H - padB + 4;
  const stripH = 16;
  let sun = '';
  let segStart = t0;
  const inside = events.filter((e) => e.t > t0 && e.t < t1);
  [...inside, { t: t1, end: true }].forEach((e) => {
    const xa = xt(segStart);
    const xb = xt(e.t);
    const w = xb - xa;
    const cls = isDay ? 'sun-day' : 'sun-night';
    sun += `<rect class="${cls}" x="${xa}" y="${stripY}" width="${Math.max(0, w)}" height="${stripH}"><title>${isDay ? 'Den' : 'Noc'} ${fmtTime(segStart)}–${fmtTime(e.t)}</title></rect>`;
    if (w > 26) sun += `<text x="${(xa + xb) / 2}" y="${stripY + 12}" text-anchor="middle" class="sun-icon">${isDay ? '☀️' : '🌙'}</text>`;
    if (!e.end) {
      // Okamžik východu/západu: svislá čára přes graf a čas v pásu
      sun += `<line class="${e.day ? 'sunrise' : 'sunset'}" x1="${xb}" x2="${xb}" y1="${padT - 10}" y2="${stripY + stripH}"/>`;
      if (!narrow) sun += `<text x="${xb + 4}" y="${padT - 2}" class="sun-time">${e.day ? 'východ' : 'západ'} ${fmtTime(e.t)}</text>`;
      isDay = e.day;
      segStart = e.t;
    }
  });

  // Mřížka teplot a popisky času
  const step = tMax - tMin > 12 ? 4 : 2;
  let grid = '';
  for (let t = Math.ceil(tMin / step) * step; t <= tMax; t += step) {
    grid += `<line class="grid" x1="${padL}" x2="${W - padR}" y1="${y(t)}" y2="${y(t)}"/><text x="${padL - 6}" y="${y(t) + 4}" text-anchor="end">${t}°</text>`;
  }
  keys.forEach((k, i) => {
    const h = Number(k.slice(11));
    if (h % labelEvery === 0) {
      const label = h === 0 ? new Date(`${dayOf(k)}T12:00`).toLocaleDateString('cs-CZ', { weekday: 'short' }) : `${h}:00`;
      grid += `<text x="${x(i)}" y="${H - padB + 38}" text-anchor="middle" class="${h === 0 ? 'day-mark' : ''}">${label}</text>`;
    }
  });

  // Srážky (CZ, jinak NOR) jako sloupce v dolním pásu, 5 mm/h = plná výška
  const rain = rainSource(data, keys[0]);
  $('#rain-legend').textContent = `srážky (${rain.label})`;
  const rainBars = keys.map((k, i) => {
    const r = rain.hourly(k);
    if (!r || r < 0.05) return '';
    const h = Math.max(2, Math.min(rainH - 4, (r / 5) * (rainH - 4)));
    return `<rect x="${x(i) - barW / 2}" y="${H - padB - h}" width="${barW}" height="${h}" rx="${Math.min(2, barW / 2)}" fill="var(--c-rain)"><title>${fmtRain(r)}/h</title></rect>`;
  }).join('');

  // Jedna křivka průměrné teploty s výplní pod ní
  const avgPts = avgT.map((t, i) => (t == null ? null : [x(i), y(t)]));
  const avgPath = smoothPath(avgPts);
  const valid = avgPts.filter(Boolean);
  const area = valid.length > 1
    ? `${avgPath} L${valid.at(-1)[0].toFixed(1)},${plotB} L${valid[0][0].toFixed(1)},${plotB} Z`
    : '';

  // Hodnoty teploty podél křivky: každé 3 hodiny (na mobilu každých 6) + nejteplejší a nejchladnější hodina
  const valueEvery = narrow ? 6 : 3;
  const iMax = avgT.reduce((b, t, i) => (t != null && (b < 0 || t > avgT[b]) ? i : b), -1);
  const iMin = avgT.reduce((b, t, i) => (t != null && (b < 0 || t < avgT[b]) ? i : b), -1);
  const labelled = new Set();
  keys.forEach((k, i) => { if (avgT[i] != null && Number(k.slice(11)) % valueEvery === 0) labelled.add(i); });
  for (const i of [iMax, iMin]) {
    if (i < 0) continue;
    // Extrém nahradí běžný popisek, který by s ním kolidoval
    for (const j of [...labelled]) if (Math.abs(j - i) < valueEvery && j !== i) labelled.delete(j);
    labelled.add(i);
  }
  const values = [...labelled].map((i) => {
    const extreme = i === iMax || i === iMin;
    const below = i === iMin && iMin !== iMax;
    const tx = Math.min(Math.max(x(i), padL + 12), W - padR - 12);
    return `<circle cx="${x(i)}" cy="${y(avgT[i])}" r="${extreme ? 4.5 : 3}" class="t-dot${extreme ? ' extreme' : ''}"/>
      <text x="${tx}" y="${y(avgT[i]) + (below ? 20 : -10)}" text-anchor="middle" class="t-value${extreme ? ' extreme' : ''}">${fmtTemp(avgT[i])}</text>`;
  }).join('');

  // Barva čáry podle teploty: nahoře teplá, dole studená (gradient v souřadnicích grafu)
  $('#chart').innerHTML = `
    <svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Graf průměrné teploty na 48 hodin">
      <defs>
        <linearGradient id="temp-stroke" gradientUnits="userSpaceOnUse" x1="0" x2="0" y1="${y(tMax)}" y2="${y(tMin)}">
          ${tempStops(tMax, tMin, 1)}
        </linearGradient>
        <linearGradient id="temp-fill" gradientUnits="userSpaceOnUse" x1="0" x2="0" y1="${y(tMax)}" y2="${plotB}">
          ${tempStops(tMax, tMin, 0.28, 0.03)}
        </linearGradient>
      </defs>
      ${grid}${sun}
      <line class="axis" x1="${padL}" x2="${W - padR}" y1="${H - padB}" y2="${H - padB}"/>
      ${rainBars}
      ${area ? `<path d="${area}" fill="url(#temp-fill)"/>` : ''}
      ${avgPath ? `<path d="${avgPath}" class="avg-line"/>` : ''}
      ${values}
    </svg>`;
}

// Teplotní barevná škála: mráz modrá, chladno tyrkysová, mírno zelená, teplo jantarová až červená
const TEMP_COLORS = [
  [-10, [79, 70, 229]], [0, [37, 99, 235]], [7, [13, 148, 136]], [14, [101, 163, 13]],
  [20, [217, 119, 6]], [26, [234, 88, 12]], [32, [220, 38, 38]],
];
function tempColor(t) {
  const c = TEMP_COLORS;
  if (t <= c[0][0]) return `rgb(${c[0][1]})`;
  for (let i = 1; i < c.length; i++) {
    if (t <= c[i][0]) {
      const f = (t - c[i - 1][0]) / (c[i][0] - c[i - 1][0]);
      return `rgb(${c[i - 1][1].map((v, j) => Math.round(v + (c[i][1][j] - v) * f)).join(',')})`;
    }
  }
  return `rgb(${c.at(-1)[1]})`;
}
// Zastávky gradientu od tMax (nahoře) po tMin (dole); průhlednost se může směrem dolů měnit
function tempStops(tMax, tMin, opTop, opBottom = opTop) {
  const n = 6;
  return Array.from({ length: n + 1 }, (_, i) => {
    const f = i / n;
    return `<stop offset="${(f * 100).toFixed(0)}%" style="stop-color: ${tempColor(tMax - (tMax - tMin) * f)}; stop-opacity: ${(opTop + (opBottom - opTop) * f).toFixed(2)}"/>`;
  }).join('');
}

// Hladká křivka přes body (Catmull-Rom převedený na Bézierovy oblouky); null přeruší čáru
function smoothPath(points) {
  let d = '';
  let run = [];
  const flush = () => {
    if (run.length === 1) d += `M${run[0][0].toFixed(1)},${run[0][1].toFixed(1)}`;
    if (run.length > 1) {
      d += `M${run[0][0].toFixed(1)},${run[0][1].toFixed(1)}`;
      for (let i = 0; i < run.length - 1; i++) {
        const p0 = run[i - 1] || run[i];
        const p1 = run[i];
        const p2 = run[i + 1];
        const p3 = run[i + 2] || p2;
        const c1 = [p1[0] + (p2[0] - p0[0]) / 6, p1[1] + (p2[1] - p0[1]) / 6];
        const c2 = [p2[0] - (p3[0] - p1[0]) / 6, p2[1] - (p3[1] - p1[1]) / 6];
        d += `C${c1[0].toFixed(1)},${c1[1].toFixed(1)} ${c2[0].toFixed(1)},${c2[1].toFixed(1)} ${p2[0].toFixed(1)},${p2[1].toFixed(1)}`;
      }
    }
    run = [];
  };
  for (const p of points) { if (p) run.push(p); else flush(); }
  flush();
  return d;
}

const avg = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);

// Průměr všech zdrojů pro jeden den: nejvyšší a nejnižší teplota, srážky a jedna ikona
function averageDay(data, day, today) {
  const ds = SOURCES
    // NOR a CZ mají pro dnešek jen zbývající hodiny – do dnešního průměru je nebrat
    .filter((s) => !(day === today && (s.id === 'yr' || s.id === 'cz')))
    .map((s) => data[s.id]?.daily.get(day))
    .filter((d) => d && Number.isFinite(d.max));
  if (!ds.length) return null;
  const max = avg(ds.map((d) => d.max));
  const min = avg(ds.map((d) => d.min));
  const rain = avg(ds.map((d) => d.rain || 0));

  // Ikona: při průměrných srážkách aspoň 1 mm déšť (sníh), jinak nejčastější ikona mezi zdroji
  let symbol;
  if (rain >= 1) {
    symbol = max <= 1 ? { emoji: '🌨️', text: 'sněžení' } : rain >= 10 ? { emoji: '🌧️', text: 'déšť' } : { emoji: '🌦️', text: 'přeháňky' };
  } else {
    const dry = ds.map((d) => d.symbol).filter((s) => s?.emoji && !['🌧️', '🌦️', '🌨️', '⛈️'].includes(s.emoji));
    const counts = {};
    for (const s of dry) counts[s.emoji] = (counts[s.emoji] || 0) + 1;
    const top = Object.entries(counts).sort((a, b) => b[1] - a[1])[0];
    symbol = dry.find((s) => s.emoji === top?.[0]) || { emoji: '⛅', text: 'polojasno' };
  }
  return { max, min, rain, symbol, sources: ds.length };
}

function renderDays(data, tz) {
  const today = dayOf(hourKey(new Date(), tz));
  const allDays = new Set();
  for (const s of SOURCES) for (const d of data[s.id]?.daily.keys() || []) if (d >= today) allDays.add(d);
  const days = [...allDays].sort().slice(0, DAYS)
    .map((day) => ({ day, ...averageDay(data, day, today) }))
    .filter((d) => d.max != null);
  if (!days.length) { $('#days').innerHTML = '<p class="muted">Data nejsou k dispozici.</p>'; return; }

  const W = Math.max(300, $('#days').clientWidth || 700);
  const narrow = W < 500;
  const H = 250, padL = 8, padR = 8, padT = 52, padB = 46;
  const colW = (W - padL - padR) / days.length;
  const x = (i) => padL + colW * (i + 0.5);
  const tMin = Math.floor(Math.min(...days.map((d) => d.min))) - 2;
  const tMax = Math.ceil(Math.max(...days.map((d) => d.max))) + 2;
  // Teploty v horní části, srážky dole (10 mm = 50 px)
  const plotBottom = H - padB - 56;
  const y = (t) => padT + (1 - (t - tMin) / (tMax - tMin)) * (plotBottom - padT);
  const rainBase = H - padB;

  const line = (key) => days.map((d, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)},${y(d[key]).toFixed(1)}`).join('');

  let svg = '';
  days.forEach((d, i) => {
    const cx = x(i);
    if (i) svg += `<line class="grid" x1="${padL + colW * i}" x2="${padL + colW * i}" y1="8" y2="${H - 8}"/>`;
    const label = i === 0 ? 'Dnes' : i === 1 ? 'Zítra' : new Date(`${d.day}T12:00`).toLocaleDateString('cs-CZ', { weekday: 'short' });
    svg += `<text x="${cx}" y="20" text-anchor="middle" class="day-label">${label}</text>`;
    svg += `<text x="${cx}" y="44" text-anchor="middle" class="day-icon"><title>${esc(d.symbol.text)}</title>${d.symbol.emoji}</text>`;
    svg += `<text x="${cx}" y="${y(d.max) - 8}" text-anchor="middle" class="t-max">${fmtTemp(d.max)}</text>`;
    svg += `<text x="${cx}" y="${y(d.min) + 18}" text-anchor="middle" class="t-min">${fmtTemp(d.min)}</text>`;
    const h = Math.min(50, (d.rain / 10) * 50);
    if (d.rain >= 0.1) svg += `<rect x="${cx - Math.min(14, colW / 4)}" y="${rainBase - h}" width="${Math.min(28, colW / 2)}" height="${Math.max(h, 2)}" rx="2" fill="var(--c-rain)"/>`;
    svg += `<text x="${cx}" y="${rainBase + 16}" text-anchor="middle" class="rain-label">${d.rain >= 0.1 ? fmtRain(d.rain) : '–'}</text>`;
    svg += `<text x="${cx}" y="${rainBase + 32}" text-anchor="middle" class="src-count">${narrow ? '' : `${d.sources} zdr.`}</text>`;
  });
  svg += `<path d="${line('max')}" fill="none" stroke="var(--c-max)" stroke-width="2.4" stroke-linejoin="round"/>`;
  svg += `<path d="${line('min')}" fill="none" stroke="var(--c-min)" stroke-width="2.4" stroke-linejoin="round"/>`;
  svg += days.map((d, i) => `<circle cx="${x(i)}" cy="${y(d.max)}" r="3.5" fill="var(--c-max)"/><circle cx="${x(i)}" cy="${y(d.min)}" r="3.5" fill="var(--c-min)"/>`).join('');

  $('#days').innerHTML = `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Předpověď na ${days.length} dní">${svg}</svg>`;
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
  document.querySelectorAll('.chip[data-city]').forEach((b) => b.setAttribute('aria-pressed', String(CITIES[b.dataset.city].name === loc.name)));
  $('#geo-btn').setAttribute('aria-pressed', String(!!loc.geo));
  $('#now').innerHTML = `<p class="muted">Načítám ${esc(loc.name)}…</p>`;
  moveRadar(loc);

  const [yr, om, chmi, aladin] = await Promise.allSettled([loadYr(loc), loadOpenMeteo(loc), loadChmi(), loadAladin()]);
  if (loc !== currentLoc) return; // mezitím si uživatel vybral jiné místo

  const tz = om.status === 'fulfilled' ? om.value.timezone : 'Europe/Prague';
  const data = {
    cz: aladin.status === 'fulfilled' ? normalizeAladin(aladin.value, loc, tz) : null,
    yr: yr.status === 'fulfilled' ? normalizeYr(yr.value, tz) : null,
    icon: om.status === 'fulfilled' ? normalizeOpenMeteo(om.value, OM_MODELS.icon) : null,
    ecmwf: om.status === 'fulfilled' ? normalizeOpenMeteo(om.value, OM_MODELS.ecmwf) : null,
  };
  const region = chmi.status === 'fulfilled' ? findRegion(chmi.value, loc) : null;

  renderNow(loc, data, region, tz);
  renderChart(data, tz, loc);
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

// GitHub Pages nechá prohlížeč držet stránku až 10 minut. Když je na serveru novější verze,
// načte se znovu přes jinou adresu (?v=…), kterou prohlížeč v cache nemá.
async function checkForUpdate() {
  const current = document.querySelector('script[src^="app.js"]')?.getAttribute('src').split('v=')[1];
  if (!current || current === '__VERSION__') return; // lokální vývoj
  try {
    const html = await (await fetch(`./?check=${Date.now()}`, { cache: 'no-store' })).text();
    const latest = html.match(/app\.js\?v=([\w]+)/)?.[1];
    if (latest && latest !== current) location.replace(`${location.pathname}?v=${latest}`);
  } catch { /* bez připojení nic nedělat */ }
}

function init() {
  checkForUpdate();
  document.querySelectorAll('.chip[data-city]').forEach((b) => b.addEventListener('click', () => show(CITIES[b.dataset.city])));
  $('#refresh').addEventListener('click', () => { chmiCache = null; aladinCache = null; loadRadarFrames(); show(currentLoc); });
  initRadar();
  loadRadarFrames();
  setupSearch();
  setupGeo();

  // Po otevření vždy Praha
  show(CITIES.praha);
}

init();
