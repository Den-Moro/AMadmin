# Чтение config.json агента (server_url, agent_token, poll_interval_seconds, log_level).
function Get-AgentConfig {
    param(
        [string] $Path = (Join-Path $PSScriptRoot "..\config.json")
    )

    if (-not (Test-Path $Path)) {
        throw "Конфиг не найден: $Path. Скопируйте config.example.json в config.json и заполните."
    }

    $rawText = Get-Content -Path $Path -Raw

    # Обычный JSON комментариев не поддерживает, а конфиг должен быть понятным даже без
    # отдельной документации под рукой — поэтому здесь вручную вырезаем строки вида
    # "// текст" перед разбором. Строка должна начинаться с // (после пробелов) —
    # значения вроде "http://..." внутри кавычек этим правилом не задеваются, так как
    # там // не в начале строки.
    $jsonText = ($rawText -split "`r?`n" | Where-Object { $_.TrimStart() -notmatch '^//' }) -join "`n"

    return $jsonText | ConvertFrom-Json
}
