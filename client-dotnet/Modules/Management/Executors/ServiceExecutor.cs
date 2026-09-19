using System;
using System.Linq;
using System.ServiceProcess;
using System.Text;
using System.Text.Json;
using System.Threading;
using System.Threading.Tasks;
using AMadmin.Core;

namespace AMadmin.ManagementAgent.Executors
{
    // service_control: { action: start|stop|restart|list, service_name }
    public class ServiceExecutor : IExecutor
    {
        private static readonly TimeSpan WaitFor = TimeSpan.FromSeconds(60);

        public Task<Outcome> ExecuteAsync(JsonElement payload, CancellationToken ct)
        {
            var action = Payload.Str(payload, "action");
            var name = Payload.Str(payload, "service_name");

            if (action == "list")
            {
                return Task.FromResult(List());
            }

            // Свою службу агент не трогает: остановив себя, он не сможет отчитаться.
            if (string.Equals(name, Program.ServiceName, StringComparison.OrdinalIgnoreCase) && action != "start")
            {
                return Task.FromResult(Outcome.Failed("Агент не останавливает сам себя."));
            }

            return Task.Run(() => Act(name, action), ct);
        }

        private static Outcome List()
        {
            var sb = new StringBuilder();
            var services = ServiceController.GetServices().OrderBy(s => s.ServiceName, StringComparer.OrdinalIgnoreCase);
            sb.AppendLine("STATUS      NAME                            DISPLAY NAME");
            foreach (var s in services)
            {
                sb.AppendLine(s.Status.ToString().PadRight(12) + s.ServiceName.PadRight(32) + s.DisplayName);
                s.Dispose();
            }
            return Outcome.Success(sb.ToString());
        }

        private static Outcome Act(string name, string action)
        {
            using (var sc = new ServiceController(name))
            {
                ServiceControllerStatus before;
                try
                {
                    before = sc.Status;
                }
                catch (InvalidOperationException)
                {
                    return Outcome.Failed("Служба '" + name + "' не найдена на этом ПК.");
                }

                Logger.Info("Служба " + name + ": " + action + " (сейчас " + before + ")");

                try
                {
                    switch (action)
                    {
                        case "start":
                            if (before == ServiceControllerStatus.Running)
                                return Outcome.Success("Уже запущена.");
                            sc.Start();
                            sc.WaitForStatus(ServiceControllerStatus.Running, WaitFor);
                            return Outcome.Success("Запущена (было " + before + ").");

                        case "stop":
                            if (before == ServiceControllerStatus.Stopped)
                                return Outcome.Success("Уже остановлена.");
                            if (!sc.CanStop)
                                return Outcome.Failed("Служба не разрешает остановку (CanStop=false).");
                            sc.Stop();
                            sc.WaitForStatus(ServiceControllerStatus.Stopped, WaitFor);
                            return Outcome.Success("Остановлена (было " + before + ").");

                        case "restart":
                            if (before != ServiceControllerStatus.Stopped)
                            {
                                if (!sc.CanStop)
                                    return Outcome.Failed("Служба не разрешает остановку (CanStop=false).");
                                sc.Stop();
                                sc.WaitForStatus(ServiceControllerStatus.Stopped, WaitFor);
                            }
                            sc.Start();
                            sc.WaitForStatus(ServiceControllerStatus.Running, WaitFor);
                            return Outcome.Success("Перезапущена (было " + before + ").");

                        default:
                            return Outcome.Failed("Неизвестное действие '" + action + "'.");
                    }
                }
                catch (System.ServiceProcess.TimeoutException)
                {
                    sc.Refresh();
                    return Outcome.Timeout("Служба не перешла в нужное состояние за " + WaitFor.TotalSeconds + " с (сейчас " + sc.Status + ").");
                }
                catch (Exception ex)
                {
                    return Outcome.Failed(ex.Message + (ex.InnerException != null ? " — " + ex.InnerException.Message : ""));
                }
            }
        }
    }
}
