using System;
using System.Diagnostics;
using System.IO;
using System.Reflection;
using System.ServiceProcess;
using System.Threading;
using AMadmin.Core;

namespace AMadmin.ManagementAgent
{
    // Точка входа агента управления. Три режима:
    //   без параметров  — запуск как служба Windows (так его стартует система);
    //   --console       — тот же цикл, но в окне консоли, для отладки руками;
    //   --install / --uninstall — регистрация/снятие службы через sc.exe (нужны права
    //                     администратора — агент проверяет это сам и подсказывает).
    internal static class Program
    {
        public const string ServiceName = "AMadminAgent";
        private const string DisplayName = "AMadmin Management Agent";

        private static int Main(string[] args)
        {
            var baseDir = AppDomain.CurrentDomain.BaseDirectory;
            Logger.Path = Path.Combine(baseDir, "management-agent.log");

            var mode = args.Length > 0 ? args[0].ToLowerInvariant() : "";

            if ((mode == "--install" || mode == "--uninstall") && !IsAdministrator())
            {
                Console.Error.WriteLine("Нужны права администратора: запустите консоль «от имени администратора» и повторите.");
                return 2;
            }

            switch (mode)
            {
                case "--install":
                    return Install(baseDir);
                case "--uninstall":
                    return Uninstall();
                case "--console":
                    return RunConsole(baseDir);
                default:
                    ServiceBase.Run(new AgentService(baseDir));
                    return 0;
            }
        }

        // Общий старт для службы и консоли: конфиг, лог, цикл опроса.
        public static CommandLoop CreateLoop(string baseDir)
        {
            var version = Assembly.GetExecutingAssembly().GetName().Version.ToString(3);
            var config = AgentConfig.Load(Path.Combine(baseDir, "config.json"));

            Logger.SetLevel(config.LogLevel);
            Logger.Info("ManagementAgent " + version + " запущен (сервер " + config.ServerUrl +
                        ", опрос каждые " + config.PollIntervalSeconds + "с, log_level=" + config.LogLevel +
                        ", пользователь " + Environment.UserName + ")");

            return new CommandLoop(config, new ApiClient(config, version), baseDir);
        }

        private static int RunConsole(string baseDir)
        {
            Console.OutputEncoding = System.Text.Encoding.UTF8;
            Console.WriteLine("AMadmin ManagementAgent — консольный режим. Ctrl+C для выхода. Лог: management-agent.log");
            if (!IsAdministrator())
            {
                Console.WriteLine("Внимание: консоль не от администратора — команды со службами и системными процессами будут падать с «отказано в доступе».");
            }

            CommandLoop loop;
            try
            {
                loop = CreateLoop(baseDir);
            }
            catch (Exception ex)
            {
                Console.Error.WriteLine(ex.Message);
                Logger.Error(ex.Message);
                return 1;
            }

            var cts = new CancellationTokenSource();
            Console.CancelKeyPress += (s, e) => { e.Cancel = true; cts.Cancel(); };
            loop.RunAsync(cts.Token).GetAwaiter().GetResult();
            Logger.Info("ManagementAgent остановлен (консоль)");
            return 0;
        }

        private static int Install(string baseDir)
        {
            var exe = Path.Combine(baseDir, "AMadmin.ManagementAgent.exe");

            // Повторный --install (обновление агента поверх старого) — штатный случай:
            // останавливаем и снимаем старую регистрацию, потом создаём заново.
            if (Sc("query " + ServiceName) == 0)
            {
                Console.WriteLine("Служба " + ServiceName + " уже есть — переустанавливаю.");
                Sc("stop " + ServiceName);
                Thread.Sleep(2000);
                Sc("delete " + ServiceName);
                Thread.Sleep(1000);
            }

            // sc.exe требует пробел после "=" — это не опечатка.
            var create = Sc("create " + ServiceName + " binPath= \"" + exe + "\" start= auto DisplayName= \"" + DisplayName + "\"");
            if (create != 0) return create;
            Sc("description " + ServiceName + " \"Выполняет команды администратора из панели AMadmin (службы, процессы, скрипты, файлы).\"");
            // Автоперезапуск при падении: через 10 с, три попытки, счётчик сбрасывается раз в сутки.
            Sc("failure " + ServiceName + " reset= 86400 actions= restart/10000/restart/10000/restart/10000");
            var start = Sc("start " + ServiceName);
            Logger.Info("Служба " + ServiceName + " установлена и запущена (exe " + exe + ")");
            Console.WriteLine("Готово: служба " + ServiceName + " установлена" + (start == 0 ? " и запущена." : ", но не запустилась — смотрите management-agent.log."));
            return 0;
        }

        private static int Uninstall()
        {
            Sc("stop " + ServiceName);
            var rc = Sc("delete " + ServiceName);
            Logger.Info("Служба " + ServiceName + " удалена (код " + rc + ")");
            Console.WriteLine(rc == 0 ? "Служба " + ServiceName + " удалена." : "Не удалось удалить службу (код " + rc + ").");
            return rc;
        }

        private static bool IsAdministrator()
        {
            using (var identity = System.Security.Principal.WindowsIdentity.GetCurrent())
            {
                return new System.Security.Principal.WindowsPrincipal(identity)
                    .IsInRole(System.Security.Principal.WindowsBuiltInRole.Administrator);
            }
        }

        private static int Sc(string arguments)
        {
            var psi = new ProcessStartInfo("sc.exe", arguments)
            {
                UseShellExecute = false,
                RedirectStandardOutput = true,
                RedirectStandardError = true,
                CreateNoWindow = true,
            };
            using (var p = Process.Start(psi))
            {
                var output = p.StandardOutput.ReadToEnd() + p.StandardError.ReadToEnd();
                p.WaitForExit();
                Logger.Debug("sc " + arguments + " -> " + p.ExitCode + " " + output.Trim());
                if (p.ExitCode != 0) Console.WriteLine(output.Trim());
                return p.ExitCode;
            }
        }
    }
}
