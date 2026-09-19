using System;
using System.Collections.Generic;
using System.Linq;
using System.Text.Json;
using System.Threading;
using System.Threading.Tasks;
using AMadmin.Core;
using AMadmin.ManagementAgent.Executors;

namespace AMadmin.ManagementAgent
{
    // Результат выполнения одной команды на этом ПК — ровно то, что уходит в
    // POST /commands/{id}/result.
    public class Outcome
    {
        public string Status;   // success | failed | timeout
        public string Output;

        public static Outcome Success(string output) { return new Outcome { Status = "success", Output = output }; }
        public static Outcome Failed(string output) { return new Outcome { Status = "failed", Output = output }; }
        public static Outcome Timeout(string output) { return new Outcome { Status = "timeout", Output = output }; }
    }

    public interface IExecutor
    {
        Task<Outcome> ExecuteAsync(JsonElement payload, CancellationToken ct);
    }

    // Главный цикл: опросить сервер -> для каждой команды claim -> выполнить -> result.
    // Тот же протокол, что описан в миграции 003_commands.sql на сервере.
    //
    // Команды выполняются по очереди, кроме загрузки файлов в асинхронном режиме
    // (настройка file_deploy_async в панели): она уходит в фон, а цикл продолжает
    // выполнять остальные команды и опрашивать сервер. Иначе один большой файл на
    // узком канале на полчаса "выключал" бы кассу для всех остальных команд.
    public class CommandLoop
    {
        private readonly AgentConfig _config;
        private readonly ApiClient _api;
        private readonly Dictionary<string, IExecutor> _executors;

        // Фоновые загрузки: следим за ними, чтобы при остановке службы дать им дописаться.
        private readonly List<Task> _background = new List<Task>();
        private readonly object _backgroundSync = new object();
        private SemaphoreSlim _parallel;
        private int _parallelLimit;

        public CommandLoop(AgentConfig config, ApiClient api)
        {
            _config = config;
            _api = api;
            _executors = new Dictionary<string, IExecutor>
            {
                { "service_control", new ServiceExecutor() },
                { "process_action",  new ProcessExecutor() },
                { "script_run",      new ScriptExecutor() },
                { "file_deploy",     new FileDeployExecutor(api, config) },
            };
        }

        public async Task RunAsync(CancellationToken ct)
        {
            while (!ct.IsCancellationRequested)
            {
                try
                {
                    await PollOnceAsync(ct);
                }
                catch (OperationCanceledException)
                {
                    break;
                }
                catch (Exception ex)
                {
                    // Сеть/сервер недоступны — это штатно для магазина, просто ждём следующий опрос.
                    Logger.Error("Опрос не удался: " + ex.Message);
                }

                try
                {
                    await Task.Delay(TimeSpan.FromSeconds(_config.PollIntervalSeconds), ct);
                }
                catch (OperationCanceledException)
                {
                    break;
                }
            }

            await WaitForBackgroundAsync(TimeSpan.FromSeconds(15));
        }

        // Дать фоновым загрузкам шанс завершиться и отчитаться (после отмены токена
        // они сами быстро завершаются с результатом "агент остановлен").
        private async Task WaitForBackgroundAsync(TimeSpan timeout)
        {
            Task[] pending;
            lock (_backgroundSync)
            {
                pending = _background.ToArray();
            }
            if (pending.Length == 0) return;

            Logger.Info("Ожидание фоновых загрузок: " + pending.Length);
            await Task.WhenAny(Task.WhenAll(pending), Task.Delay(timeout));
        }

        private async Task PollOnceAsync(CancellationToken ct)
        {
            Logger.Debug("Опрос " + _config.ServerUrl + "/commands");
            var commands = await _api.GetCommandsAsync();
            Logger.Debug("Получено команд: " + commands.Count + BackgroundSuffix());

            foreach (var command in commands)
            {
                ct.ThrowIfCancellationRequested();
                try
                {
                    await HandleAsync(command, ct);
                }
                catch (OperationCanceledException)
                {
                    throw;
                }
                catch (Exception ex)
                {
                    // Сервер отказал в claim (403: команда устарела или не нам) или сеть моргнула —
                    // одна команда не должна срывать выполнение остальных из этого опроса.
                    Logger.Error("Команда id=" + command.Id + " пропущена: " + ex.Message);
                }
            }
        }

        private string BackgroundSuffix()
        {
            lock (_backgroundSync)
            {
                _background.RemoveAll(t => t.IsCompleted);
                return _background.Count > 0 ? " (в фоне загрузок: " + _background.Count + ")" : "";
            }
        }

        private async Task HandleAsync(Command command, CancellationToken ct)
        {
            Logger.Info("Команда id=" + command.Id + " тип=" + command.Type);

            // Сначала застолбить. Если сервер говорит "уже застолблена" — значит, прошлый
            // запуск агента упал посреди выполнения. Второй раз НЕ выполняем (рестарт
            // службы или скрипт дважды — хуже, чем честное "не знаем, чем кончилось"),
            // а закрываем результатом failed, чтобы админ увидел это в панели.
            var claim = await _api.ClaimCommandAsync(command.Id);
            if (claim.Status != "claimed")
            {
                Logger.Warning("Команда id=" + command.Id + " уже была застолблена (статус " + claim.ExistingStatus + ")");
                if (claim.ExistingStatus == "in_progress")
                {
                    await SafeReport(command.Id, Outcome.Failed("Выполнение было прервано перезапуском агента; повторно не запускалось."));
                }
                return;
            }

            IExecutor executor;
            if (!_executors.TryGetValue(command.Type, out executor))
            {
                await SafeReport(command.Id, Outcome.Failed("Агент этой версии не умеет команду типа '" + command.Type + "'."));
                return;
            }

            JsonElement payload;
            using (var doc = JsonDocument.Parse(command.Payload ?? "{}"))
            {
                payload = doc.RootElement.Clone();
            }

            if (command.Type == "file_deploy" && Payload.Bool(payload, "async", true))
            {
                StartInBackground(command, executor, payload, ct);
                return;
            }

            await ExecuteAndReportAsync(command, executor, payload, ct);
        }

        private async Task ExecuteAndReportAsync(Command command, IExecutor executor, JsonElement payload, CancellationToken ct)
        {
            Outcome outcome;
            try
            {
                outcome = await executor.ExecuteAsync(payload, ct);
            }
            catch (OperationCanceledException)
            {
                await SafeReport(command.Id, Outcome.Failed("Агент остановлен во время выполнения."));
                throw;
            }
            catch (Exception ex)
            {
                Logger.Error("Команда id=" + command.Id + " упала: " + ex);
                outcome = Outcome.Failed("Ошибка агента: " + ex.Message);
            }

            Logger.Info("Команда id=" + command.Id + " -> " + outcome.Status);
            await SafeReport(command.Id, outcome);
        }

        // Загрузка файла в фоне. Число одновременных загрузок ограничено семафором —
        // предел приходит с сервера в самой команде (file_deploy_max_parallel).
        private void StartInBackground(Command command, IExecutor executor, JsonElement payload, CancellationToken ct)
        {
            var limit = Math.Max(1, Payload.Int(payload, "max_parallel", 2));
            SemaphoreSlim gate;
            lock (_backgroundSync)
            {
                // Предел могли поменять в панели; пересоздаём семафор, только когда никто
                // его не держит — иначе уже идущие загрузки потеряли бы свой слот.
                if (_parallel == null || (_parallelLimit != limit && _background.All(t => t.IsCompleted)))
                {
                    _parallel = new SemaphoreSlim(limit, limit);
                    _parallelLimit = limit;
                }
                gate = _parallel;
            }

            Logger.Info("Команда id=" + command.Id + " уходит в фон (загрузка файла, не более " + _parallelLimit + " одновременно)");

            var task = Task.Run(async () =>
            {
                await gate.WaitAsync(ct);
                try
                {
                    await ExecuteAndReportAsync(command, executor, payload, ct);
                }
                catch (OperationCanceledException)
                {
                    // Результат уже отправлен внутри ExecuteAndReportAsync.
                }
                catch (Exception ex)
                {
                    Logger.Error("Фоновая загрузка id=" + command.Id + " упала: " + ex.Message);
                }
                finally
                {
                    gate.Release();
                }
            });

            lock (_backgroundSync)
            {
                _background.Add(task);
            }
        }

        private async Task SafeReport(int commandId, Outcome outcome)
        {
            try
            {
                await _api.SendCommandResultAsync(commandId, outcome.Status, outcome.Output);
            }
            catch (Exception ex)
            {
                // Результат не доставлен — на сервере останется in_progress, при следующем
                // опросе команда уже не придёт (строка claim есть). Пишем в лог, чтобы
                // разобрать по логам "почему у этой кассы результат так и не появился".
                Logger.Error("Не удалось отправить результат команды id=" + commandId + ": " + ex.Message);
            }
        }
    }
}
