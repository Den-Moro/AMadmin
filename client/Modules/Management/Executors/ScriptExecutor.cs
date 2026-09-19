using System;
using System.Diagnostics;
using System.IO;
using System.Text;
using System.Text.Json;
using System.Threading;
using System.Threading.Tasks;
using AMadmin.Core;

namespace AMadmin.ManagementAgent.Executors
{
    // script_run: { engine: powershell|cmd, script?, path?, args, timeout_seconds }
    // Синхронный запуск с таймаутом; stdout/stderr/код возврата — в результат.
    public class ScriptExecutor : IExecutor
    {
        public async Task<Outcome> ExecuteAsync(JsonElement payload, CancellationToken ct)
        {
            var engine = Payload.Str(payload, "engine", "powershell");
            var script = Payload.Str(payload, "script", null);
            var path = Payload.Str(payload, "path", null);
            var args = Payload.Str(payload, "args");
            var timeout = Math.Max(1, Math.Min(600, Payload.Int(payload, "timeout_seconds", 60)));

            string tempFile = null;
            string fileName;
            string arguments;

            if (!string.IsNullOrWhiteSpace(script))
            {
                // Текст скрипта — во временный файл: так и многострочные скрипты, и кавычки
                // передаются без экранирования через командную строку.
                tempFile = Path.Combine(Path.GetTempPath(), "amadmin-" + Guid.NewGuid().ToString("N") + (engine == "cmd" ? ".cmd" : ".ps1"));
                if (engine == "cmd")
                {
                    // .cmd: cmd.exe читает файл в OEM-кодировке (cp866 на русской Windows) и НЕ
                    // понимает BOM — с BOM первая строка "@echo off" ломается и в вывод
                    // сыплются сами команды. Поэтому: OEM, без BOM.
                    File.WriteAllText(tempFile, script, OemEncoding);
                }
                else
                {
                    // .ps1: наоборот, BOM обязателен — без него PowerShell 5.1 читает файл как
                    // ANSI и русский текст в скрипте превращается в кракозябры.
                    File.WriteAllText(tempFile, script, new UTF8Encoding(true));
                }
                path = tempFile;
                args = "";
            }
            else if (string.IsNullOrWhiteSpace(path))
            {
                return Outcome.Failed("В команде нет ни текста скрипта, ни пути.");
            }
            else if (!File.Exists(path))
            {
                return Outcome.Failed("Файл не найден на этом ПК: " + path);
            }

            var ext = Path.GetExtension(path).ToLowerInvariant();
            if (engine == "powershell" && (ext == ".ps1" || tempFile != null))
            {
                fileName = "powershell.exe";
                // -ExecutionPolicy Bypass — только для этого запуска, политика на ПК не меняется.
                arguments = "-NoProfile -NonInteractive -ExecutionPolicy Bypass -File \"" + path + "\" " + args;
            }
            else if (ext == ".cmd" || ext == ".bat")
            {
                fileName = "cmd.exe";
                arguments = "/c \"\"" + path + "\" " + args + "\"";
            }
            else
            {
                // Обычная программа (.exe и т.п.) — запускаем как есть.
                fileName = path;
                arguments = args;
            }

            Logger.Info("Запуск: " + fileName + " " + arguments + " (таймаут " + timeout + " с)");

            try
            {
                return await RunAsync(fileName, arguments, timeout, ct);
            }
            finally
            {
                if (tempFile != null)
                {
                    try { File.Delete(tempFile); } catch { }
                }
            }
        }

        private static async Task<Outcome> RunAsync(string fileName, string arguments, int timeoutSeconds, CancellationToken ct)
        {
            var psi = new ProcessStartInfo(fileName, arguments)
            {
                UseShellExecute = false,
                RedirectStandardOutput = true,
                RedirectStandardError = true,
                CreateNoWindow = true,
                // Консольные программы Windows (cmd, ipconfig, PowerShell 5.1 при перенаправлении)
                // пишут в OEM-кодировке, а не в UTF-8 — читаем так же, иначе русский вывод
                // приходит в панель кракозябрами.
                StandardOutputEncoding = OemEncoding,
                StandardErrorEncoding = OemEncoding,
            };
            var stdout = new StringBuilder();
            var stderr = new StringBuilder();

            using (var p = new Process { StartInfo = psi })
            {
                p.OutputDataReceived += (s, e) => { if (e.Data != null) stdout.AppendLine(e.Data); };
                p.ErrorDataReceived += (s, e) => { if (e.Data != null) stderr.AppendLine(e.Data); };

                try
                {
                    p.Start();
                }
                catch (Exception ex)
                {
                    return Outcome.Failed("Не удалось запустить '" + fileName + "': " + ex.Message);
                }
                p.BeginOutputReadLine();
                p.BeginErrorReadLine();

                var exited = await Task.Run(() => p.WaitForExit(timeoutSeconds * 1000), ct);

                if (!exited)
                {
                    KillTree(p.Id);
                    Logger.Warning("Скрипт убит по таймауту " + timeoutSeconds + " с");
                    return Outcome.Timeout(Format(-1, stdout, stderr) + "\n[убит по таймауту " + timeoutSeconds + " с]");
                }

                p.WaitForExit(); // дочитать асинхронные потоки вывода до конца
                var text = Format(p.ExitCode, stdout, stderr);
                return p.ExitCode == 0 ? Outcome.Success(text) : Outcome.Failed(text);
            }
        }

        [System.Runtime.InteropServices.DllImport("kernel32.dll")]
        private static extern int GetOEMCP();

        // OEM-кодировка этой Windows (866 для русской). Console.OutputEncoding в службе без
        // консоли ненадёжен, поэтому спрашиваем систему напрямую.
        private static readonly Encoding OemEncoding = SafeOem();

        private static Encoding SafeOem()
        {
            try { return Encoding.GetEncoding(GetOEMCP()); }
            catch { return Encoding.Default; }
        }

        private static string Format(int exitCode, StringBuilder stdout, StringBuilder stderr)
        {
            var sb = new StringBuilder();
            sb.AppendLine("exit code: " + exitCode);
            if (stdout.Length > 0) { sb.AppendLine("--- stdout ---"); sb.Append(stdout); }
            if (stderr.Length > 0) { sb.AppendLine("--- stderr ---"); sb.Append(stderr); }
            return sb.ToString();
        }

        // Убиваем вместе с потомками: у powershell.exe/cmd.exe процессы-дети иначе
        // остаются висеть после таймаута.
        private static void KillTree(int pid)
        {
            try
            {
                var psi = new ProcessStartInfo("taskkill.exe", "/T /F /PID " + pid)
                {
                    UseShellExecute = false, CreateNoWindow = true, RedirectStandardOutput = true, RedirectStandardError = true,
                };
                using (var k = Process.Start(psi)) { k.WaitForExit(10000); }
            }
            catch (Exception ex)
            {
                Logger.Error("taskkill не сработал: " + ex.Message);
            }
        }
    }
}
