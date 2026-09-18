# Обработчик команд type=service_control. Вынесен из ManagementAgent.ps1 отдельным файлом
# специально: когда добавятся диспетчер задач/файлы/скрипты, каждый ляжет рядом своим
# файлом (ProcessActionHandler.ps1, FileDeployHandler.ps1, ScriptRunHandler.ps1), а не
# раздует один файл на все типы команд.

# Те же защищённые службы, что сервер уже отклоняет при создании команды (см.
# AdminCommandsController::$protectedServices) — вторая линия защиты прямо в точке
# выполнения, на случай если команда попадёт сюда в обход серверной проверки (например,
# была создана до того, как список обновили). Список нужно пересмотреть под свою
# инфраструктуру перед реальным использованием на кассах.
$script:ProtectedServices = @('rpcss', 'dcomlaunch', 'eventlog', 'winmgmt')

function Invoke-ServiceControlCommand {
    param(
        [Parameter(Mandatory)] $Payload
    )

    $serviceName = $Payload.service_name
    $action = $Payload.action

    if ($action -ne 'start' -and $script:ProtectedServices -contains $serviceName.ToLower()) {
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
