using System;
using System.Collections.Generic;
using System.Linq;
using System.Runtime.InteropServices;
using System.Text;
using System.Text.Json;
using System.Threading;
using System.Threading.Tasks;
using Microsoft.Win32;
using AMadmin.Core;

namespace AMadmin.ManagementAgent.Executors
{
    // env_var (бета): системные переменные среды Windows (уровень компьютера, HKLM).
    //   { action: list | get | set | delete | path_add | path_remove, name?, value? }
    //
    // Пишем прямо в реестр, а не через Environment.SetEnvironmentVariable(..., Machine):
    // .NET записывает значение как REG_SZ, и у PATH, где обычно лежат %SystemRoot%\...
    // (REG_EXPAND_SZ), такие пути перестали бы раскрываться — сломанный PATH на кассе.
    // Здесь тип значения сохраняется, а новая переменная с «%» внутри становится
    // REG_EXPAND_SZ.
    //
    // Служба работает в сессии 0, поэтому оповещение об изменении (WM_SETTINGCHANGE)
    // до рабочего стола кассира не доходит: новое значение увидят программы, запущенные
    // после повторного входа пользователя или перезагрузки, и службы — после перезапуска.
    public class EnvVarExecutor : IExecutor
    {
        private const string KeyPath = @"SYSTEM\CurrentControlSet\Control\Session Manager\Environment";

        // Те же, что на сервере (AdminCommandsController::PROTECTED_ENV): только смотреть.
        private static readonly HashSet<string> Protected = new HashSet<string>(StringComparer.OrdinalIgnoreCase)
        {
            "Path", "PATHEXT", "ComSpec", "SystemRoot", "windir", "TEMP", "TMP", "OS", "PSModulePath",
            "NUMBER_OF_PROCESSORS", "PROCESSOR_ARCHITECTURE", "PROCESSOR_IDENTIFIER", "PROCESSOR_LEVEL",
            "PROCESSOR_REVISION", "DriverData", "USERNAME", "SystemDrive", "ProgramData", "ProgramFiles",
            "ProgramFiles(x86)", "ProgramW6432", "CommonProgramFiles", "CommonProgramFiles(x86)",
            "CommonProgramW6432", "ALLUSERSPROFILE", "PUBLIC", "COMPUTERNAME",
        };

        public Task<Outcome> ExecuteAsync(JsonElement payload, CancellationToken ct)
        {
            var action = Payload.Str(payload, "action");
            var name = Payload.Str(payload, "name").Trim();
            var value = Payload.Str(payload, "value");
            return Task.Run(() => Act(action, name, value), ct);
        }

        private static Outcome Act(string action, string name, string value)
        {
            try
            {
                using (var key = Registry.LocalMachine.OpenSubKey(KeyPath, action != "list" && action != "get"))
                {
                    if (key == null)
                    {
                        return Outcome.Failed("Не открывается раздел реестра HKLM\\" + KeyPath + ".");
                    }
                    switch (action)
                    {
                        case "list": return List(key);
                        case "get": return Get(key, name);
                        case "set": return Set(key, name, value);
                        case "delete": return Delete(key, name);
                        case "path_add": return PathAdd(key, value);
                        case "path_remove": return PathRemove(key, value);
                        default: return Outcome.Failed("Неизвестное действие '" + action + "'.");
                    }
                }
            }
            catch (UnauthorizedAccessException)
            {
                return Outcome.Failed("Нет прав на изменение системных переменных (агент должен работать службой от SYSTEM).");
            }
            catch (Exception ex)
            {
                return Outcome.Failed(ex.Message);
            }
        }

        private static string Raw(RegistryKey key, string name)
        {
            return key.GetValue(name, null, RegistryValueOptions.DoNotExpandEnvironmentNames) as string;
        }

        private static Outcome List(RegistryKey key)
        {
            var sb = new StringBuilder();
            foreach (var name in key.GetValueNames().OrderBy(n => n, StringComparer.OrdinalIgnoreCase))
            {
                var kind = key.GetValueKind(name);
                var raw = key.GetValue(name, null, RegistryValueOptions.DoNotExpandEnvironmentNames);
                sb.Append(name).Append(" = ").Append(raw);
                if (kind == RegistryValueKind.ExpandString) sb.Append("   [раскрывается]");
                sb.AppendLine();
            }
            return Outcome.Success(sb.Length > 0 ? sb.ToString() : "Системных переменных нет.");
        }

        private static Outcome Get(RegistryKey key, string name)
        {
            var raw = Raw(key, name);
            if (raw == null) return Outcome.Success(name + " — не задана.");
            var expanded = Environment.ExpandEnvironmentVariables(raw);
            return Outcome.Success(name + " = " + raw + (expanded != raw ? Environment.NewLine + "(раскрыто: " + expanded + ")" : ""));
        }

        private static Outcome Set(RegistryKey key, string name, string value)
        {
            if (Protected.Contains(name)) return Outcome.Failed("Системную переменную '" + name + "' менять нельзя — только смотреть.");
            if (string.IsNullOrEmpty(value)) return Outcome.Failed("Пустое значение — для удаления есть отдельное действие.");

            var old = Raw(key, name);
            if (old == value) return Outcome.Success(name + " уже = " + value + " (ничего не менял).");

            var kind = old != null ? key.GetValueKind(name)
                : (value.IndexOf('%') >= 0 ? RegistryValueKind.ExpandString : RegistryValueKind.String);
            if (kind != RegistryValueKind.ExpandString) kind = RegistryValueKind.String;
            key.SetValue(name, value, kind);
            Broadcast();
            Logger.Info("Переменная среды " + name + ": " + (old == null ? "создана" : "изменена"));
            return Outcome.Success((old == null ? "Создана: " : "Изменена: ") + name + " = " + value +
                (old != null ? Environment.NewLine + "Было: " + old : "") + Environment.NewLine + Note);
        }

        private static Outcome Delete(RegistryKey key, string name)
        {
            if (Protected.Contains(name)) return Outcome.Failed("Системную переменную '" + name + "' удалять нельзя.");
            var old = Raw(key, name);
            if (old == null) return Outcome.Success(name + " и так не задана.");
            key.DeleteValue(name, false);
            Broadcast();
            Logger.Info("Переменная среды " + name + " удалена");
            return Outcome.Success("Удалена: " + name + " (было: " + old + ")" + Environment.NewLine + Note);
        }

        // Папки PATH сравниваем без учёта регистра, хвостового «\» и в раскрытом виде:
        // «%ProgramFiles%\X» и «C:\Program Files\X» — одна и та же папка.
        private static string Norm(string folder)
        {
            return Environment.ExpandEnvironmentVariables(folder.Trim()).TrimEnd('\\').ToLowerInvariant();
        }

        private static Outcome PathAdd(RegistryKey key, string folder)
        {
            folder = (folder ?? "").Trim();
            if (folder == "" || folder.IndexOf(';') >= 0) return Outcome.Failed("Укажите одну папку, без «;».");
            var raw = Raw(key, "Path") ?? "";
            var parts = raw.Split(new[] { ';' }, StringSplitOptions.RemoveEmptyEntries).ToList();
            if (parts.Any(p => Norm(p) == Norm(folder))) return Outcome.Success("Папка уже есть в PATH: " + folder);

            parts.Add(folder);
            var updated = string.Join(";", parts);
            if (updated.Length > 4095) return Outcome.Failed("PATH стал бы длиннее 4095 символов — сначала уберите лишнее.");
            key.SetValue("Path", updated, RegistryValueKind.ExpandString);
            Broadcast();
            Logger.Info("PATH: добавлена папка " + folder);
            return Outcome.Success("Добавлено в PATH: " + folder + Environment.NewLine + Note);
        }

        private static Outcome PathRemove(RegistryKey key, string folder)
        {
            folder = (folder ?? "").Trim();
            if (folder == "") return Outcome.Failed("Укажите папку.");
            var raw = Raw(key, "Path") ?? "";
            var parts = raw.Split(new[] { ';' }, StringSplitOptions.RemoveEmptyEntries).ToList();
            var kept = parts.Where(p => Norm(p) != Norm(folder)).ToList();
            if (kept.Count == parts.Count) return Outcome.Success("Такой папки в PATH нет: " + folder);

            key.SetValue("Path", string.Join(";", kept), RegistryValueKind.ExpandString);
            Broadcast();
            Logger.Info("PATH: убрана папка " + folder);
            return Outcome.Success("Убрано из PATH: " + folder + Environment.NewLine + Note);
        }

        private const string Note = "Новое значение увидят программы, запущенные после повторного входа пользователя (или перезагрузки), и службы — после перезапуска.";

        // Сообщить запущенным программам (в этой сессии) об изменении окружения.
        private static void Broadcast()
        {
            try
            {
                UIntPtr result;
                SendMessageTimeout(new IntPtr(0xFFFF), 0x001A, UIntPtr.Zero, "Environment", 0x0002, 3000, out result);
            }
            catch
            {
                // Не получилось — не беда: значение в реестре уже записано.
            }
        }

        [DllImport("user32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
        private static extern IntPtr SendMessageTimeout(IntPtr hWnd, uint msg, UIntPtr wParam, string lParam,
            uint flags, uint timeout, out UIntPtr result);
    }
}
