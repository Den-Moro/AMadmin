<#
.SYNOPSIS
    Массовая раскатка агентов на кассы с ПК администратора — без захода на каждую.

.DESCRIPTION
    Берёт распакованный архив конфигов из панели («Выгрузить конфиги»: папка на каждый
    hostname с config.json внутри) и комплект агентов (dist\client после build-client.ps1),
    и для каждой кассы:
      1. копирует комплект и её config.json в \\HOST\C$\AMadmin\setup;
      2. запускает оттуда install-client.ps1 — через WinRM (Invoke-Command), а если WinRM
         выключен — разовой задачей планировщика от SYSTEM (schtasks /S); установщик
         останавливает агентов, раскладывает файлы в C:\AMadmin и запускает их снова;
      3. ждёт, пока установщик допишет итог в C:\AMadmin\install.log кассы, показывает его
         и удаляет setup.
    Повторный запуск на тех же кассах безопасен — это обновление.
    Нужны права администратора на кассах (доменные или локальные, -Credential).
    Работает и в PowerShell 2.0 (Windows 7 из коробки).

.EXAMPLE
    .\deploy-clients.ps1 -ConfigsDir C:\Temp\amadmin-configs
.EXAMPLE
    .\deploy-clients.ps1 -ConfigsDir C:\Temp\amadmin-configs -Hosts KASSA-01,KASSA-02 -Method Schtasks -Credential (Get-Credential)
#>
[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)][string]$ConfigsDir,
    # По умолчанию — dist\client этого репозитория (подставляется ниже, в теле скрипта).
    [string]$Source,
    [string[]]$Hosts,
    [ValidateSet('Auto', 'WinRM', 'Schtasks')][string]$Method = 'Auto',
    [string]$RemoteDir = 'C:\AMadmin',
    [System.Management.Automation.PSCredential]$Credential,
    [int]$Parallel = 8
)
# ---- Что происходит в самом начале любого нашего скрипта ---------------------------
# Скрипт обязан работать и в PowerShell 2.0 — он стоит в Windows 7 из коробки. Поэтому
# здесь нет конструкций 3.0+: [Parameter(Mandatory)] без "= $true", $PSScriptRoot,
# Get-Content -Raw, Get-ChildItem -File/-Directory, -in, [ordered], [pscustomobject].
# 1) Папка скрипта: $PSScriptRoot в PowerShell 2.0 бывает только в модулях.
# 2) Консоль переводим в UTF-8: иначе русские сообщения в Windows PowerShell 5.1
#    превращаются в «Џа®ўҐаЄ » (cp866 против cp1251). Только на Windows 10/11: консоль
#    Windows 7 в UTF-8 работает плохо, а русский текст там и так виден нормально.
# 3) Снимаем со всех наших .ps1 пометку «скачано из интернета» (Zone.Identifier):
#    архив с GitHub несёт её на каждом файле, и политика RemoteSigned блокирует запуск с
#    ошибкой «is not digitally signed». Запускать через .cmd-обёртку рядом (она передаёт
#    -ExecutionPolicy Bypass) — самый простой путь; этот блок чинит и прямой запуск
#    (Unblock-File есть с PowerShell 3.0; в 2.0 — только через .cmd).
$ScriptPath = $MyInvocation.MyCommand.Path
$ScriptDir = Split-Path -Parent $ScriptPath
if ([Environment]::OSVersion.Version.Major -ge 10) {
    try { [Console]::OutputEncoding = [Text.Encoding]::UTF8; $OutputEncoding = [Text.Encoding]::UTF8 } catch { }
}
if (Get-Command Unblock-File -ErrorAction SilentlyContinue) {
    try { Get-ChildItem (Join-Path $ScriptDir '..') -Recurse -Filter *.ps1 -ErrorAction SilentlyContinue | Unblock-File -ErrorAction SilentlyContinue } catch { }
}


$ErrorActionPreference = 'Stop'
if (-not $Source) { $Source = Join-Path $ScriptDir '..\..\dist\client' }
if (-not (Test-Path (Join-Path $Source 'AMadmin.ManagementAgent.exe'))) {
    throw "В $Source нет агентов. Комплект собирается на ПК с Windows 10/11 и .NET SDK 8 (deploy\client\build-client.ps1); скопируйте папку dist\client сюда или укажите её через -Source."
}
if (-not (Test-Path $ConfigsDir)) { throw "Нет папки $ConfigsDir — распакуйте туда архив «Выгрузить конфиги» из панели." }
# Полные пути: фоновые задания стартуют в другой текущей папке, относительный путь там
# указывал бы не туда.
$Source = (Resolve-Path $Source).ProviderPath
$ConfigsDir = (Resolve-Path $ConfigsDir).ProviderPath

if ($Hosts) {
    $Hosts = @($Hosts)
} else {
    $Hosts = @(Get-ChildItem $ConfigsDir | Where-Object { $_.PSIsContainer -and (Test-Path (Join-Path $_.FullName 'config.json')) } | ForEach-Object { $_.Name })
}
if ($Hosts.Count -eq 0) { throw "В $ConfigsDir нет папок с config.json" }

Write-Host "Касс к раскатке: $($Hosts.Count). Комплект: $Source" -ForegroundColor Cyan

$work = {
    param($h, $ConfigsDir, $Source, $RemoteDir, $Method, $Credential)
    # Задание — отдельный процесс PowerShell: настройки основного скрипта сюда не доходят.
    $ErrorActionPreference = 'Stop'
    $r = @{ Host = $h; Step = ''; Ok = $false; Note = '' }
    $unc = "\\$h\C$"
    $connected = $false
    $stage = $null
    # Запуск net.exe/schtasks.exe: их предупреждения в stderr (например, schtasks /Create
    # всегда пишет «время /ST уже прошло») при 'Stop' стали бы исключением. Решает код
    # возврата; текст вывода — для сообщения об ошибке.
    function Native([string]$exe, [string[]]$argv) {
        $ErrorActionPreference = 'Continue'
        $o = & $exe @argv 2>&1
        New-Object PSObject -Property @{ Code = $LASTEXITCODE; Text = ((@($o) | ForEach-Object { "$_".Trim() } | Where-Object { $_ }) -join ' ') }
    }
    try {
        $r.Step = 'ping'
        if (-not (Test-Connection -ComputerName $h -Count 1 -Quiet)) { throw 'не отвечает' }

        $r.Step = 'copy'
        if ($Credential) {
            # Подключаемся к админ-шаре под указанной учёткой. net use, а не New-PSDrive
            # -Credential: в PowerShell 2.0 файловая система учётные данные не принимает.
            $n = Native net.exe @('use', $unc, $Credential.GetNetworkCredential().Password, "/user:$($Credential.UserName)")
            if ($n.Code -ne 0) { throw "нет доступа к $unc — $($n.Text)" }
            $connected = $true
        }
        # Комплект — во вложенную папку setup, а не прямо к агентам: при переустановке их
        # .exe/.dll заняты работающими агентами («файл используется другим процессом»).
        # Установщик сам остановит агентов и разложит файлы из setup.
        $share = "$unc\" + $RemoteDir.Substring(3)
        $stage = "$share\setup"
        New-Item -ItemType Directory -Path $stage -Force | Out-Null
        Copy-Item (Join-Path $Source '*') $stage -Force
        Copy-Item (Join-Path $ConfigsDir "$h\config.json") (Join-Path $stage 'config.json') -Force

        # Итог установки читаем из install.log кассы — только то, что допишется после этой точки.
        $log = Join-Path $share 'install.log'
        $before = 0
        if (Test-Path $log) { $before = (Get-Item $log).Length }

        $r.Step = 'install'
        $localScript = Join-Path $RemoteDir 'setup\install-client.ps1'
        $localConfig = Join-Path $RemoteDir 'setup\config.json'
        # Auto: WinRM, если он отвечает, иначе планировщик. Test-WSMan при выключенном WinRM
        # (на Windows 7 он выключен по умолчанию) не возвращает «нет», а бросает исключение.
        $useWinRM = $Method -eq 'WinRM'
        if ($Method -eq 'Auto') {
            try { $useWinRM = [bool](Test-WSMan -ComputerName $h -ErrorAction Stop) } catch { $useWinRM = $false }
        }
        if ($useWinRM) {
            $icm = @{ ComputerName = $h; ScriptBlock = { param($s, $d, $c) & powershell.exe -NoProfile -ExecutionPolicy Bypass -File $s -InstallDir $d -ConfigPath $c -Quiet }; ArgumentList = @($localScript, $RemoteDir, $localConfig) }
            if ($Credential) { $icm.Credential = $Credential }
            Invoke-Command @icm | Out-Null
            $r.Note = 'WinRM'
        } else {
            # Разовая задача от SYSTEM: создать, запустить, дождаться итога, удалить.
            $tr = "powershell.exe -NoProfile -ExecutionPolicy Bypass -File `"$localScript`" -InstallDir `"$RemoteDir`" -ConfigPath `"$localConfig`" -Quiet"
            $cred = @()
            if ($Credential) { $cred = @('/U', $Credential.UserName, '/P', $Credential.GetNetworkCredential().Password) }
            $n = Native schtasks.exe (@('/S', $h) + $cred + @('/Create', '/TN', 'AMadminInstall', '/SC', 'ONCE', '/ST', '00:00', '/RU', 'SYSTEM', '/RL', 'HIGHEST', '/TR', $tr, '/F'))
            if ($n.Code -ne 0) { throw "не удалось создать задачу планировщика — $($n.Text)" }
            $n = Native schtasks.exe (@('/S', $h) + $cred + @('/Run', '/TN', 'AMadminInstall'))
            if ($n.Code -ne 0) { throw "не удалось запустить задачу планировщика — $($n.Text)" }
            $r.Note = 'schtasks'
        }

        # Ждём итог в install.log (через WinRM он уже есть; задача планировщика идёт сама по
        # себе — на медленной кассе с Windows 7 это бывает и минута).
        $r.Step = 'verify'
        $tail = ''
        $finished = $false
        $deadline = (Get-Date).AddMinutes(3)
        while (-not $finished -and (Get-Date) -lt $deadline) {
            try {
                $bytes = [IO.File]::ReadAllBytes($log)
                if ($bytes.Length -gt $before) { $tail = [Text.Encoding]::UTF8.GetString($bytes, $before, $bytes.Length - $before) }
            } catch { }
            $finished = $tail -match 'Готово:|Уже установлена|ОШИБКА|Ничего не делаю|Нет прав'
            if (-not $finished) { Start-Sleep -Seconds 5 }
        }
        if (-not $useWinRM) { Native schtasks.exe (@('/S', $h) + $cred + @('/Delete', '/TN', 'AMadminInstall', '/F')) | Out-Null }
        # Установщик закончил — копия комплекта с ключом кассы больше не нужна.
        if ($finished) { Remove-Item $stage -Recurse -Force -ErrorAction SilentlyContinue }

        $lines = @($tail -split "`r?`n" | Where-Object { $_.Trim() })
        $bad = @($lines | Where-Object { $_ -match 'ОШИБКА|Ничего не делаю|Нет прав' })
        if ($bad.Count) { throw (($bad[-1] -replace '^\[[^\]]*\]\s*', '')) }
        if (-not ($tail -match 'Готово:|Уже установлена')) { throw "установщик не закончил за 3 минуты — смотрите $RemoteDir\install.log на кассе" }

        $svc = Get-Service -ComputerName $h -Name AMadminAgent -ErrorAction SilentlyContinue
        if (-not $svc) { throw 'служба AMadminAgent не появилась' }
        $r.Note += ", служба $($svc.Status)"
        $r.Ok = $true
    } catch {
        $r.Note = "$($r.Step): $($_.Exception.Message)"
        # Установщик так и не запустился — убрать копию комплекта с ключом кассы.
        if ($r.Step -eq 'install' -and $stage) { Remove-Item $stage -Recurse -Force -ErrorAction SilentlyContinue }
    } finally {
        if ($connected) { Native net.exe @('use', $unc, '/delete', '/y') | Out-Null }
    }
    New-Object PSObject -Property $r
}

# Параллельность через фоновые задания (есть и в PowerShell 2.0).
$jobs = @()
foreach ($h in $Hosts) {
    while (@(Get-Job | Where-Object { $_.State -eq 'Running' }).Count -ge $Parallel) { Start-Sleep -Milliseconds 300 }
    $jobs += Start-Job -ScriptBlock $work -ArgumentList $h, $ConfigsDir, $Source, $RemoteDir, $Method, $Credential
    Write-Host "  $h — запущено" -ForegroundColor DarkGray
}
$jobs | Wait-Job | Out-Null
$out = @($jobs | Receive-Job)
$jobs | Remove-Job

Write-Host ''
$out | Sort-Object Host | Format-Table Host, @{ Label = 'Результат'; Expression = { if ($_.Ok) { 'OK' } else { 'ОШИБКА' } } }, Note -AutoSize
$failed = @($out | Where-Object { -not $_.Ok })
Write-Host ("Успешно: {0}, с ошибкой: {1}" -f ($out.Count - $failed.Count), $failed.Count) -ForegroundColor $(if ($failed.Count) { 'Yellow' } else { 'Green' })
if ($failed.Count) { exit 1 }
