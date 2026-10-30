# Stáhne aktuální textové předpovědi ČHMÚ pro kraje a uloží je do data/chmi.json.
# Běží v GitHub Actions (pwsh) i lokálně ve Windows PowerShell 5.1.
param([string]$OutFile = (Join-Path $PSScriptRoot '..\data\chmi.json'))

$ErrorActionPreference = 'Stop'
$base = 'https://opendata.chmi.cz/meteorology/weather/forecast/now/'
$client = New-Object System.Net.WebClient
$client.Encoding = [System.Text.Encoding]::UTF8
$client.Headers.Add('User-Agent', 'App-Weather-checker (github.com/sharpest777/App-Weather-checker)')

# CK0 = dnes, CKn = noc, CK1 = zítra, CK2–CK4 = další dny
$kinds = @{ 'CK0' = 0; 'CKn' = 1; 'CK1' = 2; 'CK2' = 3; 'CK3' = 4; 'CK4' = 5 }

# Z výpisu adresáře vybere u každé dvojice (kraj, druh předpovědi) nejnovější soubor
$listing = $client.DownloadString($base)
$pattern = 'href="(web_p(CK[0-4n])tx_(RP[A-Z]{2})_\d{6}(?:_[A-Z]{3})?\.json)">[^<]*</a>\s+(\d{2}-\w{3}-\d{4} \d{2}:\d{2})'
$latest = @{}
foreach ($m in [regex]::Matches($listing, $pattern)) {
    $key = $m.Groups[3].Value + '|' + $m.Groups[2].Value
    $time = [datetime]::ParseExact($m.Groups[4].Value, 'dd-MMM-yyyy HH:mm', [Globalization.CultureInfo]::InvariantCulture)
    if (-not $latest.ContainsKey($key) -or $latest[$key].Time -lt $time) {
        $latest[$key] = @{ File = $m.Groups[1].Value; Time = $time; Kind = $m.Groups[2].Value; Region = $m.Groups[3].Value }
    }
}
if ($latest.Count -eq 0) { throw 'Ve výpisu ČHMÚ nebyl nalezen žádný soubor s předpovědí.' }

# Zjednoduší hranice kraje: souřadnice zaokrouhlí na 2 desetinná místa (~1 km)
# a vynechá body, které po zaokrouhlení splynou s předchozím. Pro určení kraje to stačí.
function Round-Coords($node) {
    $isRing = $node[0] -is [array] -and -not ($node[0][0] -is [array])
    $out = @()
    if ($isRing) {
        $prev = ''
        foreach ($pt in $node) {
            $x = [math]::Round([double]$pt[0], 2); $y = [math]::Round([double]$pt[1], 2)
            if ("$x,$y" -ne $prev) { $out += , @($x, $y); $prev = "$x,$y" }
        }
    } else {
        foreach ($child in $node) { $out += , (Round-Coords $child) }
    }
    return , $out
}

$regions = @{}
foreach ($entry in $latest.Values) {
    $doc = $client.DownloadString($base + $entry.File) | ConvertFrom-Json
    $feature = $doc.data.features[0]
    $p = $feature.properties

    if (-not $regions.ContainsKey($entry.Region)) {
        $regions[$entry.Region] = @{
            code      = $entry.Region
            name      = $p.place.name
            geometry  = @{ type = $feature.geometry.type; coordinates = (Round-Coords $feature.geometry.coordinates) }
            forecasts = @()
        }
    }

    $items = @()
    foreach ($d in ($p.data | Sort-Object displayOrder)) {
        $items += , @{ name = $d.name; headline = $d.headline; text = $d.displayText }
    }
    $regions[$entry.Region].forecasts += , @{
        kind     = $entry.Kind
        order    = $kinds[$entry.Kind]
        headline = $p.'headline-main'.headline
        start    = $p.'headline-main'.startTime
        end      = $p.'headline-main'.endTime
        sent     = $p.sent
        author   = $p.senderName
        items    = $items
    }
}

foreach ($r in $regions.Values) {
    $r.forecasts = @($r.forecasts | Sort-Object { $_.order })
}

$result = @{
    updated = (Get-Date).ToUniversalTime().ToString('yyyy-MM-ddTHH:mm:ssZ')
    source  = $base
    regions = @($regions.Values | Sort-Object { $_.code })
}

$dir = Split-Path $OutFile -Parent
if (-not (Test-Path $dir)) { New-Item -ItemType Directory -Path $dir | Out-Null }
$json = ConvertTo-Json -InputObject $result -Depth 12 -Compress
[System.IO.File]::WriteAllText([System.IO.Path]::GetFullPath($OutFile), $json, (New-Object System.Text.UTF8Encoding $false))
Write-Host "Uloženo $($regions.Count) krajů do $OutFile"
