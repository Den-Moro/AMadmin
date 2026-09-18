# Логирование агента в файл с уровнями (Debug/Info/Warning/Error) и простой ротацией
# (один .old-бэкап при превышении размера). Минимальный уровень настраивается через
# config.json (log_level) — см. Set-AgentLogLevel, вызывается один раз при старте.
# По умолчанию — Debug: пока приложение в бете, лучше больше сигнала в логах, чем
# меньше, когда баги ещё ловятся на реальных кассах, а не в проде.

$script:AgentLogLevels = @{ Debug = 10; Info = 20; Warning = 30; Error = 40 }
$script:AgentMinLogLevel = 'Debug'

# UiAgent.ps1 и ManagementAgent.ps1 — два разных процесса на одном ПК (см. AGENTS.md,
# "два агента, не один"), у каждого свой лог-файл. Путь по умолчанию ниже завязан на
# расположение самого Logger.ps1 (Core/), а не вызывающего скрипта — без явного
# Set-AgentLogPath оба агента писали бы в один и тот же ui-agent.log.
$script:AgentLogPath = Join-Path $PSScriptRoot "..\ui-agent.log"

function Set-AgentLogLevel {
    param(
        [Parameter(Mandatory)] [string] $Level
    )

    $normalized = (Get-Culture).TextInfo.ToTitleCase($Level.ToLower())
    if (-not $script:AgentLogLevels.ContainsKey($normalized)) {
        $normalized = 'Debug'
    }

    $script:AgentMinLogLevel = $normalized
}

function Set-AgentLogPath {
    param(
        [Parameter(Mandatory)] [string] $Path
    )

    $script:AgentLogPath = $Path
}

function Write-AgentLog {
    param(
        [Parameter(Mandatory)] [string] $Message,
        [ValidateSet('Debug', 'Info', 'Warning', 'Error')] [string] $Level = 'Info',
        [string] $Path = $script:AgentLogPath,
        [int] $MaxBytes = 1MB
    )

    if ($script:AgentLogLevels[$Level] -lt $script:AgentLogLevels[$script:AgentMinLogLevel]) {
        return
    }

    if ((Test-Path $Path) -and (Get-Item $Path).Length -gt $MaxBytes) {
        Move-Item -Path $Path -Destination "$Path.old" -Force
    }

    $line = "[{0}] [{1}] {2}" -f (Get-Date -Format "yyyy-MM-dd HH:mm:ss"), $Level.ToUpper(), $Message
    Add-Content -Path $Path -Value $line
}
