-- Шаблоны типовых сообщений (AGENTS.md: «Шаблоны типовых сообщений», сценарий
-- администратора, шаги 3 и 8): типовое оповещение отправляется за секунды — выбрать
-- шаблон, поправить время, выбрать кому. Шаблон хранит текст, важность, размер окна и
-- мануал; при отправке всё копируется в оповещение, поздняя правка шаблона уже
-- отправленное не меняет.
CREATE TABLE message_templates (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    title TEXT NOT NULL,
    text TEXT NOT NULL,
    priority TEXT NOT NULL DEFAULT 'normal' CHECK (priority IN ('normal', 'important')),
    size TEXT NOT NULL DEFAULT 'medium' CHECK (size IN ('small', 'medium', 'large')),
    manual_url TEXT,
    sort_order INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- Стартовый набор. Места в [квадратных скобках] панель попросит заполнить перед отправкой.
INSERT INTO message_templates (title, text, priority, size, sort_order) VALUES
    ('Плановые работы',
     'Сегодня с [время] до [время] проводятся плановые технические работы. Касса может ненадолго перезагрузиться — дождитесь окончания и продолжайте работу.',
     'important', 'medium', 10),
    ('Работы завершены',
     'Технические работы завершены, всё работает в обычном режиме. Спасибо за терпение!',
     'normal', 'small', 20),
    ('Не выключайте кассу на ночь',
     'Сегодня после закрытия не выключайте кассу: ночью будет установлено обновление.',
     'important', 'medium', 30),
    ('Перебои с оплатой картой',
     'Сейчас возможны перебои с оплатой банковскими картами. Предлагайте покупателям оплату наличными — мы уже решаем проблему.',
     'important', 'medium', 40);
