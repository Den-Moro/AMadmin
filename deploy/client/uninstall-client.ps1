<#
.SYNOPSIS
    Полностью убирает агентов AMadmin с этого ПК: службу, автозапуск, файлы.

.EXAMPLE
    .\uninstall-client.ps1            # удалить всё
    .\uninstall-client.ps1 -KeepConfig # оставить config.json (ключ) для переустановки
#>
[CmdletBinding()]
param(
    [string]$InstallDir = 'C:\AMadmin',
    [switch]$KeepConfig
)

$ErrorActionPreference = 'Continue'
$isAdmin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
if (-not $isAdmin) {
    $args = @('-ExecutionPolicy', 'Bypass', '-File', "`"$PSCommandPath`"", '-InstallDir', "`"$InstallDir`"")
    if ($KeepConfig) { $args += '-KeepConfig' }
    Start-Process powershell.exe -Verb RunAs -ArgumentList $args -Wait
    exit
}

Write-Host '== Остановка и удаление службы' -ForegroundColor Cyan
$exe = Join-Path $InstallDir 'AMadmin.ManagementAgent.exe'
if (Test-Path $exe) { & $exe --uninstall } else { sc.exe stop AMadminAgent | Out-Null; sc.exe delete AMadminAgent | Out-Null }

Write-Host '== Удаление автозапуска окна оповещений' -ForegroundColor Cyan
schtasks.exe /Delete /TN 'AMadmin UiAgent' /F 2>$null | Out-Null
Get-Process AMadmin.UiAgent, AMadmin.ManagementAgent -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue

Write-Host "== Удаление файлов из $InstallDir" -ForegroundColor Cyan
if (Test-Path $InstallDir) {
    Get-ChildItem $InstallDir -File | Where-Object { -not ($KeepConfig -and $_.Name -eq 'config.json') } | Remove-Item -Force
    if (-not $KeepConfig) { Remove-Item $InstallDir -Recurse -Force -ErrorAction SilentlyContinue }
}
Write-Host 'Готово. Запись о ПК на сервере остаётся — удалите её в панели, если ПК выведен из парка.' -ForegroundColor Green
