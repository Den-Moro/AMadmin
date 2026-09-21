@echo off
rem Запускает deploy-clients.ps1 в обход политики выполнения (скрипты из скачанного архива
rem иначе блокируются как "не подписанные"). Все аргументы передаются как есть:
rem   deploy-clients.cmd -Mode Native
chcp 65001 >nul
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0deploy-clients.ps1" %*
if errorlevel 1 (
    echo.
    echo [deploy-clients] завершился с ошибкой, код %errorlevel%.
)
if /i "%AMADMIN_NOPAUSE%"=="" pause
