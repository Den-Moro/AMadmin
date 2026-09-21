@echo off
rem =====================================================================================
rem  GPO computer startup script (Computer Configuration -> Policies -> Windows Settings
rem  -> Scripts -> Startup). Runs at every boot of every till as SYSTEM.
rem
rem  What it does: takes the agent kit and this till's config.json from a network share
rem  and runs install-client.ps1 -OnlyIfChanged. Unchanged version + config -> exits in
rem  a second; new version on the share -> updates; no configs\<HOSTNAME> -> does nothing
rem  (the till is not registered in the panel yet).
rem
rem  Share layout (read access for "Domain Computers"):
rem    \SERVER\AMadmin\client\    - contents of dist\client (build-client.ps1)
rem    \SERVER\AMadmin\configs\   - unpacked "Export configs" archive from the panel
rem    \SERVER\AMadmin\AMadmin-Startup.cmd  - this file (or put it in NETLOGON)
rem  Fix the SHARE path below.
rem  NOTE: keep this file ASCII-only (see install-client.cmd).
rem =====================================================================================
set SHARE=\\SERVER\AMadmin
set AMADMIN_NOPAUSE=1

if not exist "%SHARE%\client\install-client.ps1" (
    echo AMadmin: share %SHARE% is not reachable, skipping. >> C:\AMadmin-startup.log
    exit /b 0
)

powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%SHARE%\client\install-client.ps1" ^
    -Source "%SHARE%\client" -ConfigsDir "%SHARE%\configs" -InstallDir "C:\AMadmin" -OnlyIfChanged -NoStartUi -Quiet
exit /b 0
