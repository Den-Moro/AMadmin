using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Linq;
using System.Text;
using System.Text.Json;
using System.Threading;
using System.Threading.Tasks;
using AMadmin.Core;

namespace AMadmin.ManagementAgent.Executors
{
    // process_action: { action: kill|list, process_name?, pid? }
    public class ProcessExecutor : IExecutor
    {
        // Вторая линия защиты помимо списка в настройках сервера: даже если на сервере
        // список случайно очистят, эти процессы агент не тронет. Без них падает сама
        // Windows или сессия пользователя (и сам агент).
        private static readonly HashSet<string> NeverKill = new HashSet<string>(StringComparer.OrdinalIgnoreCase)
        {
            "system", "idle", "smss", "csrss", "wininit", "winlogon", "services", "lsass", "svchost", "dwm",
            "explorer", "amadmin.managementagent", "amadmin.uiagent",
        };

        public Task<Outcome> ExecuteAsync(JsonElement payload, CancellationToken ct)
        {
            var action = Payload.Str(payload, "action");
            if (action == "list")
            {
                return Task.FromResult(List());
            }

            var name = Payload.Str(payload, "process_name").Trim();
            if (name.EndsWith(".exe", StringComparison.OrdinalIgnoreCase)) name = name.Substring(0, name.Length - 4);
            var pid = Payload.Int(payload, "pid");

            return Task.FromResult(Kill(name, pid));
        }

        private static Outcome List()
        {
            var sb = new StringBuilder();
            sb.AppendLine("PID     MEM(MB)  NAME");
            foreach (var p in Process.GetProcesses().OrderBy(p => p.ProcessName, StringComparer.OrdinalIgnoreCase))
            {
                long mb = 0;
                try { mb = p.WorkingSet64 / 1024 / 1024; } catch { }
                sb.AppendLine(p.Id.ToString().PadRight(8) + mb.ToString().PadRight(9) + p.ProcessName);
                p.Dispose();
            }
            return Outcome.Success(sb.ToString());
        }

        private static Outcome Kill(string name, int pid)
        {
            var targets = new List<Process>();

            if (pid > 0)
            {
                try
                {
                    var p = Process.GetProcessById(pid);
                    // Если задано и имя, и PID — имя обязано совпасть: PID мог уже
                    // достаться другому процессу, а мы не хотим убить "кого-то".
                    if (name != "" && !string.Equals(p.ProcessName, name, StringComparison.OrdinalIgnoreCase))
                    {
                        return Outcome.Failed("PID " + pid + " сейчас принадлежит процессу '" + p.ProcessName + "', а не '" + name + "' — не трогаю.");
                    }
                    targets.Add(p);
                }
                catch (ArgumentException)
                {
                    return Outcome.Success("Процесса с PID " + pid + " уже нет.");
                }
            }
            else
            {
                targets.AddRange(Process.GetProcessesByName(name));
                if (targets.Count == 0)
                {
                    return Outcome.Success("Процесс '" + name + "' не запущен — нечего завершать.");
                }
            }

            var self = Process.GetCurrentProcess().Id;
            var sb = new StringBuilder();
            var killed = 0;
            var failed = 0;

            foreach (var p in targets)
            {
                if (p.Id == self || NeverKill.Contains(p.ProcessName))
                {
                    sb.AppendLine("PID " + p.Id + " " + p.ProcessName + ": защищён, пропущен");
                    failed++;
                    continue;
                }
                try
                {
                    p.Kill();
                    p.WaitForExit(5000);
                    sb.AppendLine("PID " + p.Id + " " + p.ProcessName + ": завершён");
                    killed++;
                    Logger.Info("Процесс завершён: " + p.ProcessName + " pid=" + p.Id);
                }
                catch (Exception ex)
                {
                    sb.AppendLine("PID " + p.Id + " " + p.ProcessName + ": ошибка — " + ex.Message);
                    failed++;
                }
                finally
                {
                    p.Dispose();
                }
            }

            var summary = "Завершено: " + killed + ", не удалось: " + failed + "\n" + sb;
            return killed > 0 && failed == 0 ? Outcome.Success(summary) : Outcome.Failed(summary);
        }
    }
}
