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
    # Папка с конфигами по hostname (распакованный архив из панели или сетевая шара):
    # берётся <ConfigsDir>\<ИМЯ_ЭТОГО_ПК>\config.json. Так работает GPO-раскатка.
    [string]$ConfigsDir,
    [string]$InstallDir = 'C:\AMadmin',
    # По умолчанию — папка этого скрипта (подставляется ниже, не здесь: см. комментарий).
    [string]$Source,
    [switch]$NoStartUi,
    # Ничего не делать, если уже стоит эта же версия с этим же конфигом (для запуска
    # при каждой загрузке из GPO — обычно скрипт завершается за секунду).
    [switch]$OnlyIfChanged,
    # Без пауз и лишнего вывода; всё пишется в <InstallDir>\install.log.
    [switch]$Quiet
)
# ---- Что происходит в самом начале любого нашего скрипта ---------------------------
# 1) Консоль переводим в UTF-8: иначе русские сообщения в старом Windows PowerShell
#    превращаются в «Џа®ўҐаЄ » (cp866 против cp1251).
# 2) Снимаем со всех наших .ps1 пометку «скачано из интернета» (Zone.Identifier):
#    архив с GitHub несёт её на каждом файле, и политика RemoteSigned блокирует запуск с
#    ошибкой «is not digitally signed». Запускать через .cmd-обёртку рядом (она передаёт
#    -ExecutionPolicy Bypass) — самый простой путь; этот блок чинит и прямой запуск.
try { [Console]::OutputEncoding = [Text.Encoding]::UTF8; $OutputEncoding = [Text.Encoding]::UTF8 } catch { }
try { Get-ChildItem (Join-Path $PSScriptRoot '..') -Recurse -Filter *.ps1 -ErrorAction SilentlyContinue | Unblock-File -ErrorAction SilentlyContinue } catch { }

# Windows PowerShell 5.1 со [CmdletBinding()] оставляет $PSScriptRoot пустым в значениях
# по умолчанию param() — поэтому подставляем здесь, в теле скрипта.
if (-not $Source) { $Source = $PSScriptRoot }

$ErrorActionPreference = 'Stop'

# ---- Порядок работы скрипта --------------------------------------------------------
# 1) права администратора (или мы уже SYSTEM — из GPO/планировщика);
# 2) .NET Framework 4.8 на месте?
# 3) выбрать конфиг: -ServerUrl/-Token -> -ConfigPath -> -ConfigsDir\<hostname> ->
#    config.json рядом со скриптом -> уже установленный;
# 4) -OnlyIfChanged: если версия агента и конфиг не изменились — выйти;
# 5) остановить старых агентов, скопировать файлы, записать config.json;
# 6) служба AMadminAgent (--install), задача автозапуска окна оповещений;
# 7) запустить окно оповещений в текущей сессии (если она есть).
# -----------------------------------------------------------------------------------

# Лог установки: при раскатке через GPO консоли нет, а разбирать «почему на этой кассе
# не встало» нужно. Пишем и в консоль, и в файл.
New-Item -ItemType Directory -Path $InstallDir -Force | Out-Null
$logFile = Join-Path $InstallDir 'install.log'
function Log($text) {
    $line = '[' + (Get-Date -Format 'yyyy-MM-dd HH:mm:ss') + '] ' + $text
    try { Add-Content -Path $logFile -Value $line -Encoding UTF8 } catch { }
    if (-not $Quiet) { Write-Host $text }
}

# ---- Повышение прав ----------------------------------------------------------------
$isAdmin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
if (-not $isAdmin -and -not [Environment]::UserInteractive) {
    Log 'Нет прав администратора и нет интерактивной сессии — запросить повышение некому. Запускайте из GPO (SYSTEM) или от администратора.'
    exit 1
}
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

function Step($text) { Log "== $text" }

# ---- .NET Framework 4.8 -------------------------------------------------------------
Step 'Проверка .NET Framework 4.8'
$release = (Get-ItemProperty 'HKLM:\SOFTWARE\Microsoft\NET Framework Setup\NDP\v4\Full' -ErrorAction SilentlyContinue).Release
if (-not $release -or $release -lt 528040) {
    Log 'ОШИБКА: не установлен .NET Framework 4.8. Установите его (Windows Update или ndp48-x86-x64-allos-enu.exe от Microsoft) и запустите скрипт снова.'
    exit 2
}

# ---- Какой конфиг ставим (решаем заранее — от этого зависит, есть ли что менять) ------
$existingConfig = Join-Path $InstallDir 'config.json'
$keepConfig = $null
if (Test-Path $existingConfig) { $keepConfig = Get-Content $existingConfig -Raw }

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
} elseif ($ConfigsDir) {
    $mine = Join-Path $ConfigsDir "$env:COMPUTERNAME\config.json"
    if (Test-Path $mine) { $configText = Get-Content $mine -Raw }
    elseif ($keepConfig) { $configText = $keepConfig; Log "В $ConfigsDir нет папки $env:COMPUTERNAME — оставляю существующий конфиг." }
    else { Log "В $ConfigsDir нет конфига для $env:COMPUTERNAME — этот ПК ещё не заведён в панели. Ничего не делаю."; exit 6 }
} elseif (Test-Path (Join-Path $Source 'config.json')) {
    $configText = Get-Content (Join-Path $Source 'config.json') -Raw
} elseif ($keepConfig) {
    $configText = $keepConfig
    Log 'Оставляю существующий config.json.'
} else {
    Log 'ОШИБКА: не задан конфиг: укажите -ServerUrl и -Token, или -ConfigPath, или -ConfigsDir, или положите config.json рядом со скриптом.'
    exit 3
}

# ---- Есть ли что менять? (для запуска при каждой загрузке из GPO) -------------------
if ($OnlyIfChanged) {
    $srcExe = Join-Path $Source 'AMadmin.ManagementAgent.exe'
    $dstExe = Join-Path $InstallDir 'AMadmin.ManagementAgent.exe'
    $sameVersion = (Test-Path $dstExe) -and (Test-Path $srcExe) -and
        ((Get-Item $srcExe).VersionInfo.FileVersion -eq (Get-Item $dstExe).VersionInfo.FileVersion)
    $sameConfig = $keepConfig -and ($keepConfig.Trim() -eq $configText.Trim())
    $serviceOk = $null -ne (Get-Service AMadminAgent -ErrorAction SilentlyContinue)
    if ($sameVersion -and $sameConfig -and $serviceOk) {
        Log "Уже установлена версия $((Get-Item $dstExe).VersionInfo.FileVersion) с тем же конфигом — ничего не делаю."
        exit 0
    }
}

# ---- Файлы ------------------------------------------------------------------------
Step "Копирование файлов в $InstallDir"

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
[IO.File]::WriteAllText($existingConfig, $configText, (New-Object Text.UTF8Encoding $false))

# ---- Служба управления ---------------------------------------------------------------
Step 'Служба AMadminAgent (агент управления, от SYSTEM)'
& (Join-Path $InstallDir 'AMadmin.ManagementAgent.exe') --install
if ($LASTEXITCODE -ne 0) { Log 'ОШИБКА: установка службы не удалась — см. management-agent.log'; exit 4 }

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
if ($LASTEXITCODE -ne 0) { Log 'ОШИБКА: не удалось создать задачу автозапуска'; exit 5 }

# Запустить окно оповещений прямо сейчас, не дожидаясь следующего входа. Запускаем
# через саму задачу планировщика: она стартует процесс в сессии вошедшего пользователя
# и без прав администратора — ровно так, как будет при каждом входе. (Запуск через
# explorer.exe из повышенного процесса на Windows 11 молча не срабатывал.)
if (-not $NoStartUi -and [Environment]::UserInteractive) {
    & schtasks.exe /Run /TN 'AMadmin UiAgent' 2>&1 | Out-Null
    Start-Sleep -Seconds 3
    if (Get-Process AMadmin.UiAgent -ErrorAction SilentlyContinue) { Log 'Окно оповещений запущено (значок в трее).' }
    else { Log 'Окно оповещений запустится при следующем входе пользователя.' }
}

Log "Готово: $InstallDir, служба AMadminAgent — $((Get-Service AMadminAgent).Status), задача 'AMadmin UiAgent' при входе пользователя."
if (-not $Quiet) { Write-Host 'Через минуту ПК появится онлайн на дашборде. Логи: management-agent.log, ui-agent.log, install.log в папке.' }
