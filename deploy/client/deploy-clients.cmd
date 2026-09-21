@echo off
rem Runs deploy-clients.ps1 bypassing the execution policy (scripts extracted from a downloaded
rem zip are otherwise blocked as "not digitally signed"). Arguments are passed through:
rem   deploy-clients.cmd -Mode Native
rem NOTE: keep this file ASCII-only - a Cyrillic byte after "chcp 65001" breaks cmd parsing.
chcp 65001 >nul
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0deploy-clients.ps1" %*
if errorlevel 1 (
    echo.
    echo [deploy-clients] finished with error code %errorlevel%.
)
if /i "%AMADMIN_NOPAUSE%"=="" pause
