@echo off
title J3MPI Rental Manager - Web Server
cd /d "%~dp0"
echo Starting J3MPI Web Server...
echo.
echo Once started, open your browser to:
echo   This computer : http://localhost:3000
echo   Phone/Tablet  : Check the window for your local IP
echo.
where npm >nul 2>&1
if %ERRORLEVEL% EQU 0 (
    npm start
    goto done
)
if exist "C:\Program Files\nodejs\npm.cmd" (
    "C:\Program Files\nodejs\npm.cmd" start
    goto done
)
echo ERROR: Node.js not found. Please install from https://nodejs.org
pause
:done
