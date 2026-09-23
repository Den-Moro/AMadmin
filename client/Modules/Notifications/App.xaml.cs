using System;
using System.IO;
using System.Reflection;
using System.Windows;
using System.Windows.Threading;
using AMadmin.Core;
using WinForms = System.Windows.Forms;

namespace AMadmin.UiAgent
{
    public partial class App : Application
    {
        private ApiClient _api;
        private AgentConfig _config;
        private string _configPath;
        private string _version;
        private DispatcherTimer _pollTimer;
        private WinForms.NotifyIcon _tray;
        private bool _polling;

        protected override void OnStartup(StartupEventArgs e)
        {
            base.OnStartup(e);

            var baseDir = AppDomain.CurrentDomain.BaseDirectory;
            _version = Assembly.GetExecutingAssembly().GetName().Version.ToString(3);
            _configPath = Path.Combine(baseDir, "config.json");

            Logger.Path = Path.Combine(baseDir, "ui-agent.log");

            try
            {
                _config = AgentConfig.Load(_configPath);
            }
            catch (Exception ex)
            {
                Logger.Error(ex.Message);
                MessageBox.Show(ex.Message, "AMadmin — нет конфига", MessageBoxButton.OK, MessageBoxImage.Error);
                Shutdown();
                return;
            }

            Logger.SetLevel(_config.LogLevel);
            Logger.Info("UiAgent " + _version + " запущен (сервер " + _config.ServerUrl +
                        ", опрос каждые " + _config.PollIntervalSeconds + "с, log_level=" + _config.LogLevel + ")");

            AgentState.ServerUrl = _config.ServerUrl;
            AgentState.Version = _version;

            _api = new ApiClient(_config, _version);

            SetupTray();

            _pollTimer = new DispatcherTimer { Interval = TimeSpan.FromSeconds(_config.PollIntervalSeconds) };
            _pollTimer.Tick += async (s, a) => await PollAsync();
            _pollTimer.Start();

            // Первый опрос — сразу, не ждём первого тика таймера.
            Dispatcher.BeginInvoke(new Action(async () => await PollAsync()));
        }

        private async System.Threading.Tasks.Task PollAsync()
        {
            // Если предыдущий опрос ещё идёт (например, показывает окно), новый не начинаем.
            if (_polling) return;
            _polling = true;

            try
            {
                Logger.Debug("Опрос " + _config.ServerUrl + "/occurrences");
                var occurrences = await _api.GetOccurrencesAsync();

                AgentState.LastPollAt = DateTime.Now;
                AgentState.LastSuccessAt = DateTime.Now;
                AgentState.LastPollOk = true;
                AgentState.LastError = "";
                Logger.Debug("Получено оповещений: " + occurrences.Count);

                foreach (var occurrence in occurrences)
                {
                    Logger.Info("Показ оповещения occurrence_id=" + occurrence.OccurrenceId);
                    var window = new NotificationWindow(occurrence);
                    window.ShowDialog();
                    AgentState.ShownTotal++;

                    await _api.SendAckAsync(occurrence.OccurrenceId, window.Reacted);
                    Logger.Info("Ack отправлен occurrence_id=" + occurrence.OccurrenceId);
                }
            }
            catch (Exception ex)
            {
                AgentState.LastPollAt = DateTime.Now;
                AgentState.LastPollOk = false;
                AgentState.LastError = ex.Message;
                Logger.Error(ex.Message);
            }
            finally
            {
                _polling = false;
            }
        }

        private void SetupTray()
        {
            _tray = new WinForms.NotifyIcon
            {
                Icon = System.Drawing.SystemIcons.Information,
                Text = "AMadmin — агент оповещений",
                Visible = true,
            };

            var menu = new WinForms.ContextMenuStrip();
            menu.Items.Add("Статус агента", null, (s, a) => ShowStatus());
            menu.Items.Add("Настройки", null, (s, a) => ShowSettings());
            menu.Items.Add("Проверить сейчас", null, async (s, a) => await PollAsync());
            _tray.ContextMenuStrip = menu;
            _tray.DoubleClick += (s, a) => ShowStatus();
        }

        private void ShowStatus()
        {
            new StatusWindow().Show();
        }

        private void ShowSettings()
        {
            new SettingsWindow(_config, _configPath, ApplyConfig).Show();
        }

        // Общая точка применения новой конфигурации — и после сохранения в окне настроек,
        // и после импорта файла (SettingsWindow сохраняет и вызывает этот колбэк). ApiClient
        // запекает server_url/токен/прокси в себя при создании (см. ApiClient.cs), поэтому
        // недостаточно просто заменить _config — клиент нужно пересоздать.
        private void ApplyConfig(AgentConfig config)
        {
            _config = config;
            Logger.SetLevel(_config.LogLevel);
            AgentState.ServerUrl = _config.ServerUrl;
            _api = new ApiClient(_config, _version);
            _pollTimer.Interval = TimeSpan.FromSeconds(_config.PollIntervalSeconds);
            Logger.Info("Конфиг обновлён из окна настроек (сервер " + _config.ServerUrl +
                        ", опрос каждые " + _config.PollIntervalSeconds + "с, log_level=" + _config.LogLevel + ")");
        }

        protected override void OnExit(ExitEventArgs e)
        {
            if (_tray != null) _tray.Visible = false;
            Logger.Info("UiAgent остановлен");
            base.OnExit(e);
        }
    }
}
