using System;
using System.IO;
using System.Windows;
using AMadmin.Core;

namespace AMadmin.UiAgent
{
    public partial class SettingsWindow : Window
    {
        private readonly string _configPath;
        private readonly Action<AgentConfig> _onApplied;

        public SettingsWindow(AgentConfig current, string configPath, Action<AgentConfig> onApplied)
        {
            InitializeComponent();
            _configPath = configPath;
            _onApplied = onApplied;

            InstallPathText.Text = AppDomain.CurrentDomain.BaseDirectory;
            Fill(current);
        }

        private void Fill(AgentConfig config)
        {
            ServerUrlBox.Text = config.ServerUrl;
            AgentTokenBox.Password = config.AgentToken;
            PollIntervalBox.Text = config.PollIntervalSeconds.ToString();
            DownloadLimitBox.Text = config.DownloadLimitKbps.ToString();
            ProxyUrlBox.Text = config.ProxyUrl;
            ProxyUsernameBox.Text = config.ProxyUsername;
            ProxyPasswordBox.Password = config.ProxyPassword;
            foreach (System.Windows.Controls.ComboBoxItem item in LogLevelBox.Items)
            {
                if (string.Equals((string)item.Content, config.LogLevel, StringComparison.OrdinalIgnoreCase))
                {
                    LogLevelBox.SelectedItem = item;
                    break;
                }
            }
            if (LogLevelBox.SelectedItem == null) LogLevelBox.SelectedIndex = 0;
        }

        // Импорт заполняет поля значениями из выбранного файла (в т.ч. видно, какой
        // сервер/токен будут применены) — сохранение подтверждает пользователь кнопкой
        // "Сохранить", отдельный модальный диалог подтверждения не нужен.
        private void Import_Click(object sender, RoutedEventArgs e)
        {
            var dialog = new Microsoft.Win32.OpenFileDialog { Filter = "Конфиг (*.json)|*.json|Все файлы (*.*)|*.*" };
            if (dialog.ShowDialog() != true) return;

            try
            {
                var imported = AgentConfig.Parse(File.ReadAllText(dialog.FileName));
                Fill(imported);
                ShowError(null);
            }
            catch (Exception ex)
            {
                ShowError("Не удалось прочитать конфиг: " + ex.Message);
            }
        }

        private void Save_Click(object sender, RoutedEventArgs e)
        {
            int pollInterval, downloadLimit;
            if (!int.TryParse(PollIntervalBox.Text, out pollInterval) || pollInterval <= 0)
            {
                ShowError("Интервал опроса должен быть положительным числом.");
                return;
            }
            if (!int.TryParse(DownloadLimitBox.Text, out downloadLimit) || downloadLimit < 0)
            {
                ShowError("Лимит скачивания должен быть числом (0 — без лимита).");
                return;
            }

            var config = new AgentConfig
            {
                ServerUrl = ServerUrlBox.Text,
                AgentToken = AgentTokenBox.Password,
                PollIntervalSeconds = pollInterval,
                LogLevel = ((System.Windows.Controls.ComboBoxItem)LogLevelBox.SelectedItem)?.Content as string ?? "debug",
                ProxyUrl = ProxyUrlBox.Text,
                ProxyUsername = ProxyUsernameBox.Text,
                ProxyPassword = ProxyPasswordBox.Password,
                DownloadLimitKbps = downloadLimit,
            };

            try
            {
                AgentConfig.Validate(config);
            }
            catch (Exception ex)
            {
                ShowError(ex.Message);
                return;
            }

            config.ServerUrl = config.ServerUrl.TrimEnd('/');
            config.Save(_configPath);
            _onApplied(config);
            Close();
        }

        private void ShowError(string message)
        {
            ErrorText.Text = message;
            ErrorText.Visibility = string.IsNullOrEmpty(message) ? Visibility.Collapsed : Visibility.Visible;
        }
    }
}
