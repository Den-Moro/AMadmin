using System;
using System.IO;

namespace AMadmin.Core
{
    public enum LogLevel { Debug = 10, Info = 20, Warning = 30, Error = 40 }

    // Лог в файл с уровнями и простой ротацией (один .old при превышении размера) — тот же
    // принцип, что и на сервере. По умолчанию Debug, пока приложение в бете.
    public static class Logger
    {
        private const long MaxBytes = 1024 * 1024;
        private static readonly object Sync = new object();

        public static string Path { get; set; } = "agent.log";
        public static LogLevel MinLevel { get; set; } = LogLevel.Debug;

        public static void SetLevel(string level)
        {
            LogLevel parsed;
            MinLevel = Enum.TryParse(level, true, out parsed) ? parsed : LogLevel.Debug;
        }

        public static void Debug(string message) { Write(LogLevel.Debug, message); }
        public static void Info(string message) { Write(LogLevel.Info, message); }
        public static void Warning(string message) { Write(LogLevel.Warning, message); }
        public static void Error(string message) { Write(LogLevel.Error, message); }

        private static void Write(LogLevel level, string message)
        {
            if (level < MinLevel) return;

            var line = "[" + DateTime.Now.ToString("yyyy-MM-dd HH:mm:ss") + "] [" +
                       level.ToString().ToUpperInvariant() + "] " + message + Environment.NewLine;

            lock (Sync)
            {
                try
                {
                    var info = new FileInfo(Path);
                    if (info.Exists && info.Length > MaxBytes)
                    {
                        File.Copy(Path, Path + ".old", true);
                        File.Delete(Path);
                    }
                    File.AppendAllText(Path, line);
                }
                catch
                {
                    // Логирование не должно ронять агента — если диск недоступен, просто молчим.
                }
            }
        }
    }
}
