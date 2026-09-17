# UiAgent.ps1 — минимальный UI-агент (шаг 4 плана): опрашивает сервер, показывает
# оповещения WPF-окном, отправляет ack. Запускается в сессии залогиненного пользователя
# (не от SYSTEM) — служба от SYSTEM работает в Session 0 и не может показать окно
# пользователю, поэтому именно этот скрипт должен стартовать через обычный автозапуск,
# а не как служба.

$scriptDir = $PSScriptRoot
. (Join-Path $scriptDir "..\Common\Config.ps1")
. (Join-Path $scriptDir "..\Common\Logger.ps1")
. (Join-Path $scriptDir "..\Common\ApiClient.ps1")

Add-Type -AssemblyName PresentationFramework, PresentationCore, WindowsBase

# Без явного включения TLS 1.2 HTTPS до сервера не поднимется на Windows 7 — там
# в .NET Framework по умолчанию он выключен.
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12

$CloseDelaySeconds = 30

function Show-NotificationWindow {
    param(
        [Parameter(Mandatory)] $Occurrence
    )

    $xamlPath = Join-Path $scriptDir "MainWindow.xaml"
    [xml] $xaml = Get-Content -Path $xamlPath -Raw
    $reader = New-Object System.Xml.XmlNodeReader $xaml
    $window = [Windows.Markup.XamlReader]::Load($reader)

    $messageText = $window.FindName("MessageText")
    $closeButton = $window.FindName("CloseButton")

    $messageText.Text = $Occurrence.text

    $remaining = $CloseDelaySeconds
    $allowClose = $false
    $closeButton.Content = "Понятно ($remaining)"

    # Таймер обратного отсчёта: кнопка становится активной только через $CloseDelaySeconds,
    # чтобы пользователь не закрыл важное оповещение не глядя.
    $timer = New-Object System.Windows.Threading.DispatcherTimer
    $timer.Interval = [TimeSpan]::FromSeconds(1)
    $timer.Add_Tick({
        $remaining--
        if ($remaining -le 0) {
            $closeButton.IsEnabled = $true
            $closeButton.Content = "Понятно"
            $timer.Stop()
        } else {
            $closeButton.Content = "Понятно ($remaining)"
        }
    })

    # Перехватываем Closing, а не только кнопку: иначе окно можно закрыть через Alt+F4
    # или крестик в заголовке в обход таймера.
    $window.Add_Closing({
        if (-not $allowClose) {
            $_.Cancel = $true
        }
    })

    $closeButton.Add_Click({
        $allowClose = $true
        $window.Close()
    })

    $timer.Start()
    $window.ShowDialog() | Out-Null
    $timer.Stop()
}

Write-AgentLog "UiAgent запущен"

$config = Get-AgentConfig

while ($true) {
    try {
        $occurrences = Get-Occurrences -ServerUrl $config.server_url -Token $config.agent_token

        foreach ($occurrence in $occurrences) {
            Write-AgentLog "Показ оповещения occurrence_id=$($occurrence.occurrence_id)"
            Show-NotificationWindow -Occurrence $occurrence
            Send-Ack -ServerUrl $config.server_url -Token $config.agent_token -OccurrenceId $occurrence.occurrence_id
            Write-AgentLog "Ack отправлен occurrence_id=$($occurrence.occurrence_id)"
        }
    } catch {
        Write-AgentLog "ERROR: $($_.Exception.Message)"
    }

    Start-Sleep -Seconds $config.poll_interval_seconds
}
