<#
.SYNOPSIS
    Ставит агентов AMadmin на этот ПК одним запуском: копирует файлы, кладёт config.json,
    регистрирует службу управления и автозапуск окна оповещений для любого пользователя.

.DESCRIPTION
    Запускать от администратора (сам попросит повышение, если запущен без него).
    Откуда взять конфиг — любой из способов, по порядку:
      1. -ServerUrl и -Token (выдаётся в панели при добавлении ПК);
      2. -ConfigPath — путь к готовому config.json (из архива «Выгрузить конфиги»);
      3. config.json рядом с этим скриптом.
    Повторный запуск = обновление: файлы заменяются, конфиг сохраняется, служба
    переустанавливается.

.EXAMPLE
    .\install-client.ps1 -ServerUrl http://amadmin.local:8000 -Token 0123abcd...
.EXAMPLE
    .\install-client.ps1 -ConfigPath .\KASSA-05\config.json
#>
[CmdletBinding()]
param(
    [string]$ServerUrl,
    [string]$Token,
    [string]$ConfigPath,
    [string]$InstallDir = 'C:\AMadmin',
    [string]$Source = $PSScriptRoot,
    [switch]$NoStartUi
)

$ErrorActionPreference = 'Stop'

# ---- Повышение прав ----------------------------------------------------------------
$isAdmin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
if (-not $isAdmin) {
    Write-Host 'Нужны права администратора — запрашиваю повышение...' -ForegroundColor Yellow
    $args = @('-ExecutionPolicy', 'Bypass', '-File', "`"$PSCommandPath`"")
    foreach ($kv in $PSBoundParameters.GetEnumerator()) {
        if ($kv.Value -is [switch]) { if ($kv.Value) { $args += "-$($kv.Key)" } }
        else { $args += "-$($kv.Key)"; $args += "`"$($kv.Value)`"" }
    }
    Start-Process powershell.exe -Verb RunAs -ArgumentList $args -Wait
    exit
}

function Step($text) { Write-Host "== $text" -ForegroundColor Cyan }

# ---- .NET Framework 4.8 -------------------------------------------------------------
Step 'Проверка .NET Framework 4.8'
$release = (Get-ItemProperty 'HKLM:\SOFTWARE\Microsoft\NET Framework Setup\NDP\v4\Full' -ErrorAction SilentlyContinue).Release
if (-not $release -or $release -lt 528040) {
    Write-Host 'Не установлен .NET Framework 4.8. Установите его (Windows Update или ndp48-x86-x64-allos-enu.exe от Microsoft) и запустите скрипт снова.' -ForegroundColor Red
    exit 2
}

# ---- Файлы ------------------------------------------------------------------------
Step "Копирование файлов в $InstallDir"
$existingConfig = Join-Path $InstallDir 'config.json'
$keepConfig = $null
if (Test-Path $existingConfig) { $keepConfig = Get-Content $existingConfig -Raw }

# Остановить работающих агентов, иначе .exe не заменить.
$svc = Get-Service AMadminAgent -ErrorAction SilentlyContinue
if ($svc -and $svc.Status -ne 'Stopped') { Stop-Service AMadminAgent -Force -ErrorAction SilentlyContinue; Start-Sleep 2 }
Get-Process AMadmin.UiAgent, AMadmin.ManagementAgent -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue
Start-Sleep 1

New-Item -ItemType Directory -Path $InstallDir -Force | Out-Null
Get-ChildItem $Source -File | Where-Object { $_.Extension -in '.exe', '.dll', '.config', '.ps1', '.json' -and $_.Name -ne 'config.json' } |
    Copy-Item -Destination $InstallDir -Force

# ---- config.json --------------------------------------------------------------------
Step 'Конфиг'
$configText = $null
if ($ServerUrl -and $Token) {
    $configText = @"
{
    // Адрес сервера AMadmin
    "server_url": "$($ServerUrl.TrimEnd('/'))",
    // Ключ именно этого компьютера. Никому не показывайте.
    "agent_token": "$Token",
    // Как часто спрашивать сервер, секунд
    "poll_interval_seconds": 30,
    // debug | info | warning | error
    "log_level": "debug",
    // Прокси: пусто — как в Windows; иначе, например, "http://proxy.company.local:3128"
    "proxy_url": "",
    "proxy_username": "",
    "proxy_password": "",
    // Потолок скорости скачивания файлов, КБ/с. 0 — брать из настроек панели
    "download_limit_kbps": 0
}
"@
} elseif ($ConfigPath) {
    $configText = Get-Content $ConfigPath -Raw
} elseif (Test-Path (Join-Path $Source 'config.json')) {
    $configText = Get-Content (Join-Path $Source 'config.json') -Raw
} elseif ($keepConfig) {
    $configText = $keepConfig
    Write-Host 'Оставляю существующий config.json.'
} else {
    Write-Host 'Не задан конфиг: укажите -ServerUrl и -Token, или -ConfigPath, или положите config.json рядом со скриптом.' -ForegroundColor Red
    exit 3
}
[IO.File]::WriteAllText($existingConfig, $configText, (New-Object Text.UTF8Encoding $false))

# ---- Служба управления ---------------------------------------------------------------
Step 'Служба AMadminAgent (агент управления, от SYSTEM)'
& (Join-Path $InstallDir 'AMadmin.ManagementAgent.exe') --install
if ($LASTEXITCODE -ne 0) { Write-Host 'Установка службы не удалась — см. management-agent.log' -ForegroundColor Red; exit 4 }

# ---- Автозапуск окна оповещений ----------------------------------------------------------
# Задача планировщика «при входе любого пользователя», от имени вошедшего (группа Users),
# без повышения — иначе окно не будет видно в сессии кассира. XML, а не /tr: только так
# задаётся принципал «группа Users» и интерактивный токен.
Step 'Автозапуск AMadmin.UiAgent (окно оповещений, при входе любого пользователя)'
$uiExe = Join-Path $InstallDir 'AMadmin.UiAgent.exe'
$taskXml = @"
<?xml version="1.0" encoding="UTF-16"?>
<Task version="1.4" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">
  <RegistrationInfo><Description>AMadmin: окно оповещений в сессии пользователя</Description></RegistrationInfo>
  <Triggers><LogonTrigger><Enabled>true</Enabled><Delay>PT15S</Delay></LogonTrigger></Triggers>
  <Principals><Principal id="Users"><GroupId>S-1-5-32-545</GroupId><RunLevel>LeastPrivilege</RunLevel></Principal></Principals>
  <Settings>
    <MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>
    <DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>
    <StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>
    <ExecutionTimeLimit>PT0S</ExecutionTimeLimit>
    <StartWhenAvailable>true</StartWhenAvailable>
    <RestartOnFailure><Interval>PT1M</Interval><Count>999</Count></RestartOnFailure>
    <Hidden>false</Hidden>
  </Settings>
  <Actions Context="Users"><Exec><Command>$uiExe</Command><WorkingDirectory>$InstallDir</WorkingDirectory></Exec></Actions>
</Task>
"@
$xmlPath = Join-Path $env:TEMP 'amadmin-uiagent-task.xml'
[IO.File]::WriteAllText($xmlPath, $taskXml, [Text.Encoding]::Unicode)
& schtasks.exe /Create /TN 'AMadmin UiAgent' /XML $xmlPath /F | Out-Null
Remove-Item $xmlPath -Force -ErrorAction SilentlyContinue
if ($LASTEXITCODE -ne 0) { Write-Host 'Не удалось создать задачу автозапуска' -ForegroundColor Red; exit 5 }

# Запустить окно оповещений прямо сейчас — но НЕ от администратора: через explorer,
# чтобы процесс родился в обычной сессии текущего пользователя.
if (-not $NoStartUi -and [Environment]::UserInteractive) {
    Start-Process explorer.exe -ArgumentList "`"$uiExe`"" -ErrorAction SilentlyContinue
}

Write-Host ''
Write-Host 'Готово.' -ForegroundColor Green
Write-Host "  Папка:            $InstallDir"
Write-Host "  Служба:           AMadminAgent — $((Get-Service AMadminAgent).Status)"
Write-Host "  Окно оповещений:  задача 'AMadmin UiAgent' при входе пользователя"
Write-Host '  Через минуту ПК появится онлайн на дашборде. Логи: management-agent.log, ui-agent.log в папке.'
