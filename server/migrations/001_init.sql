-- Начальная схема БД (SQLite).
-- Здесь только цепочка "оповещения" (MVP + функционал из AGENTS.md).
-- Таблицы удалённого администрирования (commands/command_results) — отдельной миграцией
-- на соответствующем этапе (см. AGENTS.md, "Порядок работы", п.7), не сейчас.

PRAGMA foreign_keys = ON;

-- Пользователи админ-панели. Нужна уже сейчас (не после MVP), т.к. notifications.created_by
-- ссылается на неё с первой миграции.
CREATE TABLE admin_users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT NOT NULL UNIQUE,
    password_hash TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE stores (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    is_pilot INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- Справочник типов устройств — редактируется через админку (не хардкод), см. AGENTS.md
-- "Справочники". Отдельной таблицей, а не строкой на pcs, ещё и потому, что
-- notification_targets ссылается на неё числовым id при target_type = 'device_type'.
CREATE TABLE device_types (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL UNIQUE
);

INSERT INTO device_types (name) VALUES
    ('Касса'),
    ('ПК менеджера'),
    ('ПК администратора'),
    ('Другое');

CREATE TABLE pcs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    store_id INTEGER NOT NULL REFERENCES stores (id),
    device_type_id INTEGER NOT NULL REFERENCES device_types (id),
    hostname TEXT NOT NULL,
    username TEXT,
    display_name TEXT,
    -- TEXT в SQLite по умолчанию сравнивается побайтово (COLLATE BINARY) — секретный
    -- токен должен сравниваться именно так, а не без учёта регистра.
    agent_token TEXT NOT NULL UNIQUE,
    last_seen TEXT,
    agent_version TEXT,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX idx_pcs_store_id ON pcs (store_id);
CREATE INDEX idx_pcs_device_type_id ON pcs (device_type_id);

CREATE TABLE host_groups (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL
);

CREATE TABLE host_group_members (
    group_id INTEGER NOT NULL REFERENCES host_groups (id) ON DELETE CASCADE,
    pc_id INTEGER NOT NULL REFERENCES pcs (id) ON DELETE CASCADE,
    PRIMARY KEY (group_id, pc_id)
);

CREATE INDEX idx_hgm_pc_id ON host_group_members (pc_id);

CREATE TABLE manuals (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    title TEXT NOT NULL,
    url_or_text TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- SQLite не поддерживает "ON UPDATE CURRENT_TIMESTAMP" в определении колонки —
-- тот же эффект даёт триггер.
CREATE TRIGGER trg_manuals_updated_at
AFTER UPDATE ON manuals
BEGIN
    UPDATE manuals SET updated_at = CURRENT_TIMESTAMP WHERE id = NEW.id;
END;

CREATE TABLE notifications (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    text TEXT NOT NULL,
    priority TEXT NOT NULL DEFAULT 'normal' CHECK (priority IN ('important', 'normal')),
    -- Текст инструкции или ссылка на неё; при выборе мануала из библиотеки его
    -- url_or_text просто копируется сюда (без FK на manuals — см. пояснение в чате).
    manual_url TEXT,
    size TEXT NOT NULL DEFAULT 'medium' CHECK (size IN ('small', 'medium', 'large')),
    recurrence TEXT NOT NULL DEFAULT 'once' CHECK (recurrence IN ('once', 'daily', 'weekly', 'custom')),
    recurrence_interval_minutes INTEGER,
    created_by INTEGER REFERENCES admin_users (id),
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX idx_notifications_created_by ON notifications (created_by);

-- Конкретный "показ" оповещения. Разово оповещение — одна строка сразу; регулярное —
-- сервер добавляет новую строку на каждый повтор по расписанию (см. cron-задачу позже).
-- Ack и статус доставки привязаны к occurrence, а не к notification, иначе повторяющееся
-- оповещение навсегда считалось бы подтверждённым после первого же ack.
CREATE TABLE notification_occurrences (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    notification_id INTEGER NOT NULL REFERENCES notifications (id) ON DELETE CASCADE,
    fire_at TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX idx_occurrences_notification_id ON notification_occurrences (notification_id);
CREATE INDEX idx_occurrences_fire_at ON notification_occurrences (fire_at);

-- target_id полиморфный: смысл зависит от target_type (store->stores.id, group->host_groups.id,
-- pc->pcs.id, device_type->device_types.id, all->NULL). БД не может проверить FK на "плавающую"
-- таблицу — целостность этого поля проверяется в коде контроллера при создании оповещения.
CREATE TABLE notification_targets (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    notification_id INTEGER NOT NULL REFERENCES notifications (id) ON DELETE CASCADE,
    target_type TEXT NOT NULL CHECK (target_type IN ('all', 'store', 'group', 'pc', 'device_type')),
    target_id INTEGER
);

CREATE INDEX idx_targets_notification_id ON notification_targets (notification_id);

CREATE TABLE notification_acks (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    occurrence_id INTEGER NOT NULL REFERENCES notification_occurrences (id) ON DELETE CASCADE,
    pc_id INTEGER NOT NULL REFERENCES pcs (id) ON DELETE CASCADE,
    acked_at TEXT NOT NULL,
    reacted INTEGER,
    UNIQUE (occurrence_id, pc_id)
);

CREATE INDEX idx_acks_pc_id ON notification_acks (pc_id);
