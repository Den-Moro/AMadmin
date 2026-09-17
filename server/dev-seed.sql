-- Только для локального теста эндпоинтов из шага 3. Не часть версионируемых миграций:
-- эндпоинта саморегистрации ПК ещё нет (появится вместе с клиентом, шаг 4), поэтому
-- тестовый магазин и ПК с известным agent_token заводим руками.
--
-- Тестовый токен для запросов (Authorization: Bearer ...):
-- 0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef

INSERT INTO stores (name, is_pilot) VALUES ('Тестовый магазин', 1);
SET @store_id = LAST_INSERT_ID();

INSERT INTO pcs (store_id, device_type_id, hostname, username, display_name, agent_token)
VALUES (
    @store_id,
    (SELECT id FROM device_types WHERE name = 'Касса'),
    'KASSA-TEST-01',
    'cashier',
    'Тестовая касса',
    '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef'
);

INSERT INTO notifications (text, priority, size)
VALUES ('Тестовое оповещение: идут плановые работы', 'important', 'medium');
SET @notification_id = LAST_INSERT_ID();

INSERT INTO notification_occurrences (notification_id, fire_at)
VALUES (@notification_id, NOW());

INSERT INTO notification_targets (notification_id, target_type, target_id)
VALUES (@notification_id, 'all', NULL);
