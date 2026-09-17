-- Только для локального теста эндпоинтов. Не часть версионируемых миграций: эндпоинта
-- саморегистрации ПК ещё нет (появится вместе с клиентом), поэтому тестовый магазин и ПК
-- с известным agent_token заводим руками.
--
-- Тестовый токен для запросов (Authorization: Bearer ...):
-- 0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef
--
-- В SQLite нет пользовательских переменных (SET @x = ...), поэтому вместо LAST_INSERT_ID()
-- берём id последней вставленной строки нужной таблицы напрямую подзапросом — это надёжно
-- ровно потому, что скрипт рассчитан на пустую БД и выполняется один раз подряд.

INSERT INTO stores (name, is_pilot) VALUES ('Тестовый магазин', 1);

INSERT INTO pcs (store_id, device_type_id, hostname, username, display_name, agent_token)
VALUES (
    (SELECT id FROM stores ORDER BY id DESC LIMIT 1),
    (SELECT id FROM device_types WHERE name = 'Касса'),
    'KASSA-TEST-01',
    'cashier',
    'Тестовая касса',
    '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef'
);

INSERT INTO notifications (text, priority, size)
VALUES ('Тестовое оповещение: идут плановые работы', 'important', 'medium');

INSERT INTO notification_occurrences (notification_id, fire_at)
VALUES ((SELECT id FROM notifications ORDER BY id DESC LIMIT 1), CURRENT_TIMESTAMP);

INSERT INTO notification_targets (notification_id, target_type, target_id)
VALUES ((SELECT id FROM notifications ORDER BY id DESC LIMIT 1), 'all', NULL);
