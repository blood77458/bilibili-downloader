# Download ffmpeg.wasm core into vendor/ (run once).
# Usage: double-click download-vendor.bat, or run:
#   powershell -NoProfile -ExecutionPolicy Bypass -File download-vendor.ps1
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $MyInvocation.MyCommand.Path
$dest = Join-Path $root 'vendor'
New-Item -ItemType Directory -Force -Path $dest | Out-Null

$targets = @(
  @{
    name = 'ffmpeg-core.js'
    urls = @(
      'https://registry.npmmirror.com/@ffmpeg/core/0.12.6/files/dist/umd/ffmpeg-core.js',
      'https://cdn.jsdelivr.net/npm/@ffmpeg/core@0.12.6/dist/umd/ffmpeg-core.js',
      'https://unpkg.com/@ffmpeg/core@0.12.6/dist/umd/ffmpeg-core.js'
    )
  },
  @{
    name = 'ffmpeg-core.wasm'
    urls = @(
      'https://registry.npmmirror.com/@ffmpeg/core/0.12.6/files/dist/umd/ffmpeg-core.wasm',
      'https://cdn.jsdelivr.net/npm/@ffmpeg/core@0.12.6/dist/umd/ffmpeg-core.wasm',
      'https://unpkg.com/@ffmpeg/core@0.12.6/dist/umd/ffmpeg-core.wasm'
    )
  }
)

foreach ($t in $targets) {
  $ok = $false
  foreach ($u in $t.urls) {
    $out = Join-Path $dest $t.name
    Write-Host ("Downloading {0} ..." -f $t.name) -NoNewline
    try {
      Invoke-WebRequest -Uri $u -OutFile $out -UseBasicParsing -TimeoutSec 180
      if ((Test-Path $out) -and (Get-Item $out).Length -gt 1000) {
        Write-Host (" OK ({0:N0} bytes)" -f (Get-Item $out).Length) -ForegroundColor Green
        $ok = $true
        break
      } else {
        Write-Host " too small, trying next mirror"
      }
    } catch {
      Write-Host (" failed: " + $_.Exception.Message)
    }
  }
  if (-not $ok) {
    Write-Host ("[FAILED] " + $t.name) -ForegroundColor Red
    Write-Host ("         Download manually into: " + $out) -ForegroundColor Red
    Write-Host ("         URL: " + $t.urls[0]) -ForegroundColor Red
  }
}

Write-Host ""
Write-Host "vendor/ contents:" -ForegroundColor Cyan
if (Test-Path $dest) {
  Get-ChildItem -Path $dest -File | ForEach-Object {
    Write-Host ("  {0}  {1:N0} bytes" -f $_.Name, $_.Length)
  }
}

Write-Host ""
Write-Host "Done. Then click the refresh button for the extension at chrome://extensions." -ForegroundColor Cyan
