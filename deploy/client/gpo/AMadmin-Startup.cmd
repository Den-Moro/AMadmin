@echo off
rem =====================================================================================
rem  Стартовый скрипт для GPO (Computer Configuration -> Policies -> Windows Settings ->
rem  Scripts -> Startup). Запускается при загрузке каждой кассы от SYSTEM.
rem
rem  Что делает: берёт комплект агентов и config.json этой кассы с сетевой папки и
rem  запускает install-client.ps1 -OnlyIfChanged. Если версия и конфиг не менялись -
rem  выходит за секунду; если на шаре новая версия - обновляет; если кассы нет в
rem  configs\<HOSTNAME> - ничего не ставит (касса ещё не заведена в панели).
rem
rem  Раскладка на шаре (доступ на чтение для "Domain Computers"):
rem    \сервер\AMadmin\client\    - содержимое dist\client (build-client.ps1)
rem    \сервер\AMadmin\configs\   - распакованный архив "Выгрузить конфиги" из панели
rem    \сервер\AMadmin\AMadmin-Startup.cmd  - этот файл (или положите в NETLOGON)
rem  Путь к шаре ниже поправьте под себя.
rem =====================================================================================
set SHARE=\\SERVER\AMadmin
set AMADMIN_NOPAUSE=1

if not exist "%SHARE%\client\install-client.ps1" (
    echo AMadmin: шара %SHARE% недоступна, пропускаю. >> C:\AMadmin-startup.log
    exit /b 0
)

powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%SHARE%\client\install-client.ps1" ^
    -Source "%SHARE%\client" -ConfigsDir "%SHARE%\configs" -InstallDir "C:\AMadmin" -OnlyIfChanged -NoStartUi -Quiet
exit /b 0
