# Чтение config.json агента (server_url, agent_token, poll_interval_seconds).
function Get-AgentConfig {
    param(
        [string] $Path = (Join-Path $PSScriptRoot "..\config.json")
    )

    if (-not (Test-Path $Path)) {
        throw "Конфиг не найден: $Path. Скопируйте config.example.json в config.json и заполните."
    }

    return Get-Content -Path $Path -Raw | ConvertFrom-Json
}
