@echo off
REM Personal Info Butler - Local Offline Edition (Windows launcher)
REM All content is ASCII on purpose: avoids codepage corruption on Chinese paths.
setlocal
cd /d "%~dp0"

where python >nul 2>nul
if errorlevel 1 (
  echo [ERROR] Python not found. Install Python 3.10+ from https://www.python.org/
  echo Remember to check "Add Python to PATH" during installation.
  pause
  exit /b 1
)

python -c "import flask" >nul 2>nul
if errorlevel 1 (
  echo [SETUP] Installing the only dependency: Flask ...
  python -m pip install -r requirements.txt
  if errorlevel 1 (
    echo [ERROR] Failed to install Flask. Check your network or use a mirror.
    pause
    exit /b 1
  )
)

echo Starting local server at http://127.0.0.1:8771/
echo Press Ctrl+C in this window to stop. Your notes stay in data/pia.db
python server.py --open-browser
pause
