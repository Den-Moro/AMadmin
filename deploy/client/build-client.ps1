<#
.SYNOPSIS
    Собирает оба агента (Release) и складывает готовый к раскатке комплект в dist\client.

.DESCRIPTION
    Запускать на машине сборки (нужен .NET SDK 8). На кассах SDK не нужен — только
    .NET Framework 4.8. Результат:
      dist\client\                — папка, которую целиком копируют на кассу
      dist\AMadmin-client-<версия>.zip — то же самое архивом

.EXAMPLE
    .\deploy\client\build-client.ps1
#>
[CmdletBinding()]
param(
    [string]$Configuration = 'Release'
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
$client = Join-Path $root 'client'
$dist = Join-Path $root 'dist\client'

if (-not (Get-Command dotnet -ErrorAction SilentlyContinue)) {
    throw 'Не найден dotnet. Установите .NET SDK 8: winget install Microsoft.DotNet.SDK.8'
}

Write-Host '== Сборка UiAgent и ManagementAgent ==' -ForegroundColor Cyan
& dotnet build (Join-Path $client 'Modules\Notifications\AMadmin.UiAgent.csproj') -c $Configuration --nologo -v q
if ($LASTEXITCODE -ne 0) { throw 'Сборка UiAgent не удалась' }
& dotnet build (Join-Path $client 'Modules\Management\AMadmin.ManagementAgent.csproj') -c $Configuration --nologo -v q
if ($LASTEXITCODE -ne 0) { throw 'Сборка ManagementAgent не удалась' }

Write-Host '== Сборка комплекта dist\client ==' -ForegroundColor Cyan
if (Test-Path $dist) { Remove-Item $dist -Recurse -Force }
New-Item -ItemType Directory -Path $dist | Out-Null

foreach ($module in @('Modules\Notifications', 'Modules\Management')) {
    $out = Join-Path $client "$module\bin\$Configuration\net48"
    # Всё, кроме отладочных .pdb и локального config.json (ключ конкретной машины сборки).
    Get-ChildItem $out -File | Where-Object { $_.Extension -ne '.pdb' -and $_.Name -ne 'config.json' -and $_.Name -notlike '*.log*' } |
        Copy-Item -Destination $dist -Force
}

# Установщик кладём рядом — на кассе достаточно этой папки и config.json.
foreach ($f in 'install-client.ps1', 'install-client.cmd', 'uninstall-client.ps1', 'uninstall-client.cmd') {
    Copy-Item (Join-Path $PSScriptRoot $f) $dist -Force
}
# Стартовый скрипт для GPO — тоже в комплект: на шаре он лежит рядом с client\.
Copy-Item (Join-Path $PSScriptRoot 'gpo\AMadmin-Startup.cmd') (Join-Path $dist '..\AMadmin-Startup.cmd') -Force

$version = (Get-Item (Join-Path $dist 'AMadmin.ManagementAgent.exe')).VersionInfo.FileVersion
$zip = Join-Path $root "dist\AMadmin-client-$version.zip"
if (Test-Path $zip) { Remove-Item $zip -Force }
Compress-Archive -Path (Join-Path $dist '*') -DestinationPath $zip

Write-Host ''
Write-Host "Готово: $dist" -ForegroundColor Green
Write-Host "Архив:  $zip" -ForegroundColor Green
Write-Host 'Дальше: положите в папку config.json кассы (из панели) и запустите install-client.ps1 от администратора,'
Write-Host 'либо раскатайте на все кассы сразу: deploy\client\deploy-clients.ps1 -ConfigsDir <распакованный архив конфигов>.'
