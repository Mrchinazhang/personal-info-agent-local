@echo off
setlocal
cd /d "%~dp0"
title PIA stop

echo [STOP] Ending scheduled task "PIA-Local-Server" ...
schtasks /end /tn "PIA-Local-Server" >nul 2>&1

for /f "tokens=5" %%a in ('netstat -ano ^| findstr ":8771" ^| findstr LISTENING') do (
  echo [KILL] PID %%a
  taskkill /f /pid %%a >nul 2>&1
)

ping -n 2 127.0.0.1 >nul
netstat -ano | findstr ":8771" | findstr LISTENING >nul
if errorlevel 1 (echo [OK] Server stopped.) else (echo [WARN] Port 8771 still listening.)
echo.
pause
endlocal
