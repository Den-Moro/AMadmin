using System.Collections.Generic;
using System.Windows;
using System.Windows.Input;
using System.Windows.Media.Imaging;

namespace AMadmin.UiAgent
{
    // Картинка оповещения крупно — почти на весь рабочий стол (чтобы разглядеть мелкий
    // текст на скриншоте). Открывается модально поверх окна оповещения.
    public partial class ImageViewerWindow : Window
    {
        private readonly IList<BitmapSource> _images;
        private int _index;

        public ImageViewerWindow(IList<BitmapSource> images, int index)
        {
            InitializeComponent();
            _images = images;
            _index = index;

            var area = SystemParameters.WorkArea;
            Width = area.Width * 0.92;
            Height = area.Height * 0.92;

            var many = images.Count > 1;
            PrevButton.Visibility = many ? Visibility.Visible : Visibility.Collapsed;
            NextButton.Visibility = many ? Visibility.Visible : Visibility.Collapsed;
            KeyDown += OnKey;
            ShowAt(_index);
        }

        private void ShowAt(int index)
        {
            _index = (index + _images.Count) % _images.Count;
            Picture.Source = _images[_index];
            Counter.Text = _images.Count > 1 ? (_index + 1) + " из " + _images.Count : "";
        }

        private void OnKey(object sender, KeyEventArgs e)
        {
            if (e.Key == Key.Escape || e.Key == Key.Enter) Close();
            if (e.Key == Key.Right) ShowAt(_index + 1);
            if (e.Key == Key.Left) ShowAt(_index - 1);
        }

        private void Picture_Click(object sender, MouseButtonEventArgs e) { Close(); }
        private void Prev_Click(object sender, RoutedEventArgs e) { ShowAt(_index - 1); }
        private void Next_Click(object sender, RoutedEventArgs e) { ShowAt(_index + 1); }
        private void Close_Click(object sender, RoutedEventArgs e) { Close(); }
    }
}
