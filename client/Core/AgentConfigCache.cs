using System;
using System.IO;
using System.Text.Json;
using System.Threading.Tasks;

namespace AMadmin.Core
{
    // Локальный кэш GET /agent/config — опрашивается реже, чем /occurrences и /commands
    // (см. вызывающий код), и должен продолжать работать, если сервер на момент открытия
    // окна "Настройки" недоступен: пароль защиты клиента проверяется локально, поэтому
    // используем последний известный хеш, а не блокируем действие из-за сети.
    public static class AgentConfigCache
    {
        // Пробует получить свежий конфиг с сервера; при успехе сохраняет его в кэш.
        // При ошибке (сети, сервера) молча отдаёт последний сохранённый кэш — а если
        // кэша тоже никогда не было (свежая установка, ни разу не достучались), null.
        public static async Task<AgentServerConfig> FetchAndCache(ApiClient api, string baseDir)
        {
            try
            {
                var fresh = await api.GetAgentConfigAsync();
                Save(baseDir, fresh);
                return fresh;
            }
            catch
            {
                return Load(baseDir);
            }
        }

        public static void Save(string baseDir, AgentServerConfig config)
        {
            try
            {
                File.WriteAllText(PathFor(baseDir), JsonSerializer.Serialize(config, new JsonSerializerOptions { WriteIndented = true }));
            }
            catch
            {
                // Локальный кэш — не более того; не смогли записать, попробуем на следующем опросе.
            }
        }

        public static AgentServerConfig Load(string baseDir)
        {
            var path = PathFor(baseDir);
            if (!File.Exists(path)) return null;

            try
            {
                return JsonSerializer.Deserialize<AgentServerConfig>(File.ReadAllText(path));
            }
            catch
            {
                // Повреждённый файл — считаем, что кэша нет, а не падаем.
                return null;
            }
        }

        private static string PathFor(string baseDir)
        {
            return Path.Combine(baseDir, "agent-config-cache.json");
        }
    }
}
