# Počasí – srovnání předpovědí

Webová appka, která na jednom místě ukazuje předpověď z několika zdrojů:

- **yr.no** (MET Norway) – hodinová předpověď, načítá se přímo v prohlížeči,
- **ICON** (německá DWD) a **ECMWF** – přes [Open-Meteo](https://open-meteo.com/),
- **textová předpověď ČHMÚ** pro kraj, ve kterém místo leží.

Místa: Praha, Brno, Ostrava, vyhledávání libovolného místa a aktuální poloha.

## Jak to funguje

- `index.html`, `styles.css`, `app.js` – celá appka, bez build kroku.
- `scripts/fetch-chmi.ps1` – stáhne z [otevřených dat ČHMÚ](https://opendata.chmi.cz/) krajské předpovědi do `data/chmi.json`.
  ČHMÚ nepovoluje načítání přímo z prohlížeče, proto se data stahují při nasazení.
- `.github/workflows/deploy.yml` – při každém pushi a každé 2 hodiny stáhne data ČHMÚ a nasadí appku na GitHub Pages.

## Lokální spuštění

```powershell
./scripts/fetch-chmi.ps1
```

Pak složku servíruj libovolným statickým serverem (přes `file://` se data ČHMÚ nenačtou).
