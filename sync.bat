@echo off
REM One-click sync: runtime edition -> GitHub repo. ASCII only on purpose.
REM Double-click = sync + commit + push. Pass args like: sync.bat --dry-run
setlocal
chcp 65001 >nul
cd /d "%~dp0"

where python >nul 2>nul
if errorlevel 1 (
  echo [ERROR] Python not found. Install Python 3.10+ and add it to PATH.
  pause
  exit /b 1
)

echo ===== Personal Info Butler - local to GitHub sync =====
echo.
python sync.py %*
echo.
echo Exit code: %errorlevel%
pause
