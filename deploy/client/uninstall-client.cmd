@echo off
rem Runs uninstall-client.ps1 bypassing the execution policy (scripts extracted from a downloaded
rem zip are otherwise blocked as "not digitally signed"). Arguments are passed through:
rem   uninstall-client.cmd -KeepConfig
rem NOTE: keep this file ASCII-only - a Cyrillic byte after "chcp 65001" breaks cmd parsing.
rem UTF-8 console only on Windows 10/11: on Windows 7 cmd.exe misreads the rest of a
rem batch file after "chcp 65001", and its console shows Russian fine without it.
ver | find " 10." >nul && chcp 65001 >nul
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0uninstall-client.ps1" %*
if errorlevel 1 (
    echo.
    echo [uninstall-client] finished with error code %errorlevel%.
)
if /i "%AMADMIN_NOPAUSE%"=="" pause
