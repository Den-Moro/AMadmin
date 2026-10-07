using System;
using System.Collections.Generic;
using System.Globalization;
using System.Linq;
using System.Threading.Tasks;
using System.Windows;
using System.Windows.Input;
using System.Windows.Media;
using AMadmin.Core;

namespace AMadmin.UiAgent
{
    // Строка списка — Occurrence сам по себе не про UI.
    public class HistoryRow
    {
        public Occurrence Occurrence { get; set; }
        public string LevelText { get; set; }
        public Brush LevelBackground { get; set; }
        public Brush LevelForeground { get; set; }
        public string WhenText { get; set; }
        public string ExtrasText { get; set; }
        public string UnreadText { get; set; }
        public string Preview { get; set; }
    }

    // «История оповещений» из трея: что приходило на этот ПК за 30 дней (с сервера,
    // GET /occurrences/history). Клик — то же окно оповещения в режиме «перечитать»:
    // без таймера, без принудительного показа и без повторного подтверждения.
    public partial class HistoryWindow : Window
    {
        private readonly Func<ApiClient> _api;

        public HistoryWindow(Func<ApiClient> api)
        {
            InitializeComponent();
            _api = api;
            Loaded += async (s, e) => await LoadAsync();
        }

        private async void Refresh_Click(object sender, RoutedEventArgs e) { await LoadAsync(); }

        private async Task LoadAsync()
        {
            EmptyText.Visibility = Visibility.Visible;
            EmptyText.Text = "Загрузка…";
            Entries.ItemsSource = null;
            try
            {
                var items = await _api().GetHistoryAsync();
                Entries.ItemsSource = items.Select(ToRow).ToList();
                EmptyText.Visibility = items.Count == 0 ? Visibility.Visible : Visibility.Collapsed;
                EmptyText.Text = "За последние 30 дней оповещений не было.";
            }
            catch (Exception ex)
            {
                Logger.Warning("История оповещений: " + ex.Message);
                EmptyText.Text = "Не удалось получить историю с сервера — нет связи? Попробуйте позже.\n" + ex.Message;
            }
        }

        private static HistoryRow ToRow(Occurrence o)
        {
            string text, bg, fg;
            switch (o.EffectiveLevel)
            {
                case "info": text = "Информация"; bg = "#EFF6FF"; fg = "#1D4ED8"; break;
                case "important": text = "Важно"; bg = "#FFF7ED"; fg = "#C2410C"; break;
                case "critical": text = "Критично"; bg = "#DC2626"; fg = "#FFFFFF"; break;
                default: text = "Внимание"; bg = "#FFFBEB"; fg = "#B45309"; break;
            }
            var conv = new BrushConverter();
            DateTime when;
            var whenText = DateTime.TryParse(o.FireAt, CultureInfo.InvariantCulture,
                DateTimeStyles.AssumeUniversal | DateTimeStyles.AdjustToUniversal, out when)
                ? when.ToLocalTime().ToString("dd.MM.yyyy HH:mm") : o.FireAt;
            var extras = new List<string>();
            if (o.Images != null && o.Images.Count > 0) extras.Add("картинок: " + o.Images.Count);
            if (!string.IsNullOrWhiteSpace(o.ManualUrl)) extras.Add("есть инструкция");
            return new HistoryRow
            {
                Occurrence = o,
                LevelText = text,
                LevelBackground = (Brush)conv.ConvertFromString(bg),
                LevelForeground = (Brush)conv.ConvertFromString(fg),
                WhenText = whenText,
                ExtrasText = string.Join(" · ", extras),
                UnreadText = string.IsNullOrEmpty(o.AckedAt) ? "не подтверждено" : "",
                Preview = (o.Text ?? "").Replace("\r", " ").Replace("\n", " "),
            };
        }

        private async void Entry_Click(object sender, MouseButtonEventArgs e)
        {
            var row = (HistoryRow)((FrameworkElement)sender).Tag;
            var images = new List<byte[]>();
            foreach (var img in row.Occurrence.Images ?? new List<OccurrenceImage>())
            {
                try { images.Add(await _api().GetMediaAsync(img.Id)); }
                catch (Exception ex) { Logger.Warning("Картинку " + img.Id + " не удалось скачать: " + ex.Message); }
            }
            new NotificationWindow(row.Occurrence, images, review: true) { Owner = this }.ShowDialog();
        }
    }
}
