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

    // Единственное место, где клиент разговаривает с сервером. Токен — всегда заголовком
    // Authorization (не в URL, чтобы не оседал в логах прокси/веб-сервера).
    public class ApiClient
    {
        private readonly HttpClient _http;
        private readonly string _baseUrl;

        public ApiClient(AgentConfig config, string agentVersion)
        {
            _baseUrl = config.ServerUrl;

            // Windows 7 + старый .NET по умолчанию не включают TLS 1.2 — включаем явно, иначе
            // HTTPS до сервера просто не поднимется.
            ServicePointManager.SecurityProtocol |= SecurityProtocolType.Tls12;

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

            _http = new HttpClient(handler) { Timeout = TimeSpan.FromSeconds(30) };
            _http.DefaultRequestHeaders.Authorization = new AuthenticationHeaderValue("Bearer", config.AgentToken);
            // Сервер по этим заголовкам обновляет карточку ПК на дашборде (версия агента,
            // hostname, текущий пользователь) — это и есть heartbeat.
            _http.DefaultRequestHeaders.Add("X-Agent-Version", agentVersion);
            _http.DefaultRequestHeaders.Add("X-Agent-Hostname", Environment.MachineName);
            _http.DefaultRequestHeaders.Add("X-Agent-Username", Environment.UserName);
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
