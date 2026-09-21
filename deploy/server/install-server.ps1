<#
.SYNOPSIS
    Поднимает сервер AMadmin одним запуском.

.DESCRIPTION
    Два режима:
      -Mode Docker (по умолчанию, рекомендуется): нужен только Docker Desktop. Внутри
        образа Apache + PHP 8.3 с несколькими рабочими процессами — годится и для
        3000 касс. Данные (база, файлы, сессии, логи) живут на docker-томах и переживают
        пересборку. Порт — -Port (по умолчанию 8000).
      -Mode Native: без Docker, PHP ставится через winget, сервер регистрируется задачей
        планировщика «при загрузке» от SYSTEM. Работает на встроенном веб-сервере PHP,
        который на Windows обслуживает ОДИН запрос за раз — этого хватает для пилота и
        сотни касс, но не для тысяч. Для полного парка без Docker — IIS/Apache (см. INSTALL.md).

    В обоих режимах: накатывает миграции, создаёт первого суперадмина (если учёток ещё
    нет) и печатает адрес панели.

.EXAMPLE
    .\deploy\server\install-server.ps1
.EXAMPLE
    .\deploy\server\install-server.ps1 -Mode Native -Port 8000 -AdminUser admin
#>
[CmdletBinding()]
param(
    [ValidateSet('Docker', 'Native')][string]$Mode = 'Docker',
    [int]$Port = 8000,
    [string]$AdminUser = 'admin',
    [string]$AdminPassword,
    [switch]$Seed
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


$ErrorActionPreference = 'Stop'
$root = Resolve-Path (Join-Path $PSScriptRoot '..\..')
$server = Join-Path $root 'server'

function Step($text) { Write-Host "== $text" -ForegroundColor Cyan }

# Windows PowerShell 5.1 превращает любую строку, которую docker/schtasks пишут в stderr
# (даже прогресс сборки), в ошибку при $ErrorActionPreference = 'Stop'. Поэтому внешние
# программы запускаем через эту обёртку: потоки объединяются, а успех решает $LASTEXITCODE.
function Native([scriptblock]$block) {
    $old = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    try { & $block 2>&1 | ForEach-Object { "$_" } } finally { $ErrorActionPreference = $old }
}

function Read-AdminPassword {
    if ($AdminPassword) { return $AdminPassword }
    while ($true) {
        $p1 = Read-Host "Пароль для суперадмина '$AdminUser' (не короче 8 символов)" -AsSecureString
        $p2 = Read-Host 'Ещё раз' -AsSecureString
        $s1 = [Runtime.InteropServices.Marshal]::PtrToStringAuto([Runtime.InteropServices.Marshal]::SecureStringToBSTR($p1))
        $s2 = [Runtime.InteropServices.Marshal]::PtrToStringAuto([Runtime.InteropServices.Marshal]::SecureStringToBSTR($p2))
        if ($s1.Length -lt 8) { Write-Host 'Короче 8 символов.' -ForegroundColor Yellow; continue }
        if ($s1 -ne $s2) { Write-Host 'Пароли не совпадают.' -ForegroundColor Yellow; continue }
        return $s1
    }
}

function Wait-Server($url) {
    for ($i = 0; $i -lt 60; $i++) {
        try { if ((Invoke-WebRequest -UseBasicParsing "$url/admin/login.html" -TimeoutSec 3).StatusCode -eq 200) { return $true } } catch { }
        Start-Sleep -Seconds 2
    }
    return $false
}


# ---- Порядок работы скрипта --------------------------------------------------------
# Docker-режим:  проверить Docker -> собрать и запустить контейнер -> дождаться ответа
#                панели -> (тестовые данные) -> создать первого суперадмина -> адреса.
# Native-режим:  права администратора -> найти/поставить PHP -> php.ini -> config.php и
#                миграции -> первый суперадмин -> задача автозапуска + брандмауэр -> адреса.
# -----------------------------------------------------------------------------------

if ($Mode -eq 'Native') {
    # Регистрация задачи планировщика и правило брандмауэра требуют администратора.
    # Если запущены без него — перезапускаем себя с запросом повышения (UAC).
    $isAdmin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
    if (-not $isAdmin) {
        Write-Host 'Режим Native требует прав администратора — запрашиваю повышение...' -ForegroundColor Yellow
        $args = @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', "`"$PSCommandPath`"", '-Mode', 'Native', '-Port', "$Port", '-AdminUser', "`"$AdminUser`"")
        if ($AdminPassword) { $args += @('-AdminPassword', "`"$AdminPassword`"") }
        if ($Seed) { $args += '-Seed' }
        Start-Process powershell.exe -Verb RunAs -ArgumentList $args -Wait
        exit
    }
}

# Ищем php.exe везде, куда его кладут установщики: PATH (с раскрытием %переменных%),
# папка пакета winget, C:\php, Program Files. Get-Command видит только текущий PATH
# процесса, а winget меняет PATH пользователя в реестре — в этой консоли его ещё нет.
function Find-Php {
    $cmd = Get-Command php.exe -ErrorAction SilentlyContinue
    if ($cmd) { return $cmd.Source }
    $dirs = @()
    foreach ($scope in 'User', 'Machine') {
        $raw = [Environment]::GetEnvironmentVariable('Path', $scope)
        if ($raw) { $dirs += ([Environment]::ExpandEnvironmentVariables($raw) -split ';') }
    }
    $dirs += Get-ChildItem "$env:LOCALAPPDATA\Microsoft\WinGet\Packages" -Directory -Filter 'PHP.*' -ErrorAction SilentlyContinue | Select-Object -ExpandProperty FullName
    $dirs += @("$env:LOCALAPPDATA\Microsoft\WinGet\Links", 'C:\php', "$env:ProgramFiles\PHP", "${env:ProgramFiles(x86)}\PHP", 'C:\tools\php')
    foreach ($d in $dirs | Where-Object { $_ } | Select-Object -Unique) {
        $candidate = Join-Path $d 'php.exe'
        if (Test-Path $candidate) { return (Resolve-Path $candidate).Path }
        # Пакет winget может держать php.exe во вложенной папке версии.
        $deep = Get-ChildItem $d -Filter php.exe -Recurse -Depth 2 -ErrorAction SilentlyContinue | Select-Object -First 1
        if ($deep) { return $deep.FullName }
    }
    return $null
}

if ($Mode -eq 'Docker') {
    Step 'Проверка Docker'
    if (-not (Get-Command docker -ErrorAction SilentlyContinue)) {
        throw 'Docker не найден. Установите Docker Desktop (winget install Docker.DockerDesktop), запустите его и повторите.'
    }
    Native { docker info } | Out-Null
    if ($LASTEXITCODE -ne 0) { throw 'Docker установлен, но не запущен — запустите Docker Desktop и повторите.' }

    Step "Сборка и запуск контейнера (порт $Port)"
    $env:AMADMIN_PORT = "$Port"
    Push-Location $root
    try {
        Native { docker compose --progress quiet up -d --build } | ForEach-Object { Write-Host $_ -ForegroundColor DarkGray }
        if ($LASTEXITCODE -ne 0) { throw 'docker compose up завершился с ошибкой' }
    } finally { Pop-Location }

    $url = "http://localhost:$Port"
    Step 'Ожидание сервера'
    if (-not (Wait-Server $url)) { throw "Сервер не ответил на $url/admin/login.html за 2 минуты. Смотрите: docker compose logs" }

    if ($Seed) {
        Step 'Тестовые данные (dev-seed.sql)'
        Native { docker compose -f (Join-Path $root 'docker-compose.yml') exec -T server php bin/seed.php }
    }

    Step 'Первый суперадмин'
    $count = (Native { docker compose -f (Join-Path $root 'docker-compose.yml') exec -T server php bin/count-admins.php } | Select-Object -Last 1)
    if ([int]$count -eq 0) {
        $pwd = Read-AdminPassword
        Native { docker compose -f (Join-Path $root 'docker-compose.yml') exec -T server php bin/create-admin.php $AdminUser $pwd superadmin }
    } else {
        Write-Host "Учётки уже есть ($count) — пропускаю."
    }
}
else {
    Step 'PHP'
    $phpExe = Find-Php
    if (-not $phpExe) {
        if (-not (Get-Command winget -ErrorAction SilentlyContinue)) { throw 'Нет ни php, ни winget. Установите PHP 8.x вручную (windows.php.net) и добавьте в PATH.' }
        Write-Host 'Устанавливаю PHP 8.3 через winget...'
        Native { winget install --id PHP.PHP.8.3 -e --accept-package-agreements --accept-source-agreements } | Out-Null
        $phpExe = Find-Php
        if (-not $phpExe) { throw 'winget отработал, но php.exe не найден. Установите PHP вручную с windows.php.net в C:\php и запустите скрипт снова.' }
    }
    $phpDir = Split-Path $phpExe
    # Чтобы php был виден и в этой консоли, и в новых (для задачи планировщика путь всё
    # равно берётся абсолютный, но администратору удобно вызывать php руками).
    if (($env:Path -split ';') -notcontains $phpDir) { $env:Path = "$phpDir;$env:Path" }
    $machinePath = [Environment]::GetEnvironmentVariable('Path', 'Machine')
    if (($machinePath -split ';') -notcontains $phpDir) { [Environment]::SetEnvironmentVariable('Path', "$machinePath;$phpDir", 'Machine') }
    $php = @{ Source = $phpExe }
    Write-Host "PHP: $phpExe"

    Step 'php.ini: расширения и лимиты'
    $ini = Join-Path $phpDir 'php.ini'
    if (-not (Test-Path $ini)) { Copy-Item (Join-Path $phpDir 'php.ini-production') $ini }
    $text = Get-Content $ini -Raw
    foreach ($ext in 'pdo_sqlite', 'zip', 'mbstring', 'openssl') {
        if ($text -notmatch "(?m)^\s*extension\s*=\s*$ext\s*$") { $text += "`r`nextension=$ext" }
    }
    $text = [regex]::Replace($text, '(?m)^\s*;?\s*upload_max_filesize\s*=.*$', 'upload_max_filesize = 512M')
    $text = [regex]::Replace($text, '(?m)^\s*;?\s*post_max_size\s*=.*$', 'post_max_size = 520M')
    if ($text -notmatch '(?m)^\s*extension_dir') { $text += "`r`nextension_dir = `"$phpDir\ext`"" }
    [IO.File]::WriteAllText($ini, $text)

    Step 'Конфиг и миграции'
    if (-not (Test-Path (Join-Path $server 'config.php'))) { Copy-Item (Join-Path $server 'config.example.php') (Join-Path $server 'config.php') }
    New-Item -ItemType Directory -Path (Join-Path $server 'data'), (Join-Path $server 'logs') -Force | Out-Null
    Push-Location $server
    try {
        Native { & $phpExe bin/migrate.php }
        if ($Seed) { Native { & $phpExe bin/seed.php } }

        Step 'Первый суперадмин'
        $count = Native { & $phpExe bin/count-admins.php } | Select-Object -Last 1
        if ([int]$count -eq 0) {
            $pwd = Read-AdminPassword
            Native { & $phpExe bin/create-admin.php $AdminUser $pwd superadmin }
        } else { Write-Host "Учётки уже есть ($count) — пропускаю." }
    } finally { Pop-Location }

    Step "Автозапуск сервера (задача планировщика, порт $Port)"
    $isAdmin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
    if (-not $isAdmin) { throw 'Для регистрации автозапуска и правила брандмауэра запустите консоль от администратора.' }
    $tr = "`"$($php.Source)`" -S 0.0.0.0:$Port -t `"$server\public`" `"$server\public\router.php`""
    Native { schtasks.exe /Create /TN 'AMadmin Server' /SC ONSTART /RU SYSTEM /RL HIGHEST /TR $tr /F } | Out-Null
    Native { netsh advfirewall firewall add rule name="AMadmin Server $Port" dir=in action=allow protocol=TCP localport=$Port } | Out-Null
    Native { schtasks.exe /Run /TN 'AMadmin Server' } | Out-Null

    $url = "http://localhost:$Port"
    if (-not (Wait-Server $url)) { throw "Сервер не ответил на $url. Проверьте: schtasks /Query /TN `"AMadmin Server`" и server\logs\app.log" }
    Write-Host 'ВНИМАНИЕ: встроенный сервер PHP на Windows обрабатывает один запрос за раз. Для пилота и до ~100 касс — нормально; для всего парка используйте режим Docker или IIS (см. INSTALL.md).' -ForegroundColor Yellow
}

$ip = (Get-NetIPAddress -AddressFamily IPv4 -ErrorAction SilentlyContinue | Where-Object { $_.IPAddress -notlike '127.*' -and $_.IPAddress -notlike '169.254.*' } | Select-Object -First 1).IPAddress
Write-Host ''
Write-Host 'Сервер работает.' -ForegroundColor Green
Write-Host "  Панель:           http://localhost:$Port/admin/login.html"
if ($ip) { Write-Host "  Для касс (server_url): http://${ip}:$Port" }
Write-Host "  Логин:            $AdminUser (суперадмин)"
Write-Host '  Дальше: Справочники → добавить магазин; Дашборд → добавить ПК → конфиг на кассу.'
