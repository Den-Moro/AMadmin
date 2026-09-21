@echo off
rem Запускает install-client.ps1 в обход политики выполнения (скрипты из скачанного архива
rem иначе блокируются как "не подписанные"). Все аргументы передаются как есть:
rem   install-client.cmd -Mode Native
chcp 65001 >nul
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0install-client.ps1" %*
if errorlevel 1 (
    echo.
    echo [install-client] завершился с ошибкой, код %errorlevel%.
)
if /i "%AMADMIN_NOPAUSE%"=="" pause
