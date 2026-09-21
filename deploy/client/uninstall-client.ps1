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
# ---- Что происходит в самом начале любого нашего скрипта ---------------------------
# 1) Консоль переводим в UTF-8: иначе русские сообщения в старом Windows PowerShell
#    превращаются в «Џа®ўҐаЄ » (cp866 против cp1251).
# 2) Снимаем со всех наших .ps1 пометку «скачано из интернета» (Zone.Identifier):
#    архив с GitHub несёт её на каждом файле, и политика RemoteSigned блокирует запуск с
#    ошибкой «is not digitally signed». Запускать через .cmd-обёртку рядом (она передаёт
#    -ExecutionPolicy Bypass) — самый простой путь; этот блок чинит и прямой запуск.
try { [Console]::OutputEncoding = [Text.Encoding]::UTF8; $OutputEncoding = [Text.Encoding]::UTF8 } catch { }
try { Get-ChildItem (Join-Path $PSScriptRoot '..') -Recurse -Filter *.ps1 -ErrorAction SilentlyContinue | Unblock-File -ErrorAction SilentlyContinue } catch { }


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
