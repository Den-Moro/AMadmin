# ManagementAgent.ps1 — агент управления (шаг 7 плана): опрашивает сервер за командами
# и выполняет их без участия пользователя и без UI. Запускается от SYSTEM (задача в
# планировщике с опцией "выполнять вне зависимости от входа пользователя" и наивысшими
# правами) — именно поэтому это отдельный процесс от UiAgent.ps1, а не тот же самый:
# служба/задача от SYSTEM работает в Session 0 и не может показывать окна в сессии
# пользователя (см. AGENTS.md, "два агента, не один").
#
# Пока умеет только service_control (управление службами) — диспетчер задач, файлы,
# запуск скриптов добавляются по очереди отдельными шагами.

$scriptDir = $PSScriptRoot
. (Join-Path $scriptDir "..\Common\Config.ps1")
. (Join-Path $scriptDir "..\Common\Logger.ps1")
. (Join-Path $scriptDir "..\Common\ApiClient.ps1")

# Без явного включения TLS 1.2 HTTPS до сервера не поднимется на Windows 7 — там
# в .NET Framework по умолчанию он выключен.
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12

# Те же защищённые службы, что сервер уже отклоняет при создании команды (см.
# AdminCommandsController::$protectedServices) — вторая линия защиты прямо в точке
# выполнения, на случай если команда попадёт сюда в обход серверной проверки (например,
# была создана до того, как список обновили). Список нужно пересмотреть под свою
# инфраструктуру перед реальным использованием на кассах.
$ProtectedServices = @('rpcss', 'dcomlaunch', 'eventlog', 'winmgmt')

function Invoke-ServiceControlCommand {
    param(
        [Parameter(Mandatory)] $Payload
    )

    $serviceName = $Payload.service_name
    $action = $Payload.action

    if ($action -ne 'start' -and $ProtectedServices -contains $serviceName.ToLower()) {
        return @{
            Status = 'failed'
            Output = "Служба '$serviceName' в защищённом списке, действие '$action' отклонено агентом"
        }
    }

    try {
        switch ($action) {
            'start'   { Start-Service -Name $serviceName -ErrorAction Stop }
            'stop'    { Stop-Service -Name $serviceName -ErrorAction Stop }
            'restart' { Restart-Service -Name $serviceName -ErrorAction Stop }
            default   { throw "Неизвестное действие: $action" }
        }

        $state = (Get-Service -Name $serviceName).Status
        return @{ Status = 'success'; Output = "Служба '$serviceName': $action -> $state" }
    } catch {
        return @{ Status = 'failed'; Output = $_.Exception.Message }
    }
}

$config = Get-AgentConfig

Set-AgentLogPath -Path (Join-Path $scriptDir "..\management-agent.log")

$logLevel = if ($config.log_level) { $config.log_level } else { 'Debug' }
Set-AgentLogLevel -Level $logLevel

Write-AgentLog "ManagementAgent запущен (log_level=$logLevel, poll_interval=$($config.poll_interval_seconds)s)" -Level Info

while ($true) {
    try {
        Write-AgentLog "Опрос сервера: $($config.server_url)/commands" -Level Debug

        $commands = @(Get-Commands -ServerUrl $config.server_url -Token $config.agent_token)
        Write-AgentLog "Получено команд: $($commands.Count)" -Level Debug

        foreach ($command in $commands) {
            $claim = Invoke-CommandClaim -ServerUrl $config.server_url -Token $config.agent_token -CommandId $command.id

            if ($claim.status -eq 'already_claimed') {
                Write-AgentLog "Команда $($command.id) уже была застолблена ранее (статус=$($claim.existing_status)) — пропускаю" -Level Warning
                continue
            }

            Write-AgentLog "Выполняю команду id=$($command.id) type=$($command.type)" -Level Info

            $payload = $command.payload | ConvertFrom-Json

            $result = switch ($command.type) {
                'service_control' { Invoke-ServiceControlCommand -Payload $payload }
                default { @{ Status = 'failed'; Output = "Неизвестный тип команды: $($command.type)" } }
            }

            Send-CommandResult -ServerUrl $config.server_url -Token $config.agent_token -CommandId $command.id -Status $result.Status -Output $result.Output | Out-Null
            Write-AgentLog "Команда id=$($command.id) завершена: $($result.Status) — $($result.Output)" -Level Info
        }
    } catch {
        Write-AgentLog "$($_.Exception.Message)" -Level Error
    }

    Start-Sleep -Seconds $config.poll_interval_seconds
}
