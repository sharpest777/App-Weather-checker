#!/usr/bin/env python3
"""Stáhne model ALADIN (ČHMÚ, mřížka 1 km) a vytáhne předpověď pro okresní města do JSON.

Použití:
  fetch_aladin.py --latest-run          vypíše identifikátor nejnovějšího kompletního běhu modelu
  fetch_aladin.py VYSTUP.json [DEBUG]   stáhne data a uloží předpověď (volitelně i ladicí přehled)

Běží v GitHub Actions, potřebuje python3-eccodes a python3-numpy.
"""
import bz2
import datetime as dt
import json
import re
import shutil
import sys
import tempfile
import urllib.parse
import urllib.request
from pathlib import Path

BASE = 'https://opendata.chmi.cz/meteorology/weather/nwp_aladin/CZ_1km/'
PREFIX = 'ALADCZ1K4opendata_'
HEADERS = {'User-Agent': 'Obloha (github.com/sharpest777/Obloha)'}

# Klíč ve výstupu -> název souboru v datech ČHMÚ
FIELDS = {
    't': 'CLSTEMPERATURE',     # teplota ve 2 m
    'w': 'CLSWIND_SPEED',      # rychlost větru v 10 m
    'd': 'CLSWIND_DIREC',      # směr větru
    'p': 'SURFPREC_TOTAL',     # srážky celkem
    'c': 'SURFNEBUL_TOTALE',   # celková oblačnost
}

# Okresní města (souřadnice se dohledají přes Open-Meteo geocoding)
CITIES = [
    'Praha',
    'Benešov', 'Beroun', 'Kladno', 'Kolín', 'Kutná Hora', 'Mělník', 'Mladá Boleslav', 'Nymburk', 'Příbram', 'Rakovník',
    'České Budějovice', 'Český Krumlov', 'Jindřichův Hradec', 'Písek', 'Prachatice', 'Strakonice', 'Tábor',
    'Domažlice', 'Klatovy', 'Plzeň', 'Rokycany', 'Tachov',
    'Cheb', 'Karlovy Vary', 'Sokolov',
    'Děčín', 'Chomutov', 'Litoměřice', 'Louny', 'Most', 'Teplice', 'Ústí nad Labem',
    'Česká Lípa', 'Jablonec nad Nisou', 'Liberec', 'Semily',
    'Hradec Králové', 'Jičín', 'Náchod', 'Rychnov nad Kněžnou', 'Trutnov',
    'Chrudim', 'Pardubice', 'Svitavy', 'Ústí nad Orlicí',
    'Havlíčkův Brod', 'Jihlava', 'Pelhřimov', 'Třebíč', 'Žďár nad Sázavou',
    'Blansko', 'Brno', 'Břeclav', 'Hodonín', 'Vyškov', 'Znojmo',
    'Jeseník', 'Olomouc', 'Prostějov', 'Přerov', 'Šumperk',
    'Kroměříž', 'Uherské Hradiště', 'Vsetín', 'Zlín',
    'Bruntál', 'Frýdek-Místek', 'Karviná', 'Nový Jičín', 'Opava', 'Ostrava',
]


def fetch(url, timeout=120):
    req = urllib.request.Request(url, headers=HEADERS)
    with urllib.request.urlopen(req, timeout=timeout) as res:
        return res.read()


def latest_run():
    """Nejnovější běh (RRRRMMDDHH), u kterého jsou už nahrané všechny potřebné soubory."""
    best = None
    for hour in ('00', '06', '12', '18'):
        listing = fetch(BASE + hour + '/').decode('utf-8', 'replace')
        files = re.findall(r'href="' + PREFIX + r'(\d{10})_([A-Z0-9_]+)\.grb\.bz2"', listing)
        by_run = {}
        for run, name in files:
            by_run.setdefault(run, set()).add(name)
        for run, names in by_run.items():
            if all(f in names for f in FIELDS.values()) and (best is None or run > best[0]):
                best = (run, hour)
    if not best:
        raise RuntimeError('Nenalezen žádný kompletní běh modelu ALADIN.')
    return best


def geocode(name):
    q = urllib.parse.urlencode({'name': name, 'count': 5, 'language': 'cs', 'countryCode': 'CZ'})
    data = json.loads(fetch('https://geocoding-api.open-meteo.com/v1/search?' + q, timeout=30))
    for r in data.get('results', []):
        if r.get('feature_code', '').startswith('PPL'):
            return r['latitude'], r['longitude']
    return None


def download_grib(run, hour, field, workdir):
    """Stáhne a rozbalí jeden soubor .grb.bz2, vrátí cestu k .grb."""
    url = f'{BASE}{hour}/{PREFIX}{run}_{field}.grb.bz2'
    packed = Path(workdir) / f'{field}.grb.bz2'
    plain = Path(workdir) / f'{field}.grb'
    req = urllib.request.Request(url, headers=HEADERS)
    with urllib.request.urlopen(req, timeout=600) as res, open(packed, 'wb') as out:
        shutil.copyfileobj(res, out)
    with bz2.open(packed, 'rb') as src, open(plain, 'wb') as out:
        shutil.copyfileobj(src, out)
    packed.unlink()
    return plain


def main(out_path, debug_path=None):
    import eccodes
    import numpy as np

    run, hour = latest_run()
    print(f'Běh modelu {run} (složka {hour})')

    points = []
    for name in CITIES:
        try:
            pos = geocode(name)
        except Exception as e:  # jedno město nesmí shodit celé zpracování
            print(f'  geocoding {name}: {e}')
            pos = None
        if pos:
            points.append({'name': name, 'lat': pos[0], 'lon': pos[1]})
    print(f'Dohledáno {len(points)} z {len(CITIES)} měst')

    debug = {'run': run, 'fields': {}}
    series = {}   # klíč -> {čas: hodnoty pro města}
    idx = None

    with tempfile.TemporaryDirectory() as workdir:
        for key, field in FIELDS.items():
            path = download_grib(run, hour, field, workdir)
            info = {'messages': 0, 'stepTypes': set(), 'units': set(), 'first': None}
            series[key] = {}
            with open(path, 'rb') as f:
                while True:
                    gid = eccodes.codes_grib_new_from_file(f)
                    if gid is None:
                        break
                    try:
                        if idx is None:
                            # Nejbližší bod mřížky ke každému městu (stačí spočítat jednou, mřížka je u všech polí stejná)
                            lats = eccodes.codes_get_array(gid, 'latitudes')
                            lons = eccodes.codes_get_array(gid, 'longitudes')
                            idx, keep = [], []
                            for p in points:
                                dx = (lons - p['lon']) * np.cos(np.radians(p['lat']))
                                dy = lats - p['lat']
                                d2 = dx * dx + dy * dy
                                i = int(np.argmin(d2))
                                if np.sqrt(d2[i]) * 111 <= 3:  # do 3 km, jinak město leží mimo mřížku
                                    idx.append(i)
                                    keep.append(p)
                            points = keep
                            idx = np.array(idx)
                            debug['grid'] = {
                                'gridType': eccodes.codes_get(gid, 'gridType'),
                                'points': int(lats.size),
                                'lat': [float(lats.min()), float(lats.max())],
                                'lon': [float(lons.min()), float(lons.max())],
                            }

                        when = dt.datetime.strptime(
                            f"{eccodes.codes_get(gid, 'validityDate')}{eccodes.codes_get(gid, 'validityTime'):04d}",
                            '%Y%m%d%H%M',
                        ).replace(tzinfo=dt.timezone.utc)
                        step_type = eccodes.codes_get(gid, 'stepType')
                        units = eccodes.codes_get(gid, 'units')
                        info['messages'] += 1
                        info['stepTypes'].add(step_type)
                        info['units'].add(units)
                        if info['first'] is None:
                            info['first'] = {k: str(eccodes.codes_get(gid, k)) for k in
                                             ('shortName', 'name', 'stepRange', 'startStep', 'endStep', 'typeOfLevel', 'level')}
                        if when not in series[key]:
                            values = eccodes.codes_get_values(gid)
                            series[key][when] = (values[idx], step_type, int(eccodes.codes_get(gid, 'startStep')))
                    finally:
                        eccodes.codes_release(gid)
            path.unlink()
            info['stepTypes'] = sorted(info['stepTypes'])
            info['units'] = sorted(info['units'])
            debug['fields'][key] = info
            print(f"  {field}: {info['messages']} zpráv, {info['stepTypes']}, {info['units']}")

    times = sorted(series['t'])
    out_points = [{**p, 't': [], 'w': [], 'd': [], 'p': [], 'c': []} for p in points]

    prev_accum = None
    for when in times:
        row = {}
        for key in FIELDS:
            item = series[key].get(when)
            row[key] = item
        t = row['t'][0] if row['t'] else None
        if t is not None and np.nanmean(t) > 150:
            t = t - 273.15  # kelviny na °C

        # Srážky: akumulace od začátku běhu -> rozdíl proti předchozímu kroku
        rain = None
        if row['p']:
            vals, step_type, start = row['p']
            if step_type == 'accum' and start == 0:
                rain = vals - prev_accum if prev_accum is not None else vals
                prev_accum = vals
            else:
                rain = vals
            rain = np.clip(rain, 0, None)

        cloud = row['c'][0] if row['c'] else None
        if cloud is not None and np.nanmax(cloud) > 1.5:
            cloud = cloud / 100  # procenta na 0–1

        for i, p in enumerate(out_points):
            p['t'].append(None if t is None else round(float(t[i]), 1))
            p['w'].append(None if not row['w'] else round(float(row['w'][0][i]), 1))
            p['d'].append(None if not row['d'] else int(round(float(row['d'][0][i]))) % 360)
            p['p'].append(None if rain is None else round(float(rain[i]), 2))
            p['c'].append(None if cloud is None else round(float(cloud[i]), 2))

    result = {
        'model': 'ALADIN CZ 1 km (ČHMÚ)',
        'run': dt.datetime.strptime(run, '%Y%m%d%H').replace(tzinfo=dt.timezone.utc).isoformat().replace('+00:00', 'Z'),
        'generated': dt.datetime.now(dt.timezone.utc).isoformat(timespec='seconds').replace('+00:00', 'Z'),
        'times': [w.isoformat().replace('+00:00', 'Z') for w in times],
        'points': out_points,
    }
    Path(out_path).parent.mkdir(parents=True, exist_ok=True)
    Path(out_path).write_text(json.dumps(result, ensure_ascii=False, separators=(',', ':')), encoding='utf-8')
    print(f'Uloženo {len(out_points)} měst × {len(times)} časů do {out_path}')

    if debug_path:
        debug['times'] = [result['times'][0], result['times'][-1]] if times else []
        Path(debug_path).write_text(json.dumps(debug, ensure_ascii=False, indent=1), encoding='utf-8')


if __name__ == '__main__':
    if len(sys.argv) > 1 and sys.argv[1] == '--latest-run':
        print(latest_run()[0])
    elif len(sys.argv) > 1:
        main(sys.argv[1], sys.argv[2] if len(sys.argv) > 2 else None)
    else:
        print(__doc__)
        sys.exit(1)
