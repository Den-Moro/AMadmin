<#
.SYNOPSIS
    Поднимает сервер AMadmin одним запуском.

.DESCRIPTION
    Два режима:
      -Mode Docker (по умолчанию, рекомендуется): нужен только Docker Desktop. Внутри
        образа nginx + PHP-FPM 8.3 с несколькими рабочими процессами — годится и для
        3000 касс. Данные (база, файлы, сессии, логи) живут на docker-томах и переживают
        пересборку. Порт — -Port (по умолчанию 8000).
      -Mode Native: без Docker, PHP ставится через winget, сервер регистрируется задачей
        планировщика «при загрузке» от SYSTEM. Работает на встроенном веб-сервере PHP,
        который на Windows обслуживает ОДИН запрос за раз — этого хватает для пилота и
        сотни касс, но не для тысяч. Для полного парка без Docker — IIS/Apache (см. docs/INSTALL.md).

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
        try { if ((Invoke-WebRequest -UseBasicParsing -Headers @{ Accept = 'text/html' } "$url/admin/login" -TimeoutSec 3).StatusCode -eq 200) { return $true } } catch { }
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
    if (-not (Wait-Server $url)) { throw "Сервер не ответил на $url/admin/login за 2 минуты. Смотрите: docker compose logs" }

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
    # Способ 1: winget. Обязательно --source winget: на многих машинах источник msstore
    # отваливается (сертификат/прокси), и без явного источника winget отказывается
    # ставить даже найденный пакет — так было на тестовой ВМ.
    if (-not $phpExe -and (Get-Command winget -ErrorAction SilentlyContinue)) {
        Write-Host 'Устанавливаю PHP 8.3 через winget...'
        Native { winget install --id PHP.PHP.8.3 -e --source winget --accept-package-agreements --accept-source-agreements } |
            Where-Object { $_ -notmatch '^\s*[-\\|/]\s*$' } | ForEach-Object { Write-Host "  $_" -ForegroundColor DarkGray }
        $phpExe = Find-Php
    }
    # Способ 2: официальный zip с windows.php.net в C:\php — без winget (его может не быть
    # на Windows Server или он сломан), нужен только доступ в интернет.
    if (-not $phpExe) {
        Write-Host 'winget не помог — скачиваю PHP 8.3 (zip) с windows.php.net в C:\php...'
        $zipUrl = 'https://windows.php.net/downloads/releases/latest/php-8.3-nts-Win32-vs16-x64-latest.zip'
        $zip = Join-Path $env:TEMP 'php83.zip'
        [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
        try {
            Invoke-WebRequest -UseBasicParsing -UserAgent 'Mozilla/5.0 AMadmin-installer' -Uri $zipUrl -OutFile $zip
            New-Item -ItemType Directory -Path 'C:\php' -Force | Out-Null
            Expand-Archive -Path $zip -DestinationPath 'C:\php' -Force
            Remove-Item $zip -Force -ErrorAction SilentlyContinue
        } catch {
            throw "Не удалось скачать PHP: $($_.Exception.Message). Скачайте zip с windows.php.net руками, распакуйте в C:\php и запустите скрипт снова."
        }
        $phpExe = Find-Php
        if (-not $phpExe) { throw 'PHP распакован, но php.exe не найден в C:\php — проверьте архив.' }
    }
    # winget кладёт в PATH только ссылку (…\WinGet\Links\php.exe), а php.ini-production и
    # папка ext\ лежат в настоящей папке пакета — раскрываем ссылку до неё.
    $phpItem = Get-Item $phpExe
    if ($phpItem.LinkType -and $phpItem.Target) {
        $resolved = @($phpItem.Target)[0]
        if ($resolved -and (Test-Path $resolved)) { $phpExe = (Resolve-Path $resolved).Path }
    }
    if (-not (Test-Path (Join-Path (Split-Path $phpExe) 'php.ini-production'))) {
        # Ссылка не раскрылась (или это другой alias) — ищем php.exe в папке пакета winget.
        $pkg = Get-ChildItem "$env:LOCALAPPDATA\Microsoft\WinGet\Packages" -Directory -Filter 'PHP.*' -ErrorAction SilentlyContinue |
            ForEach-Object { Get-ChildItem $_.FullName -Filter php.exe -Recurse -Depth 2 -ErrorAction SilentlyContinue } | Select-Object -First 1
        if ($pkg) { $phpExe = $pkg.FullName }
    }
    $phpDir = Split-Path $phpExe
    Write-Host "PHP (папка пакета): $phpDir"

    # PHP из zip требует Visual C++ Redistributable 2015-2022 (x64); без него php.exe молча
    # падает с VCRUNTIME140.dll. Проверяем по реестру и при необходимости ставим.
    $vc = Get-ItemProperty 'HKLM:\SOFTWARE\Microsoft\VisualStudio\14.0\VC\Runtimes\x64' -ErrorAction SilentlyContinue
    if (-not $vc -or -not $vc.Installed) {
        Write-Host 'Ставлю Visual C++ Redistributable (нужен PHP)...'
        $vcExe = Join-Path $env:TEMP 'vc_redist.x64.exe'
        try {
            Invoke-WebRequest -UseBasicParsing -Uri 'https://aka.ms/vs/17/release/vc_redist.x64.exe' -OutFile $vcExe
            Start-Process $vcExe -ArgumentList '/install', '/quiet', '/norestart' -Wait
        } catch { Write-Host "  не удалось поставить VC++ Redistributable автоматически: $($_.Exception.Message)" -ForegroundColor Yellow }
    }
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
        # Раньше вывод и код возврата migrate.php никак не проверялись — если он падал
        # (например на БД, оставшейся от давней версии схемы без более новых миграций),
        # ошибка проглатывалась молча и установка «успешно» доезжала до заведомо
        # нерабочего сервера. Теперь печатаем вывод и останавливаемся на ошибке —
        # тот же урок, что и с schtasks /TR выше.
        Native { & $phpExe bin/migrate.php } | ForEach-Object { Write-Host $_ }
        if ($LASTEXITCODE -ne 0) { throw "bin/migrate.php завершился с ошибкой (код $LASTEXITCODE) — смотрите вывод выше." }
        if ($Seed) {
            Native { & $phpExe bin/seed.php } | ForEach-Object { Write-Host $_ }
            if ($LASTEXITCODE -ne 0) { throw "bin/seed.php завершился с ошибкой (код $LASTEXITCODE)." }
        }

        Step 'Первый суперадмин'
        $count = Native { & $phpExe bin/count-admins.php } | Select-Object -Last 1
        if ([int]$count -eq 0) {
            $pwd = Read-AdminPassword
            Native { & $phpExe bin/create-admin.php $AdminUser $pwd superadmin } | ForEach-Object { Write-Host $_ }
            if ($LASTEXITCODE -ne 0) { throw "bin/create-admin.php завершился с ошибкой (код $LASTEXITCODE)." }
        } else { Write-Host "Учётки уже есть ($count) — пропускаю." }
    } finally { Pop-Location }

    Step "Автозапуск сервера (задача планировщика, порт $Port)"
    $isAdmin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
    if (-not $isAdmin) { throw 'Для регистрации автозапуска и правила брандмауэра запустите консоль от администратора.' }
    # ВАЖНО: не собирать команду вручную в одну строку для schtasks.exe /TR — его
    # собственный разбор этой строки ломается, если путь к проекту содержит пробел
    # (например архив с GitHub распакован в "Downloads\AMadmin-master (1)\..."):
    # /Create тихо проваливается (ненулевой код возврата, который раньше не
    # проверялся), задача не создаётся, /Run встаёт в никуда, и единственный
    # видимый симптом — таймаут в Wait-Server ниже. Register-ScheduledTask передаёт
    # программу и аргументы раздельно (обычный CreateProcess, а не самодельный
    # разбор schtasks) и с пробелами в пути работает корректно.
    $taskArgs = "-S 0.0.0.0:$Port -t `"$server\public`" `"$server\public\router.php`""
    $action = New-ScheduledTaskAction -Execute $php.Source -Argument $taskArgs
    $trigger = New-ScheduledTaskTrigger -AtStartup
    $principal = New-ScheduledTaskPrincipal -UserId 'SYSTEM' -LogonType ServiceAccount -RunLevel Highest
    Register-ScheduledTask -TaskName 'AMadmin Server' -Action $action -Trigger $trigger -Principal $principal -Force -ErrorAction Stop | Out-Null
    Native { netsh advfirewall firewall add rule name="AMadmin Server $Port" dir=in action=allow protocol=TCP localport=$Port } | Out-Null
    Start-ScheduledTask -TaskName 'AMadmin Server' -ErrorAction Stop

    $url = "http://localhost:$Port"
    if (-not (Wait-Server $url)) { throw "Сервер не ответил на $url. Проверьте: Get-ScheduledTaskInfo -TaskName 'AMadmin Server' и server\logs\app.log" }
    Write-Host 'ВНИМАНИЕ: встроенный сервер PHP на Windows обрабатывает один запрос за раз. Для пилота и до ~100 касс — нормально; для всего парка используйте режим Docker или IIS (см. docs/INSTALL.md).' -ForegroundColor Yellow
}

$ip = (Get-NetIPAddress -AddressFamily IPv4 -ErrorAction SilentlyContinue | Where-Object { $_.IPAddress -notlike '127.*' -and $_.IPAddress -notlike '169.254.*' } | Select-Object -First 1).IPAddress
Write-Host ''
Write-Host 'Сервер работает.' -ForegroundColor Green
Write-Host "  Панель:           http://localhost:$Port/admin/login"
if ($ip) { Write-Host "  Для касс (server_url): http://${ip}:$Port" }
Write-Host "  Логин:            $AdminUser (суперадмин)"
Write-Host '  Дальше: Справочники → добавить магазин; Дашборд → добавить ПК → конфиг на кассу.'
