# Логирование агента в файл с простой ротацией (один .old-бэкап при превышении размера) —
# без этого дебаг на удалённых кассах, куда нет быстрого доступа, будет почти невозможен.
function Write-AgentLog {
    param(
        [Parameter(Mandatory)] [string] $Message,
        [string] $Path = (Join-Path $PSScriptRoot "..\ui-agent.log"),
        [int] $MaxBytes = 1MB
    )

    if ((Test-Path $Path) -and (Get-Item $Path).Length -gt $MaxBytes) {
        Move-Item -Path $Path -Destination "$Path.old" -Force
    }

    $line = "[{0}] {1}" -f (Get-Date -Format "yyyy-MM-dd HH:mm:ss"), $Message
    Add-Content -Path $Path -Value $line
}
