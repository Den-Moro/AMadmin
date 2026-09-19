using System;
using System.Collections.Generic;
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
    public class CommandLoop
    {
        private readonly AgentConfig _config;
        private readonly ApiClient _api;
        private readonly Dictionary<string, IExecutor> _executors;

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
        }

        private async Task PollOnceAsync(CancellationToken ct)
        {
            Logger.Debug("Опрос " + _config.ServerUrl + "/commands");
            var commands = await _api.GetCommandsAsync();
            Logger.Debug("Получено команд: " + commands.Count);

            foreach (var command in commands)
            {
                ct.ThrowIfCancellationRequested();
                await HandleAsync(command, ct);
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

            Outcome outcome;
            try
            {
                using (var doc = JsonDocument.Parse(command.Payload ?? "{}"))
                {
                    outcome = await executor.ExecuteAsync(doc.RootElement.Clone(), ct);
                }
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
