# Обёртка над Invoke-RestMethod: GET забирает список активных оповещений для этого ПК,
# POST подтверждает конкретное оповещение (occurrence). Токен всегда идёт заголовком
# Authorization — не в URL, иначе он оседает в логах.

function Get-Occurrences {
    param(
        [Parameter(Mandatory)] [string] $ServerUrl,
        [Parameter(Mandatory)] [string] $Token
    )

    $headers = @{ Authorization = "Bearer $Token" }

    # GET ничего не отправляет в теле — сервер сам понимает "кто спрашивает" по токену
    # и возвращает JSON-массив оповещений. Оборачиваем в @(...): если сервер вернёт ровно
    # один элемент, PowerShell без этого отдаст не массив, а один объект, и foreach ниже
    # по коду обработал бы не список оповещений, а его отдельные поля.
    return @(Invoke-RestMethod -Uri "$ServerUrl/occurrences" -Method Get -Headers $headers)
}

function Send-Ack {
    param(
        [Parameter(Mandatory)] [string] $ServerUrl,
        [Parameter(Mandatory)] [string] $Token,
        [Parameter(Mandatory)] [int] $OccurrenceId,
        [bool] $Reacted = $false
    )

    $headers = @{ Authorization = "Bearer $Token" }
    # POST, в отличие от GET, отправляет тело запроса — здесь это необязательный флаг
    # "reacted" (явное "я выполнил", а не просто закрытие окна). occurrence_id — прямо
    # в адресе (.../occurrences/5/ack), а не в теле, т.к. это адрес конкретного ресурса.
    $body = @{ reacted = $Reacted } | ConvertTo-Json

    Invoke-RestMethod -Uri "$ServerUrl/occurrences/$OccurrenceId/ack" -Method Post -Headers $headers -Body $body -ContentType "application/json"
}
