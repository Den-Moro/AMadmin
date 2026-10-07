using System;
using System.Collections.Generic;
using System.ComponentModel;
using System.Diagnostics;
using System.Linq;
using System.Runtime.InteropServices;
using System.Windows;
using System.Windows.Controls;
using System.Windows.Input;
using System.Windows.Interop;
using System.Windows.Media;
using System.Windows.Media.Imaging;
using System.Windows.Threading;
using AMadmin.Core;

namespace AMadmin.UiAgent
{
    public partial class NotificationWindow : Window
    {
        private readonly Occurrence _occurrence;
        private readonly DispatcherTimer _timer = new DispatcherTimer { Interval = TimeSpan.FromSeconds(1) };
        private readonly bool _forced;
        private int _remaining;
        private bool _allowClose;
        private bool _manualOpened;
        private bool _manualIsUrl;

        // Нажатие засчитывается, только если оно НАЧАЛОСЬ уже на разблокированной кнопке.
        // Без этого оповещение закрывается само: пока кнопка заблокирована, она не
        // принимает ввод, а в момент разблокировки ей достаётся "висящее" отпускание
        // мыши (курсор стоит над кнопкой) — и окно закрывается, хотя человек его даже не
        // читал. На кассе это же сделает рука, лежащая на мыши. Проверено вживую.
        private bool _pressStartedWhileEnabled;
        private bool _keyboardActivated;

        // Кассы — сенсорные, кассир постоянно тыкает в экран во время работы. Если
        // принять тап, прилетевший ровно в момент разблокировки кнопки, обязательное
        // оповещение закроется непрочитанным. Поэтому первые полсекунды после
        // разблокировки нажатия не засчитываем — за это время случайный тап уже пройдёт,
        // а осознанное нажатие человек сделает позже.
        private readonly TimeSpan _settleTime;
        private bool _confirmRequired;
        private DateTime? _enabledAt;

        private bool _confirming;
        private readonly DispatcherTimer _confirmResetTimer =
            new DispatcherTimer { Interval = TimeSpan.FromSeconds(6) };

        // Пока нет отдельной кнопки "Я выполнил" — reacted всегда false. Оставлено под
        // необязательную фичу из AGENTS.md.
        public bool Reacted { get; private set; }

        // Пока открыт просмотр картинки крупно — принудительное окно не должно выдёргивать
        // себя наверх (иначе просмотр тут же уходит под него).
        private bool _viewerOpen;
        private readonly List<BitmapSource> _images = new List<BitmapSource>();
        private int _imageIndex;

        // review — открыто из «Истории оповещений»: перечитать, без таймера и без ack.
        public NotificationWindow(Occurrence occurrence, IList<byte[]> images = null, bool review = false)
        {
            InitializeComponent();
            _occurrence = occurrence;
            SetImages(images);

            MessageText.Text = occurrence.Text;
            _remaining = occurrence.CloseDelaySeconds > 0 ? occurrence.CloseDelaySeconds : 30;
            _settleTime = TimeSpan.FromMilliseconds(Math.Max(0, occurrence.AccidentalTapGuardMs));
            _confirmRequired = occurrence.ConfirmCloseRequired;

            var level = occurrence.EffectiveLevel;
            var important = level == "important" || level == "critical";
            // Важно/Критично — всегда принудительно. Остальное — по ForceMode, который
            // присылает сервер (strict = тоже принудительно, soft = мягко в углу).
            // Из истории — всегда обычное окно: человек сам решил перечитать.
            _forced = !review && (important || occurrence.ForceMode == "strict");

            if (!string.IsNullOrWhiteSpace(occurrence.BrandName) || !string.IsNullOrWhiteSpace(occurrence.BrandContact))
            {
                BrandText.Text = string.Join("  ·  ", new[] { occurrence.BrandName, occurrence.BrandContact }
                    .Where(x => !string.IsNullOrWhiteSpace(x)));
            }

            ApplyLevelStyle(level);

            if (_forced)
            {
                // Убираем заголовок окна целиком: на сенсорной кассе крестик в углу —
                // это кнопка, в которую будут тыкать, а закрыть он всё равно не даст
                // (Closing отменяется). Лучше, чтобы его просто не было — остаётся один
                // понятный способ закрыть окно.
                WindowStyle = WindowStyle.None;

                // Одного Topmost мало: Windows не даёт фоновому процессу просто так выйти
                // вперёд. Поэтому ещё и активируем окно, и возвращаем его наверх, если
                // поверх него всё-таки что-то вылезло (другое topmost-окно, кассовая
                // программа в полный экран и т.п.).
                Topmost = true;
                ShowInTaskbar = true;
                Loaded += (s, e) => ForceToFront();
                Deactivated += (s, e) => { if (!_allowClose && !_viewerOpen) Dispatcher.BeginInvoke(new Action(ForceToFront)); };
            }
            else if (review)
            {
                // Перечитать из истории — обычное окно по центру над списком истории.
                Topmost = false;
                WindowStartupLocation = WindowStartupLocation.CenterOwner;
            }
            else
            {
                Topmost = false;
                // Мягкий режим — в углу, не мешая работе. Угол выбирается в настройках,
                // чтобы окно не садилось поверх рабочих кнопок кассовой программы.
                WindowStartupLocation = WindowStartupLocation.Manual;
                Loaded += (s, e) => PlaceInCorner(occurrence.SoftCorner);
            }

            // Размер окна из настроек/оповещения: крупное заметнее, маленькое меньше мешает.
            switch (occurrence.Size)
            {
                case "small": Width = 380; MainImage.MaxHeight = 200; break;
                case "large": Width = 680; MainImage.MaxHeight = 400; break;
                default: Width = 520; MainImage.MaxHeight = 280; break;
            }
            // Мониторы касс бывают маленькими (1024×768): окно не выше экрана — середина с
            // текстом и картинками прокручивается, кнопка «Понятно» внизу видна всегда.
            var area = SystemParameters.WorkArea;
            MaxHeight = area.Height - 8;
            MainImage.MaxHeight = Math.Min(MainImage.MaxHeight, Math.Max(140, area.Height * 0.36));

            if (occurrence.PlaySound)
            {
                Loaded += (s, e) =>
                {
                    try { System.Media.SystemSounds.Exclamation.Play(); }
                    catch (Exception ex) { Logger.Warning("Не удалось воспроизвести звук: " + ex.Message); }
                };
            }

            if (review)
            {
                // Перечитать — без таймера и обязательного открытия инструкции, ack не нужен.
                Title = "Оповещение из истории";
                _remaining = 0;
                _timer.Stop();
            }

            if (!string.IsNullOrWhiteSpace(occurrence.ManualUrl))
            {
                _manualIsUrl = occurrence.ManualUrl.StartsWith("http://", StringComparison.OrdinalIgnoreCase)
                            || occurrence.ManualUrl.StartsWith("https://", StringComparison.OrdinalIgnoreCase);
                ManualButton.Visibility = Visibility.Visible;
                HintText.Text = "Есть инструкция — окно можно будет закрыть только после того, как вы её откроете.";
                if (review) _manualOpened = true;
            }
            else
            {
                _manualOpened = true;
            }
            if (review)
            {
                var when = ParseUtc(occurrence.FireAt);
                HintText.Text = "Из истории: показано " + (when.HasValue ? when.Value.ToString("dd.MM.yyyy HH:mm") : occurrence.FireAt) +
                                (string.IsNullOrEmpty(occurrence.AckedAt) ? " · ещё не было подтверждено" : "");
                _confirmRequired = false;
            }

            Closing += OnClosing;
            _timer.Tick += OnTick;
            if (!review) _timer.Start();

            _confirmResetTimer.Tick += (s, e) =>
            {
                _confirmResetTimer.Stop();
                _confirming = false;
                UpdateCloseButton();
            };

            UpdateCloseButton();
        }

        // Цвет и подпись значка по уровню важности. Критично — ещё и красная рамка окна.
        private void ApplyLevelStyle(string level)
        {
            string text, bg, border, fg;
            switch (level)
            {
                case "info": text = "Информация"; bg = "#EFF6FF"; border = "#BFDBFE"; fg = "#1D4ED8"; break;
                case "important": text = "Важно"; bg = "#FFF7ED"; border = "#FED7AA"; fg = "#C2410C"; break;
                case "critical": text = "Критично"; bg = "#DC2626"; border = "#DC2626"; fg = "#FFFFFF"; break;
                default: text = "Внимание"; bg = "#FFFBEB"; border = "#FDE68A"; fg = "#B45309"; break;
            }
            var conv = new BrushConverter();
            PriorityText.Text = text;
            PriorityBadge.Background = (Brush)conv.ConvertFromString(bg);
            PriorityBadge.BorderBrush = (Brush)conv.ConvertFromString(border);
            PriorityText.Foreground = (Brush)conv.ConvertFromString(fg);
            if (level == "critical")
            {
                Card.BorderBrush = (Brush)conv.ConvertFromString("#DC2626");
                Card.BorderThickness = new Thickness(3);
            }
        }

        // Картинки приходят уже скачанными (App качает их до показа окна). Битую или
        // неподдерживаемую пропускаем — текст оповещения важнее картинки.
        private void SetImages(IList<byte[]> images)
        {
            if (images == null) return;
            foreach (var bytes in images)
            {
                try
                {
                    var bmp = new BitmapImage();
                    using (var ms = new System.IO.MemoryStream(bytes))
                    {
                        bmp.BeginInit();
                        bmp.CacheOption = BitmapCacheOption.OnLoad;
                        bmp.StreamSource = ms;
                        bmp.EndInit();
                    }
                    bmp.Freeze();
                    _images.Add(bmp);
                }
                catch (Exception ex)
                {
                    Logger.Warning("Картинку оповещения не удалось показать: " + ex.Message);
                }
            }
            if (_images.Count == 0) return;
            ImagesPanel.Visibility = Visibility.Visible;
            ShowImage(0);
            if (_images.Count > 1)
            {
                for (var i = 0; i < _images.Count; i++)
                {
                    var index = i;
                    var thumb = new Border
                    {
                        Width = 72, Height = 52, Margin = new Thickness(0, 0, 6, 6), CornerRadius = new CornerRadius(6),
                        BorderThickness = new Thickness(2), Cursor = Cursors.Hand,
                        Child = new Image { Source = _images[i], Stretch = Stretch.UniformToFill },
                        ToolTip = "Картинка " + (i + 1) + " из " + _images.Count,
                    };
                    thumb.MouseLeftButtonUp += (s, e) => ShowImage(index);
                    Thumbs.Items.Add(thumb);
                }
                UpdateThumbs();
            }
        }

        private void ShowImage(int index)
        {
            _imageIndex = index;
            MainImage.Source = _images[index];
            ImageHint.Text = _images.Count > 1
                ? "Картинка " + (index + 1) + " из " + _images.Count + " · нажмите, чтобы увеличить"
                : "Нажмите на картинку, чтобы увеличить";
            UpdateThumbs();
        }

        private void UpdateThumbs()
        {
            var conv = new BrushConverter();
            for (var i = 0; i < Thumbs.Items.Count; i++)
            {
                ((Border)Thumbs.Items[i]).BorderBrush = (Brush)conv.ConvertFromString(i == _imageIndex ? "#2563EB" : "#D8DBE0");
            }
        }

        private void MainImage_Click(object sender, MouseButtonEventArgs e)
        {
            if (_images.Count == 0) return;
            _viewerOpen = true;
            try
            {
                new ImageViewerWindow(_images, _imageIndex) { Owner = this, Topmost = Topmost }.ShowDialog();
            }
            finally
            {
                _viewerOpen = false;
                if (_forced && !_allowClose) ForceToFront();
            }
        }

        private static DateTime? ParseUtc(string value)
        {
            DateTime dt;
            if (!string.IsNullOrEmpty(value) && DateTime.TryParse(value, System.Globalization.CultureInfo.InvariantCulture,
                    System.Globalization.DateTimeStyles.AssumeUniversal | System.Globalization.DateTimeStyles.AdjustToUniversal, out dt))
            {
                return dt.ToLocalTime();
            }
            return null;
        }

        private void PlaceInCorner(string corner)
        {
            var area = SystemParameters.WorkArea;
            const double margin = 16;

            switch (corner)
            {
                case "bottom-left":
                    Left = area.Left + margin;
                    Top = area.Bottom - ActualHeight - margin;
                    break;
                case "top-right":
                    Left = area.Right - ActualWidth - margin;
                    Top = area.Top + margin;
                    break;
                case "top-left":
                    Left = area.Left + margin;
                    Top = area.Top + margin;
                    break;
                default: // bottom-right
                    Left = area.Right - ActualWidth - margin;
                    Top = area.Bottom - ActualHeight - margin;
                    break;
            }
        }

        // Возврат окна на передний план. AttachThreadInput — стандартный обход правила
        // Windows "фоновый процесс не может забрать фокус": временно связываем ввод с
        // потоком активного окна, и тогда SetForegroundWindow срабатывает.
        private void ForceToFront()
        {
            try
            {
                Topmost = true;
                if (WindowState == WindowState.Minimized) WindowState = WindowState.Normal;

                var self = new WindowInteropHelper(this).Handle;
                var foreground = GetForegroundWindow();
                uint dummy;
                var foregroundThread = GetWindowThreadProcessId(foreground, out dummy);
                var currentThread = GetCurrentThreadId();

                if (foregroundThread != currentThread)
                {
                    AttachThreadInput(foregroundThread, currentThread, true);
                    SetForegroundWindow(self);
                    AttachThreadInput(foregroundThread, currentThread, false);
                }
                else
                {
                    SetForegroundWindow(self);
                }

                Activate();
                Focus();
            }
            catch (Exception ex)
            {
                Logger.Warning("Не удалось вывести окно оповещения поверх остальных: " + ex.Message);
            }
        }

        [DllImport("user32.dll")] private static extern IntPtr GetForegroundWindow();
        [DllImport("user32.dll")] private static extern bool SetForegroundWindow(IntPtr hWnd);
        [DllImport("user32.dll")] private static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint processId);
        [DllImport("user32.dll")] private static extern bool AttachThreadInput(uint attach, uint attachTo, bool fAttach);
        [DllImport("kernel32.dll")] private static extern uint GetCurrentThreadId();

        private void OnTick(object sender, EventArgs e)
        {
            if (_remaining > 0) _remaining--;
            UpdateCloseButton();
            if (_remaining == 0) _timer.Stop();
        }

        private void UpdateCloseButton()
        {
            // Кнопка активна только когда И таймер вышел, И инструкция (если была) открыта —
            // ровно так, как требует AGENTS.md.
            var ready = _remaining == 0 && _manualOpened;

            if (ready && _enabledAt == null) _enabledAt = DateTime.Now;
            if (!ready) _enabledAt = null;

            CloseButton.IsEnabled = ready;
            if (!_confirming)
            {
                CloseButton.Content = ready ? "Понятно" : "Понятно (" + _remaining + ")";
            }
        }

        private void ManualButton_Click(object sender, RoutedEventArgs e)
        {
            _manualOpened = true;
            if (_manualIsUrl)
            {
                try { Process.Start(_occurrence.ManualUrl); }
                catch (Exception ex) { Logger.Warning("Не удалось открыть ссылку мануала: " + ex.Message); }
            }
            else
            {
                ManualText.Text = _occurrence.ManualUrl;
                ManualPanel.Visibility = Visibility.Visible;
                ManualButton.Visibility = Visibility.Collapsed;
            }
            UpdateCloseButton();
        }

        private void CloseButton_PreviewMouseLeftButtonDown(object sender, System.Windows.Input.MouseButtonEventArgs e)
        {
            _pressStartedWhileEnabled = CloseButton.IsEnabled;
        }

        private void CloseButton_Click(object sender, RoutedEventArgs e)
        {
            // Клавиатура (Enter/Пробел) — тоже осознанное действие, его пропускаем.
            var byKeyboard = CloseButton.IsKeyboardFocused && !_pressStartedWhileEnabled
                             && System.Windows.Input.Mouse.LeftButton == System.Windows.Input.MouseButtonState.Released
                             && _keyboardActivated;

            if (!_pressStartedWhileEnabled && !byKeyboard)
            {
                Logger.Debug("Проигнорировано случайное срабатывание кнопки закрытия (нажатие началось до разблокировки)");
                return;
            }

            if (_enabledAt != null && DateTime.Now - _enabledAt.Value < _settleTime)
            {
                Logger.Debug("Проигнорирован тап сразу после разблокировки кнопки (защита от случайного касания)");
                _pressStartedWhileEnabled = false;
                return;
            }

            // Кассы сенсорные: одним случайным касанием закрыть обязательное оповещение
            // нельзя — нужно подтвердить вторым нажатием. Если второго не последовало,
            // кнопка через несколько секунд возвращается в обычное состояние.
            if (_confirmRequired && !_confirming)
            {
                _confirming = true;
                CloseButton.Content = "Нажмите ещё раз для подтверждения";
                HintText.Text = "Одного случайного касания недостаточно — подтвердите, что прочитали сообщение.";
                _confirmResetTimer.Stop();
                _confirmResetTimer.Start();
                _pressStartedWhileEnabled = false;
                return;
            }

            _confirmResetTimer.Stop();

            _allowClose = true;
            Close();
        }

        // PreviewKeyDown, а не KeyDown: кнопка сама обрабатывает Enter (и вызывает Click) в
        // своём OnKeyDown, до обычного KeyDown — флаг выставлялся уже после Click, и закрыть
        // окно с клавиатуры было нельзя вовсе (поймано на стенде, 0.1.8).
        private void CloseButton_KeyDown(object sender, System.Windows.Input.KeyEventArgs e)
        {
            if (e.Key == System.Windows.Input.Key.Enter || e.Key == System.Windows.Input.Key.Space)
            {
                _keyboardActivated = CloseButton.IsEnabled;
            }
        }

        // Перехватываем Closing, а не только кнопку: иначе окно закрывается через Alt+F4
        // или крестик в заголовке в обход таймера.
        private void OnClosing(object sender, CancelEventArgs e)
        {
            // В мягком режиме окно необязательное — закрытие крестиком считаем
            // подтверждением. В принудительном закрыть можно только кнопкой (и заголовка
            // с крестиком там вообще нет).
            if (!_forced) return;
            if (!_allowClose) e.Cancel = true;
        }
    }
}
