using System.Windows;
using AMadmin.Core;

namespace AMadmin.UiAgent
{
    // Простой запрос пароля защиты клиента (см. ClientLock). Не выходит из окна на
    // неверном пароле — чистит поле и даёт попробовать снова; лимита попыток нет, это
    // деterrent от "шаловливых рук", не защита от перебора (см. AGENTS.md).
    public partial class PasswordPromptWindow : Window
    {
        private readonly string _expectedHash;

        public bool Unlocked { get; private set; }

        public PasswordPromptWindow(string expectedHash)
        {
            InitializeComponent();
            _expectedHash = expectedHash;
            Loaded += (s, e) => PasswordBox.Focus();
        }

        private void Ok_Click(object sender, RoutedEventArgs e)
        {
            if (ClientLock.Verify(PasswordBox.Password, _expectedHash))
            {
                Unlocked = true;
                DialogResult = true;
            }
            else
            {
                ErrorText.Visibility = Visibility.Visible;
                PasswordBox.Clear();
                PasswordBox.Focus();
            }
        }

        private void Cancel_Click(object sender, RoutedEventArgs e)
        {
            DialogResult = false;
        }
    }
}
