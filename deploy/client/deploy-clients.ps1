<#
.SYNOPSIS
    Массовая раскатка агентов на кассы с ПК администратора — без захода на каждую.

.DESCRIPTION
    Берёт распакованный архив конфигов из панели («Выгрузить конфиги»: папка на каждый
    hostname с config.json внутри) и комплект агентов (dist\client после build-client.ps1),
    и для каждой кассы:
      1. копирует комплект и её config.json в \\HOST\C$\AMadmin;
      2. запускает там install-client.ps1 — через WinRM (Invoke-Command), а если WinRM
         выключен — разовой задачей планировщика от SYSTEM (schtasks /S).
    Нужны права администратора на кассах (доменные или локальные, -Credential).

.EXAMPLE
    .\deploy-clients.ps1 -ConfigsDir C:\Temp\amadmin-configs
.EXAMPLE
    .\deploy-clients.ps1 -ConfigsDir C:\Temp\amadmin-configs -Hosts KASSA-01,KASSA-02 -Method Schtasks -Credential (Get-Credential)
#>
[CmdletBinding()]
param(
    [Parameter(Mandatory)][string]$ConfigsDir,
    [string]$Source = (Join-Path $PSScriptRoot '..\..\dist\client'),
    [string[]]$Hosts,
    [ValidateSet('Auto', 'WinRM', 'Schtasks')][string]$Method = 'Auto',
    [string]$RemoteDir = 'C:\AMadmin',
    [pscredential]$Credential,
    [int]$Parallel = 8
)

$ErrorActionPreference = 'Stop'
$Source = Resolve-Path $Source
if (-not (Test-Path (Join-Path $Source 'AMadmin.ManagementAgent.exe'))) {
    throw "В $Source нет агентов — сначала соберите комплект: deploy\client\build-client.ps1"
}

if (-not $Hosts) {
    $Hosts = Get-ChildItem $ConfigsDir -Directory | Where-Object { Test-Path (Join-Path $_.FullName 'config.json') } | Select-Object -ExpandProperty Name
}
if (-not $Hosts) { throw "В $ConfigsDir нет папок с config.json" }

Write-Host "Касс к раскатке: $($Hosts.Count). Комплект: $Source" -ForegroundColor Cyan

$results = [System.Collections.Concurrent.ConcurrentBag[object]]::new()

$work = {
    param($h, $ConfigsDir, $Source, $RemoteDir, $Method, $Credential)
    $r = [ordered]@{ Host = $h; Step = ''; Ok = $false; Note = '' }
    try {
        $r.Step = 'ping'
        if (-not (Test-Connection -ComputerName $h -Count 1 -Quiet)) { throw 'не отвечает' }

        $r.Step = 'copy'
        $share = "\\$h\C$\" + $RemoteDir.Substring(3)
        if ($Credential) {
            New-PSDrive -Name "D$([guid]::NewGuid().ToString('N').Substring(0,6))" -PSProvider FileSystem -Root "\\$h\C$" -Credential $Credential -Scope Script | Out-Null
        }
        New-Item -ItemType Directory -Path $share -Force | Out-Null
        Copy-Item (Join-Path $Source '*') $share -Force
        Copy-Item (Join-Path $ConfigsDir "$h\config.json") (Join-Path $share 'config.json') -Force

        $r.Step = 'install'
        $localScript = Join-Path $RemoteDir 'install-client.ps1'
        $useWinRM = $Method -eq 'WinRM' -or ($Method -eq 'Auto' -and (Test-WSMan -ComputerName $h -ErrorAction SilentlyContinue))
        if ($useWinRM) {
            $icm = @{ ComputerName = $h; ScriptBlock = { param($s, $d) & powershell.exe -ExecutionPolicy Bypass -File $s -InstallDir $d -NoStartUi } ; ArgumentList = @($localScript, $RemoteDir) }
            if ($Credential) { $icm.Credential = $Credential }
            Invoke-Command @icm | Out-Null
            $r.Note = 'WinRM'
        } else {
            # Разовая задача от SYSTEM: создать, запустить, подождать, удалить.
            $tr = "powershell.exe -ExecutionPolicy Bypass -File `"$localScript`" -InstallDir `"$RemoteDir`" -NoStartUi"
            $cred = @()
            if ($Credential) { $cred = @('/U', $Credential.UserName, '/P', $Credential.GetNetworkCredential().Password) }
            & schtasks.exe /S $h @cred /Create /TN AMadminInstall /SC ONCE /ST 00:00 /RU SYSTEM /RL HIGHEST /TR $tr /F | Out-Null
            & schtasks.exe /S $h @cred /Run /TN AMadminInstall | Out-Null
            Start-Sleep -Seconds 20
            & schtasks.exe /S $h @cred /Delete /TN AMadminInstall /F | Out-Null
            $r.Note = 'schtasks'
        }

        $r.Step = 'verify'
        $svc = Get-Service -ComputerName $h -Name AMadminAgent -ErrorAction SilentlyContinue
        if (-not $svc) { throw 'служба AMadminAgent не появилась' }
        $r.Note += ", служба $($svc.Status)"
        $r.Ok = $true
    } catch {
        $r.Note = "$($r.Step): $($_.Exception.Message)"
    }
    [pscustomobject]$r
}

# PowerShell 5.1: параллельность через фоновые задания.
$jobs = @()
foreach ($h in $Hosts) {
    while ((Get-Job -State Running).Count -ge $Parallel) { Start-Sleep -Milliseconds 300 }
    $jobs += Start-Job -ScriptBlock $work -ArgumentList $h, $ConfigsDir, $Source, $RemoteDir, $Method, $Credential
    Write-Host "  $h — запущено" -ForegroundColor DarkGray
}
$jobs | Wait-Job | Out-Null
$out = $jobs | Receive-Job
$jobs | Remove-Job

Write-Host ''
$out | Sort-Object Host | Format-Table Host, @{n = 'Результат'; e = { if ($_.Ok) { 'OK' } else { 'ОШИБКА' } } }, Note -AutoSize
$failed = @($out | Where-Object { -not $_.Ok })
Write-Host ("Успешно: {0}, с ошибкой: {1}" -f ($out.Count - $failed.Count), $failed.Count) -ForegroundColor $(if ($failed.Count) { 'Yellow' } else { 'Green' })
if ($failed.Count) { exit 1 }
