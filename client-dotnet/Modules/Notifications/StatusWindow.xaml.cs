using System.Windows;
using System.Windows.Media;

namespace AMadmin.UiAgent
{
    public partial class StatusWindow : Window
    {
        public StatusWindow()
        {
            InitializeComponent();
            Refresh();
        }

        private void Refresh_Click(object sender, RoutedEventArgs e)
        {
            Refresh();
        }

        private void Refresh()
        {
            var ok = AgentState.LastPollOk;
            ConnectionText.Text = AgentState.LastPollAt == null ? "ещё не опрашивал" : (ok ? "есть" : "нет");
            ConnectionText.Foreground = (Brush)new BrushConverter().ConvertFromString(ok ? "#16A34A" : "#B91C1C");

            ServerText.Text = AgentState.ServerUrl;
            LastPollText.Text = AgentState.LastPollAt?.ToString("yyyy-MM-dd HH:mm:ss") ?? "—";
            LastSuccessText.Text = AgentState.LastSuccessAt?.ToString("yyyy-MM-dd HH:mm:ss") ?? "—";
            ShownText.Text = AgentState.ShownTotal.ToString();
            VersionText.Text = AgentState.Version;

            ErrorText.Text = AgentState.LastError;
            ErrorText.Visibility = string.IsNullOrEmpty(AgentState.LastError) ? Visibility.Collapsed : Visibility.Visible;
        }
    }
}
