@echo off
rem Запускает build-client.ps1 в обход политики выполнения (скрипты из скачанного архива
rem иначе блокируются как "не подписанные"). Все аргументы передаются как есть:
rem   build-client.cmd -Mode Native
chcp 65001 >nul
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0build-client.ps1" %*
if errorlevel 1 (
    echo.
    echo [build-client] завершился с ошибкой, код %errorlevel%.
)
if /i "%AMADMIN_NOPAUSE%"=="" pause
