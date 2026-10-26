@echo off
cd /d "%~dp0"
echo GoalPulse - Python + FastAPI backend
echo Open http://127.0.0.1:4173 in your browser.
echo Keep this window open while using GoalPulse. Press Ctrl+C to stop.
if not exist .venv\Scripts\python.exe (
  echo Creating Python virtual environment...
  python -m venv .venv
  if errorlevel 1 goto no_python
)
.venv\Scripts\python.exe -m pip install -r requirements.txt
if errorlevel 1 goto install_failed
.venv\Scripts\python.exe run_backend.py
pause
exit /b 0
:no_python
echo Python command failed. Confirm python --version works and install Python 3.11 or newer if needed.
pause
exit /b 1
:install_failed
echo Could not install backend dependencies. Check your internet connection and Python installation.
pause
exit /b 1
