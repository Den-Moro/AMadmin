using System;
using System.IO;
using System.Security.Cryptography;
using System.Text.Json;
using System.Threading;
using System.Threading.Tasks;
using AMadmin.Core;

namespace AMadmin.ManagementAgent.Executors
{
    // file_deploy: { file_id, original_name, sha256, size, target_path }
    // Порядок: сравнить хеш -> скачать во временный файл рядом (с проверкой хеша) ->
    // старый файл в .bak -> переименовать временный в целевой. Целевой файл ни в один
    // момент не бывает "наполовину записан".
    public class FileDeployExecutor : IExecutor
    {
        private readonly ApiClient _api;
        private readonly AgentConfig _config;

        public FileDeployExecutor(ApiClient api, AgentConfig config)
        {
            _api = api;
            _config = config;
        }

        public async Task<Outcome> ExecuteAsync(JsonElement payload, CancellationToken ct)
        {
            var fileId = Payload.Int(payload, "file_id");
            var expected = Payload.Str(payload, "sha256").ToLowerInvariant();
            var target = Payload.Str(payload, "target_path");
            var size = Payload.Int(payload, "size");

            if (fileId <= 0 || expected == "" || target == "")
            {
                return Outcome.Failed("В команде нет file_id, sha256 или target_path.");
            }

            if (File.Exists(target))
            {
                var local = Sha256Of(target);
                if (local == expected)
                {
                    Logger.Info("Файл " + target + " уже актуален (хеш совпал), скачивание пропущено");
                    return Outcome.Success("Пропущено: файл уже актуален, хеш совпадает.");
                }
                Logger.Debug("Хеш отличается: локальный " + local + ", нужен " + expected);
            }

            var dir = Path.GetDirectoryName(target);
            if (!string.IsNullOrEmpty(dir) && !Directory.Exists(dir))
            {
                Directory.CreateDirectory(dir);
            }

            // Лимит скорости: ненулевое значение в config.json этой кассы важнее общего
            // из панели (file_deploy_limit_kbps) — так магазину с узким каналом можно
            // поставить свой, не трогая остальных.
            var limitKbps = _config.DownloadLimitKbps > 0 ? _config.DownloadLimitKbps : Payload.Int(payload, "limit_kbps", 0);

            var temp = target + ".amadmin-download";
            var started = DateTime.UtcNow;
            try
            {
                Logger.Info("Скачивание файла id=" + fileId + " (" + size + " байт" +
                            (limitKbps > 0 ? ", не быстрее " + limitKbps + " КБ/с" : "") + ")");
                await _api.DownloadFileAsync(fileId, temp, expected, limitKbps, ct);
            }
            catch (OperationCanceledException)
            {
                try { File.Delete(temp); } catch { }
                throw;
            }
            catch (Exception ex)
            {
                try { File.Delete(temp); } catch { }
                return Outcome.Failed("Скачивание не удалось: " + ex.Message);
            }
            var seconds = (DateTime.UtcNow - started).TotalSeconds;

            string backup = null;
            if (File.Exists(target))
            {
                // Копия старого файла рядом, с датой — чтобы можно было откатиться руками.
                backup = target + ".bak." + DateTime.Now.ToString("yyyyMMdd-HHmmss");
                File.Move(target, backup);
            }
            File.Move(temp, target);

            Logger.Info("Файл записан: " + target + (backup != null ? " (старый -> " + Path.GetFileName(backup) + ")" : ""));
            return Outcome.Success("Записан " + target + " (" + size + " байт за " + seconds.ToString("0.#") + " с)" +
                                   (backup != null ? "; прежний файл сохранён как " + Path.GetFileName(backup) : "; прежнего файла не было"));
        }

        private static string Sha256Of(string path)
        {
            using (var sha = SHA256.Create())
            using (var stream = File.OpenRead(path))
            {
                return BitConverter.ToString(sha.ComputeHash(stream)).Replace("-", "").ToLowerInvariant();
            }
        }
    }
}
