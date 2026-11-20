@echo off
rem Starts the AGHAT SETHU backend on this laptop and publishes it at
rem https://krishnagumaste.taila639bc.ts.net (Tailscale Funnel). Close this window to stop the backend.
cd /d "%~dp0"

"C:\Program Files\Tailscale\tailscale.exe" funnel --bg 8000
if errorlevel 1 (
  echo Could not turn on Tailscale Funnel. Is Tailscale running and signed in?
  pause
  exit /b 1
)

echo.
echo AGHAT SETHU backend: https://krishnagumaste.taila639bc.ts.net
echo App download page:   https://krishnagumaste.taila639bc.ts.net/download
echo Press Ctrl+C or close this window to stop.
echo.
backend\.venv\Scripts\python.exe -m uvicorn backend.main:app --host 127.0.0.1 --port 8000 --env-file backend/.env --proxy-headers --forwarded-allow-ips 127.0.0.1
pause
