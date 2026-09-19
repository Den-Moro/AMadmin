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
        private DispatcherTimer _pollTimer;
        private WinForms.NotifyIcon _tray;
        private bool _polling;

        protected override void OnStartup(StartupEventArgs e)
        {
            base.OnStartup(e);

            var baseDir = AppDomain.CurrentDomain.BaseDirectory;
            var version = Assembly.GetExecutingAssembly().GetName().Version.ToString(3);

            Logger.Path = Path.Combine(baseDir, "ui-agent.log");

            try
            {
                _config = AgentConfig.Load(Path.Combine(baseDir, "config.json"));
            }
            catch (Exception ex)
            {
                Logger.Error(ex.Message);
                MessageBox.Show(ex.Message, "AMadmin — нет конфига", MessageBoxButton.OK, MessageBoxImage.Error);
                Shutdown();
                return;
            }

            Logger.SetLevel(_config.LogLevel);
            Logger.Info("UiAgent " + version + " запущен (сервер " + _config.ServerUrl +
                        ", опрос каждые " + _config.PollIntervalSeconds + "с, log_level=" + _config.LogLevel + ")");

            AgentState.ServerUrl = _config.ServerUrl;
            AgentState.Version = version;

            _api = new ApiClient(_config, version);

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
            menu.Items.Add("Проверить сейчас", null, async (s, a) => await PollAsync());
            _tray.ContextMenuStrip = menu;
            _tray.DoubleClick += (s, a) => ShowStatus();
        }

        private void ShowStatus()
        {
            new StatusWindow().Show();
        }

        protected override void OnExit(ExitEventArgs e)
        {
            if (_tray != null) _tray.Visible = false;
            Logger.Info("UiAgent остановлен");
            base.OnExit(e);
        }
    }
}
