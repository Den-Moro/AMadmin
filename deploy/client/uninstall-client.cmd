@echo off
rem Runs uninstall-client.ps1 bypassing the execution policy (scripts extracted from a downloaded
rem zip are otherwise blocked as "not digitally signed"). Arguments are passed through:
rem   uninstall-client.cmd -Mode Native
rem NOTE: keep this file ASCII-only - a Cyrillic byte after "chcp 65001" breaks cmd parsing.
chcp 65001 >nul
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0uninstall-client.ps1" %*
if errorlevel 1 (
    echo.
    echo [uninstall-client] finished with error code %errorlevel%.
)
if /i "%AMADMIN_NOPAUSE%"=="" pause
