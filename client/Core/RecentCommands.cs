using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Text.Json;
using System.Text.Json.Serialization;

namespace AMadmin.Core
{
    public class RecentCommandEntry
    {
        [JsonPropertyName("id")] public int Id { get; set; }
        [JsonPropertyName("type")] public string Type { get; set; }
        [JsonPropertyName("status")] public string Status { get; set; }
        [JsonPropertyName("output")] public string Output { get; set; }
        [JsonPropertyName("at")] public DateTime At { get; set; }
    }

    // Локальная история последних выполненных команд — только для окна "Последние
    // команды" в трее UiAgent. ManagementAgent (отдельный процесс, без IPC с UiAgent —
    // см. AgentState.cs) пишет сюда после каждого результата; UiAgent только читает.
    // Файл маленький и ограниченный (последние 20), поэтому просто читаем-меняем-пишем
    // целиком при каждом добавлении — конкуренция не ожидается (один агент, один поток
    // команд за раз, кроме фоновых file_deploy, для которых гонка на последнем месте
    // списка не критична).
    public static class RecentCommands
    {
        private const int MaxEntries = 20;
        private const int MaxOutputLength = 500;

        public static void Append(string baseDir, int id, string type, string status, string output)
        {
            var path = PathFor(baseDir);
            try
            {
                var entries = Load(baseDir);
                entries.Insert(0, new RecentCommandEntry
                {
                    Id = id,
                    Type = type,
                    Status = status,
                    Output = Truncate(output),
                    At = DateTime.Now,
                });
                if (entries.Count > MaxEntries) entries.RemoveRange(MaxEntries, entries.Count - MaxEntries);

                File.WriteAllText(path, JsonSerializer.Serialize(entries, new JsonSerializerOptions { WriteIndented = true }));
            }
            catch
            {
                // Локальная история — не более того; если диск недоступен, команда всё
                // равно выполнилась и результат ушёл на сервер, ронять агента незачем.
            }
        }

        public static List<RecentCommandEntry> Load(string baseDir)
        {
            var path = PathFor(baseDir);
            if (!File.Exists(path)) return new List<RecentCommandEntry>();

            try
            {
                return JsonSerializer.Deserialize<List<RecentCommandEntry>>(File.ReadAllText(path)) ?? new List<RecentCommandEntry>();
            }
            catch
            {
                // Повреждённый файл — начинаем заново, а не падаем.
                return new List<RecentCommandEntry>();
            }
        }

        private static string Truncate(string output)
        {
            if (string.IsNullOrEmpty(output) || output.Length <= MaxOutputLength) return output;
            return output.Substring(0, MaxOutputLength) + "…";
        }

        private static string PathFor(string baseDir)
        {
            return Path.Combine(baseDir, "recent-commands.json");
        }
    }
}
