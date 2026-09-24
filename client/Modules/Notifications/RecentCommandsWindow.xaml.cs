using System;
using System.Linq;
using System.Windows;
using System.Windows.Media;
using AMadmin.Core;

namespace AMadmin.UiAgent
{
    // Отображение для одной записи — RecentCommandEntry сам по себе не про UI.
    public class RecentCommandRow
    {
        public string TypeText { get; set; }
        public string IdText { get; set; }
        public string StatusText { get; set; }
        public Brush StatusBrush { get; set; }
        public string AtText { get; set; }
        public string Output { get; set; }
        public Visibility OutputVisibility { get; set; }
    }

    public partial class RecentCommandsWindow : Window
    {
        public RecentCommandsWindow()
        {
            InitializeComponent();
            Load();
        }

        private void Refresh_Click(object sender, RoutedEventArgs e)
        {
            Load();
        }

        private void Load()
        {
            var baseDir = AppDomain.CurrentDomain.BaseDirectory;
            var entries = RecentCommands.Load(baseDir);

            EmptyText.Visibility = entries.Count == 0 ? Visibility.Visible : Visibility.Collapsed;
            Entries.ItemsSource = entries.Select(entry => new RecentCommandRow
            {
                TypeText = entry.Type,
                IdText = "id=" + entry.Id,
                StatusText = StatusLabel(entry.Status),
                StatusBrush = StatusBrushFor(entry.Status),
                AtText = entry.At.ToString("yyyy-MM-dd HH:mm:ss"),
                Output = entry.Output,
                OutputVisibility = string.IsNullOrEmpty(entry.Output) ? Visibility.Collapsed : Visibility.Visible,
            }).ToList();
        }

        private static string StatusLabel(string status)
        {
            switch (status)
            {
                case "success": return "успешно";
                case "failed": return "ошибка";
                case "timeout": return "таймаут";
                default: return status;
            }
        }

        private static Brush StatusBrushFor(string status)
        {
            switch (status)
            {
                case "success": return (Brush)new BrushConverter().ConvertFromString("#16A34A");
                case "failed":
                case "timeout": return (Brush)new BrushConverter().ConvertFromString("#B91C1C");
                default: return (Brush)new BrushConverter().ConvertFromString("#6B7280");
            }
        }
    }
}
