-- Начальная схема БД.
-- Здесь только цепочка "оповещения" (MVP + функционал из AGENTS.md).
-- Таблицы удалённого администрирования (commands/command_results) — отдельной миграцией
-- на соответствующем этапе (см. AGENTS.md, "Порядок работы", п.7), не сейчас.

SET NAMES utf8mb4;

-- Пользователи админ-панели. Нужна уже сейчас (не после MVP), т.к. notifications.created_by
-- ссылается на неё с первой миграции.
CREATE TABLE admin_users (
    id INT UNSIGNED NOT NULL AUTO_INCREMENT,
    username VARCHAR(100) NOT NULL,
    password_hash VARCHAR(255) NOT NULL,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (id),
    UNIQUE KEY uq_admin_users_username (username)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE stores (
    id INT UNSIGNED NOT NULL AUTO_INCREMENT,
    name VARCHAR(255) NOT NULL,
    is_pilot TINYINT(1) NOT NULL DEFAULT 0,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Справочник типов устройств — редактируется через админку (не хардкод), см. AGENTS.md
-- "Справочники". Отдельной таблицей, а не ENUM/VARCHAR на pcs, ещё и потому, что
-- notification_targets ссылается на неё числовым id при target_type = 'device_type'.
CREATE TABLE device_types (
    id INT UNSIGNED NOT NULL AUTO_INCREMENT,
    name VARCHAR(100) NOT NULL,
    PRIMARY KEY (id),
    UNIQUE KEY uq_device_types_name (name)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

INSERT INTO device_types (name) VALUES
    ('Касса'),
    ('ПК менеджера'),
    ('ПК администратора'),
    ('Другое');

CREATE TABLE pcs (
    id INT UNSIGNED NOT NULL AUTO_INCREMENT,
    store_id INT UNSIGNED NOT NULL,
    device_type_id INT UNSIGNED NOT NULL,
    hostname VARCHAR(255) NOT NULL,
    username VARCHAR(100) NULL,
    display_name VARCHAR(255) NULL,
    agent_token CHAR(64) NOT NULL,
    last_seen DATETIME NULL,
    agent_version VARCHAR(50) NULL,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (id),
    UNIQUE KEY uq_pcs_agent_token (agent_token),
    KEY idx_pcs_store_id (store_id),
    KEY idx_pcs_device_type_id (device_type_id),
    CONSTRAINT fk_pcs_store FOREIGN KEY (store_id) REFERENCES stores (id),
    CONSTRAINT fk_pcs_device_type FOREIGN KEY (device_type_id) REFERENCES device_types (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE host_groups (
    id INT UNSIGNED NOT NULL AUTO_INCREMENT,
    name VARCHAR(255) NOT NULL,
    PRIMARY KEY (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE host_group_members (
    group_id INT UNSIGNED NOT NULL,
    pc_id INT UNSIGNED NOT NULL,
    PRIMARY KEY (group_id, pc_id),
    KEY idx_hgm_pc_id (pc_id),
    CONSTRAINT fk_hgm_group FOREIGN KEY (group_id) REFERENCES host_groups (id) ON DELETE CASCADE,
    CONSTRAINT fk_hgm_pc FOREIGN KEY (pc_id) REFERENCES pcs (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE manuals (
    id INT UNSIGNED NOT NULL AUTO_INCREMENT,
    title VARCHAR(255) NOT NULL,
    url_or_text TEXT NOT NULL,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    PRIMARY KEY (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE notifications (
    id INT UNSIGNED NOT NULL AUTO_INCREMENT,
    text TEXT NOT NULL,
    priority ENUM('important','normal') NOT NULL DEFAULT 'normal',
    -- Текст инструкции или ссылка на неё; при выборе мануала из библиотеки его
    -- url_or_text просто копируется сюда (без FK на manuals — см. пояснение в чате).
    manual_url TEXT NULL,
    size ENUM('small','medium','large') NOT NULL DEFAULT 'medium',
    recurrence ENUM('once','daily','weekly','custom') NOT NULL DEFAULT 'once',
    recurrence_interval_minutes INT UNSIGNED NULL,
    created_by INT UNSIGNED NULL,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (id),
    KEY idx_notifications_created_by (created_by),
    CONSTRAINT fk_notifications_created_by FOREIGN KEY (created_by) REFERENCES admin_users (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Конкретный "показ" оповещения. Разово оповещение — одна строка сразу; регулярное —
-- сервер добавляет новую строку на каждый повтор по расписанию (см. cron-задачу позже).
-- Ack и статус доставки привязаны к occurrence, а не к notification, иначе повторяющееся
-- оповещение навсегда считалось бы подтверждённым после первого же ack.
CREATE TABLE notification_occurrences (
    id INT UNSIGNED NOT NULL AUTO_INCREMENT,
    notification_id INT UNSIGNED NOT NULL,
    fire_at DATETIME NOT NULL,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (id),
    KEY idx_occurrences_notification_id (notification_id),
    KEY idx_occurrences_fire_at (fire_at),
    CONSTRAINT fk_occurrences_notification FOREIGN KEY (notification_id) REFERENCES notifications (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- target_id полиморфный: смысл зависит от target_type (store->stores.id, group->host_groups.id,
-- pc->pcs.id, device_type->device_types.id, all->NULL). БД не может проверить FK на "плавающую"
-- таблицу — целостность этого поля проверяется в коде контроллера при создании оповещения.
CREATE TABLE notification_targets (
    id INT UNSIGNED NOT NULL AUTO_INCREMENT,
    notification_id INT UNSIGNED NOT NULL,
    target_type ENUM('all','store','group','pc','device_type') NOT NULL,
    target_id INT UNSIGNED NULL,
    PRIMARY KEY (id),
    KEY idx_targets_notification_id (notification_id),
    CONSTRAINT fk_targets_notification FOREIGN KEY (notification_id) REFERENCES notifications (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE notification_acks (
    id INT UNSIGNED NOT NULL AUTO_INCREMENT,
    occurrence_id INT UNSIGNED NOT NULL,
    pc_id INT UNSIGNED NOT NULL,
    acked_at DATETIME NOT NULL,
    reacted TINYINT(1) NULL,
    PRIMARY KEY (id),
    UNIQUE KEY uq_acks_occurrence_pc (occurrence_id, pc_id),
    KEY idx_acks_pc_id (pc_id),
    CONSTRAINT fk_acks_occurrence FOREIGN KEY (occurrence_id) REFERENCES notification_occurrences (id) ON DELETE CASCADE,
    CONSTRAINT fk_acks_pc FOREIGN KEY (pc_id) REFERENCES pcs (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
