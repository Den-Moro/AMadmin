using System;
using System.Security.Cryptography;

namespace AMadmin.Core
{
    // Проверка пароля защиты клиента от "шаловливых рук" (см. AGENTS.md, "Управление
    // паролем клиента"). Сервер присылает только PBKDF2-хеш вида
    // "pbkdf2$<итерации>$<соль base64>$<хеш base64>" (см. AdminSettingsController::update
    // на сервере) — сравниваем локально, введённый пароль по сети никуда не уходит.
    // Это простая защита "от шаловливых рук", не криптостойкая система — постоянного
    // времени сравнение и то сверх необходимого для этой угрозы, но раз делаем — делаем
    // правильно.
    public static class ClientLock
    {
        public static bool Verify(string enteredPassword, string storedHash)
        {
            if (string.IsNullOrEmpty(storedHash)) return false;

            var parts = storedHash.Split('$');
            if (parts.Length != 4 || parts[0] != "pbkdf2") return false;
            if (!int.TryParse(parts[1], out int iterations) || iterations <= 0) return false;

            byte[] salt, expected;
            try
            {
                salt = Convert.FromBase64String(parts[2]);
                expected = Convert.FromBase64String(parts[3]);
            }
            catch (FormatException)
            {
                return false;
            }

            using (var pbkdf2 = new Rfc2898DeriveBytes(enteredPassword ?? "", salt, iterations, HashAlgorithmName.SHA256))
            {
                var computed = pbkdf2.GetBytes(expected.Length);
                return FixedTimeEquals(computed, expected);
            }
        }

        private static bool FixedTimeEquals(byte[] a, byte[] b)
        {
            if (a.Length != b.Length) return false;
            int diff = 0;
            for (int i = 0; i < a.Length; i++) diff |= a[i] ^ b[i];
            return diff == 0;
        }
    }
}
