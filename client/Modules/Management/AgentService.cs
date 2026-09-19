using System;
using System.ServiceProcess;
using System.Threading;
using System.Threading.Tasks;
using AMadmin.Core;

namespace AMadmin.ManagementAgent
{
    // Обёртка службы Windows: OnStart запускает цикл опроса в фоне, OnStop — гасит его.
    // Сам цикл в CommandLoop, чтобы тот же код без изменений работал и в --console.
    internal class AgentService : ServiceBase
    {
        private readonly string _baseDir;
        private CancellationTokenSource _cts;
        private Task _loopTask;

        public AgentService(string baseDir)
        {
            _baseDir = baseDir;
            ServiceName = Program.ServiceName;
            CanStop = true;
            CanPauseAndContinue = false;
            AutoLog = false;
        }

        protected override void OnStart(string[] args)
        {
            _cts = new CancellationTokenSource();
            CommandLoop loop;
            try
            {
                loop = Program.CreateLoop(_baseDir);
            }
            catch (Exception ex)
            {
                // Без конфига служба не имеет смысла — останавливаемся с ошибкой, чтобы
                // это было видно в services.msc, а не тихо крутился пустой процесс.
                Logger.Error("Служба не запущена: " + ex.Message);
                ExitCode = 1;
                throw;
            }

            _loopTask = Task.Run(() => loop.RunAsync(_cts.Token));
        }

        protected override void OnStop()
        {
            Logger.Info("Остановка службы запрошена");
            _cts.Cancel();
            try
            {
                // Даём текущей команде (например, скрипту) шанс дописать результат.
                _loopTask.Wait(TimeSpan.FromSeconds(20));
            }
            catch (AggregateException)
            {
                // Отмена — ожидаемое завершение задачи.
            }
            Logger.Info("ManagementAgent остановлен (служба)");
        }
    }
}
