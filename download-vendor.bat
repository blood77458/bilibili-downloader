@echo off
echo ============================================
echo  Downloading ffmpeg.wasm deps (vendor/)
echo ============================================
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0download-vendor.ps1"
echo.
pause
