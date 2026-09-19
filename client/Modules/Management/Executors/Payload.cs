using System.Text.Json;

namespace AMadmin.ManagementAgent.Executors
{
    // Мелкие помощники для чтения payload: поля могут отсутствовать или быть null,
    // а JsonElement на это кидает исключения.
    internal static class Payload
    {
        public static string Str(JsonElement p, string name, string fallback = "")
        {
            JsonElement v;
            if (p.ValueKind == JsonValueKind.Object && p.TryGetProperty(name, out v) && v.ValueKind == JsonValueKind.String)
            {
                return v.GetString();
            }
            return fallback;
        }

        public static bool Bool(JsonElement p, string name, bool fallback = false)
        {
            JsonElement v;
            if (p.ValueKind == JsonValueKind.Object && p.TryGetProperty(name, out v))
            {
                if (v.ValueKind == JsonValueKind.True) return true;
                if (v.ValueKind == JsonValueKind.False) return false;
            }
            return fallback;
        }

        public static int Int(JsonElement p, string name, int fallback = 0)
        {
            JsonElement v;
            if (p.ValueKind == JsonValueKind.Object && p.TryGetProperty(name, out v) && v.ValueKind == JsonValueKind.Number)
            {
                int n;
                return v.TryGetInt32(out n) ? n : fallback;
            }
            return fallback;
        }
    }
}
