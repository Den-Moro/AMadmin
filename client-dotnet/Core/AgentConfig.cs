using System;
using System.IO;
using System.Text.Json;
using System.Text.Json.Serialization;

namespace AMadmin.Core
{
    // config.json агента. Поля — те же, что готовит кнопка "Показать конфиг" на дашборде.
    public class AgentConfig
    {
        [JsonPropertyName("server_url")]
        public string ServerUrl { get; set; }

        [JsonPropertyName("agent_token")]
        public string AgentToken { get; set; }

        [JsonPropertyName("poll_interval_seconds")]
        public int PollIntervalSeconds { get; set; } = 30;

        [JsonPropertyName("log_level")]
        public string LogLevel { get; set; } = "debug";

        // Прокси. Пусто — берём системные настройки Windows (как браузер). Заполнено —
        // используем именно этот прокси, независимо от системных настроек.
        [JsonPropertyName("proxy_url")]
        public string ProxyUrl { get; set; }

        [JsonPropertyName("proxy_username")]
        public string ProxyUsername { get; set; }

        [JsonPropertyName("proxy_password")]
        public string ProxyPassword { get; set; }

        public static AgentConfig Load(string path)
        {
            if (!File.Exists(path))
            {
                throw new FileNotFoundException(
                    "Конфиг не найден: " + path + ". Скопируйте config.example.json в config.json " +
                    "или возьмите готовый с дашборда (кнопка \"Показать конфиг\").");
            }

            // Обычный JSON комментариев не допускает, но людям с ними проще — разрешаем
            // // и /* */ прямо в файле.
            var options = new JsonSerializerOptions
            {
                ReadCommentHandling = JsonCommentHandling.Skip,
                AllowTrailingCommas = true,
            };

            var config = JsonSerializer.Deserialize<AgentConfig>(File.ReadAllText(path), options);

            if (string.IsNullOrWhiteSpace(config.ServerUrl) || string.IsNullOrWhiteSpace(config.AgentToken))
            {
                throw new InvalidOperationException("В config.json должны быть заполнены server_url и agent_token.");
            }

            config.ServerUrl = config.ServerUrl.TrimEnd('/');
            return config;
        }
    }
}
