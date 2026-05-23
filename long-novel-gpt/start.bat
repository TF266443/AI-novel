@echo off
title Novel Mate

cd /d "%~dp0"

echo ======================================
echo   Novel Mate v1.0.0
echo ======================================
echo.

REM Check Node.js
where node >nul 2>&1
if %ERRORLEVEL% NEQ 0 (
    echo [ERROR] Node.js not found in PATH
    echo Please install Node.js 18+ and try again
    pause
    exit /b 1
)

REM Check npm
where npm >nul 2>&1
if %ERRORLEVEL% NEQ 0 (
    echo [ERROR] npm not found in PATH
    pause
    exit /b 1
)

echo [1] Start App (Dev Mode)
echo [2] Build NSIS Installer
echo [3] Exit
echo.

set /p choice="Select (1/2/3): "

if "%choice%"=="1" goto dev
if "%choice%"=="2" goto build
if "%choice%"=="3" goto end
echo Invalid option, exiting...
goto end

:dev
echo.
echo Starting dev mode...
cmd /c npm run dev
if %ERRORLEVEL% NEQ 0 (
    echo.
    echo [ERROR] Dev mode failed to start
    echo Check that dependencies are installed: npm install
)
goto end

:build
echo.
echo Building NSIS installer...
cmd /c npm run build:release
if %ERRORLEVEL% NEQ 0 (
    echo.
    echo [ERROR] Build failed
    echo Make sure NSIS is installed: https://nsis.sourceforge.io/Download
    echo Or install via: winget install NSIS.NSIS
) else (
    echo.
    echo Build complete! Installer is in "dist\" folder
)
echo.
pause
goto end

:end
