using System;
using System.Collections.Generic;
using System.Net;
using System.Net.Http;
using System.Net.Http.Headers;
using System.Text;
using System.Text.Json;
using System.Text.Json.Serialization;
using System.Threading.Tasks;

namespace AMadmin.Core
{
    public class Occurrence
    {
        [JsonPropertyName("occurrence_id")] public int OccurrenceId { get; set; }
        [JsonPropertyName("text")] public string Text { get; set; }
        [JsonPropertyName("priority")] public string Priority { get; set; }
        [JsonPropertyName("manual_url")] public string ManualUrl { get; set; }
        [JsonPropertyName("size")] public string Size { get; set; }
        [JsonPropertyName("fire_at")] public string FireAt { get; set; }

        // Приходит с сервера из настроек панели (см. AdminSettingsController).
        [JsonPropertyName("force_mode")] public string ForceMode { get; set; }
        [JsonPropertyName("close_delay_seconds")] public int CloseDelaySeconds { get; set; } = 30;
        [JsonPropertyName("confirm_close_required")] public bool ConfirmCloseRequired { get; set; } = true;
        [JsonPropertyName("accidental_tap_guard_ms")] public int AccidentalTapGuardMs { get; set; } = 600;
        [JsonPropertyName("play_sound")] public bool PlaySound { get; set; }
        [JsonPropertyName("soft_corner")] public string SoftCorner { get; set; } = "bottom-right";
        [JsonPropertyName("brand_name")] public string BrandName { get; set; }
        [JsonPropertyName("brand_contact")] public string BrandContact { get; set; }
    }

    public class Command
    {
        [JsonPropertyName("id")] public int Id { get; set; }
        [JsonPropertyName("type")] public string Type { get; set; }
        [JsonPropertyName("payload")] public string Payload { get; set; }
    }

    public class ClaimResult
    {
        [JsonPropertyName("status")] public string Status { get; set; }
        [JsonPropertyName("existing_status")] public string ExistingStatus { get; set; }
    }

    // GET /agent/config — настройки, нужные самому агенту (не панели): пароль защиты
    // клиента и версия, которая считается актуальной. Опрашивается реже, чем
    // /occurrences и /commands (см. AgentServerConfig.FetchAndCache).
    public class AgentServerConfig
    {
        [JsonPropertyName("client_lock_enabled")] public bool ClientLockEnabled { get; set; }
        [JsonPropertyName("client_lock_password_hash")] public string ClientLockPasswordHash { get; set; }
        [JsonPropertyName("current_agent_version")] public string CurrentAgentVersion { get; set; }
    }

    // Единственное место, где клиент разговаривает с сервером. Токен — всегда заголовком
    // Authorization (не в URL, чтобы не оседал в логах прокси/веб-сервера).
    public class ApiClient
    {
        private readonly HttpClient _http;
        private readonly HttpClient _download;
        private readonly string _baseUrl;

        public ApiClient(AgentConfig config, string agentVersion)
        {
            _baseUrl = config.ServerUrl;

            // Windows 7 + старый .NET по умолчанию не включают TLS 1.2 — включаем явно, иначе
            // HTTPS до сервера просто не поднимется.
            ServicePointManager.SecurityProtocol |= SecurityProtocolType.Tls12;

            // Два клиента с одинаковыми настройками, но разным таймаутом: обычные запросы
            // должны отваливаться быстро (30 с), а скачивание файла на узком канале может
            // законно идти десятки минут.
            _http = CreateHttp(config, agentVersion, TimeSpan.FromSeconds(30));
            _download = CreateHttp(config, agentVersion, TimeSpan.FromHours(2));
        }

        private static HttpClient CreateHttp(AgentConfig config, string agentVersion, TimeSpan timeout)
        {
            var handler = new HttpClientHandler { UseProxy = true };
            if (!string.IsNullOrWhiteSpace(config.ProxyUrl))
            {
                var proxy = new WebProxy(config.ProxyUrl);
                if (!string.IsNullOrEmpty(config.ProxyUsername))
                {
                    proxy.Credentials = new NetworkCredential(config.ProxyUsername, config.ProxyPassword ?? "");
                }
                handler.Proxy = proxy;
            }
            // Если proxy_url пуст — HttpClientHandler сам возьмёт системный прокси Windows.

            var http = new HttpClient(handler) { Timeout = timeout };
            http.DefaultRequestHeaders.Authorization = new AuthenticationHeaderValue("Bearer", config.AgentToken);
            // Сервер по этим заголовкам обновляет карточку ПК на дашборде (версия агента,
            // hostname, текущий пользователь) — это и есть heartbeat.
            http.DefaultRequestHeaders.Add("X-Agent-Version", agentVersion);
            http.DefaultRequestHeaders.Add("X-Agent-Hostname", Environment.MachineName);
            http.DefaultRequestHeaders.Add("X-Agent-Username", Environment.UserName);
            return http;
        }

        public async Task<List<Occurrence>> GetOccurrencesAsync()
        {
            var json = await GetStringAsync("/occurrences");
            return JsonSerializer.Deserialize<List<Occurrence>>(json) ?? new List<Occurrence>();
        }

        public Task SendAckAsync(int occurrenceId, bool reacted)
        {
            return PostJsonAsync("/occurrences/" + occurrenceId + "/ack", new { reacted = reacted });
        }

        public async Task<AgentServerConfig> GetAgentConfigAsync()
        {
            var json = await GetStringAsync("/agent/config");
            return JsonSerializer.Deserialize<AgentServerConfig>(json);
        }

        public async Task<List<Command>> GetCommandsAsync()
        {
            var json = await GetStringAsync("/commands");
            return JsonSerializer.Deserialize<List<Command>>(json) ?? new List<Command>();
        }

        public async Task<ClaimResult> ClaimCommandAsync(int commandId)
        {
            var json = await PostJsonAsync("/commands/" + commandId + "/claim", null);
            return JsonSerializer.Deserialize<ClaimResult>(json);
        }

        public Task SendCommandResultAsync(int commandId, string status, string output)
        {
            return PostJsonAsync("/commands/" + commandId + "/result", new { status = status, output = output });
        }

        // Скачивает файл для file_deploy во временный путь, считая SHA-256 на лету и
        // ограничивая скорость (килобайт/с, 0 = без ограничения). Хеш сверяем с тем, что
        // пришёл в команде, — файл с несовпавшим хешем не пишем на диск вовсе.
        public async Task DownloadFileAsync(int fileId, string destinationPath, string expectedSha256, int limitKbps, System.Threading.CancellationToken ct)
        {
            using (var response = await _download.GetAsync(_baseUrl + "/files/" + fileId, HttpCompletionOption.ResponseHeadersRead, ct))
            {
                if (!response.IsSuccessStatusCode)
                {
                    var body = await response.Content.ReadAsStringAsync();
                    throw new HttpRequestException("GET /files/" + fileId + " -> " + (int)response.StatusCode + ": " + body);
                }

                using (var sha = System.Security.Cryptography.SHA256.Create())
                using (var input = await response.Content.ReadAsStreamAsync())
                using (var output = new System.IO.FileStream(destinationPath, System.IO.FileMode.Create, System.IO.FileAccess.Write))
                {
                    var buffer = new byte[64 * 1024];
                    long total = 0;
                    var started = DateTime.UtcNow;
                    int read;
                    while ((read = await input.ReadAsync(buffer, 0, buffer.Length, ct)) > 0)
                    {
                        await output.WriteAsync(buffer, 0, read, ct);
                        sha.TransformBlock(buffer, 0, read, null, 0);
                        total += read;

                        // Дросселирование: если качаем быстрее лимита — досыпаем паузу,
                        // пока средняя скорость с начала загрузки не вернётся в норму.
                        if (limitKbps > 0)
                        {
                            var expectedSeconds = total / 1024.0 / limitKbps;
                            var elapsed = (DateTime.UtcNow - started).TotalSeconds;
                            if (expectedSeconds > elapsed)
                            {
                                await Task.Delay(TimeSpan.FromSeconds(expectedSeconds - elapsed), ct);
                            }
                        }
                    }
                    sha.TransformFinalBlock(new byte[0], 0, 0);

                    var actual = BitConverter.ToString(sha.Hash).Replace("-", "").ToLowerInvariant();
                    if (!string.Equals(actual, expectedSha256, StringComparison.OrdinalIgnoreCase))
                    {
                        throw new InvalidOperationException("Хеш скачанного файла не совпал: ожидали " + expectedSha256 + ", получили " + actual);
                    }
                }
            }
        }

        private async Task<string> GetStringAsync(string path)
        {
            var response = await _http.GetAsync(_baseUrl + path);
            var body = await response.Content.ReadAsStringAsync();
            if (!response.IsSuccessStatusCode)
            {
                throw new HttpRequestException("GET " + path + " -> " + (int)response.StatusCode + ": " + body);
            }
            return body;
        }

        private async Task<string> PostJsonAsync(string path, object payload)
        {
            var content = new StringContent(payload == null ? "{}" : JsonSerializer.Serialize(payload), Encoding.UTF8, "application/json");
            var response = await _http.PostAsync(_baseUrl + path, content);
            var body = await response.Content.ReadAsStringAsync();
            if (!response.IsSuccessStatusCode)
            {
                throw new HttpRequestException("POST " + path + " -> " + (int)response.StatusCode + ": " + body);
            }
            return body;
        }
    }
}
