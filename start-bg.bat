@echo off
setlocal
cd /d "%~dp0"
title PIA launcher

set "PY=D:\pychonProject\python.exe"
set "PYW=D:\pychonProject\pythonw.exe"
set "TASK=PIA-Local-Server"
set "URL=http://127.0.0.1:8771/"

if not exist "%PY%" goto nopython

call :isup
if not errorlevel 1 goto already

echo [START] Starting local server (windowless, via scheduled task) ...
schtasks /run /tn "%TASK%" >nul 2>&1
call :waitup
if not errorlevel 1 goto ok

echo [WARN] Scheduled task unavailable, starting pythonw directly ...
if not exist "data" mkdir "data"
start "" "%PYW%" server.py
call :waitup
if not errorlevel 1 goto ok
goto failed

:already
echo.
echo [INFO] Already running at %URL%
goto open

:ok
echo.
echo [OK] Running at %URL%
echo [INFO] Windowless: served by scheduled task "%TASK%", auto-starts at logon.
echo [INFO] Stop it with stop-server.bat ; log: data\server.log
goto open

:open
start "" "%URL%"
goto end

:nopython
echo.
echo [ERROR] Python not found at %PY%
echo Edit this file and point it to your own python.exe
goto end

:failed
echo.
echo [WARN] Port 8771 is still not listening.
echo        Starting in foreground so you can read the error message:
"%PY%" server.py
goto end

:end
echo.
pause
endlocal
exit /b 0

:isup
netstat -ano | findstr ":8771" | findstr LISTENING >nul
if errorlevel 1 exit /b 1
exit /b 0

:waitup
for /l %%i in (1,1,12) do (
  ping -n 2 127.0.0.1 >nul
  call :isup
  if not errorlevel 1 exit /b 0
)
exit /b 1
