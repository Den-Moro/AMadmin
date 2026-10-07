-- Смарт-группы, переменные хоста (обе — бета, только superadmin) и повторяющиеся
-- оповещения.

-- ---- Смарт-группы -------------------------------------------------------------------
-- Группа с kind = 'smart' не наполняется руками: её состав сервер сам пересчитывает по
-- правилам (rules — JSON, см. Core/SmartGroups.php) не реже раза в минуту и складывает
-- в ту же host_group_members. Поэтому оповещения, команды, файлы и фильтры «по группе»
-- работают со смарт-группами без единой правки — они читают состав как обычно.
ALTER TABLE host_groups ADD COLUMN kind TEXT NOT NULL DEFAULT 'static';
ALTER TABLE host_groups ADD COLUMN rules TEXT;
ALTER TABLE host_groups ADD COLUMN description TEXT;
-- Когда состав пересчитан в последний раз (UTC).
ALTER TABLE host_groups ADD COLUMN refreshed_at TEXT;

-- ---- Переменные хоста ---------------------------------------------------------------
-- Пары «имя = значение» на четырёх уровнях: все кассы (global), магазин, группа, касса.
-- Значение для конкретной кассы — с самого узкого уровня: касса > группа > магазин >
-- все. Подставляются в скрипты и пути файлов как {{ИМЯ}} в момент выдачи команды этой
-- кассе (CommandsController) и годятся как условия смарт-групп.
CREATE TABLE host_variables (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    scope TEXT NOT NULL CHECK (scope IN ('global', 'store', 'group', 'pc')),
    -- id магазина / группы / кассы; для global — NULL.
    scope_id INTEGER,
    name TEXT NOT NULL,
    value TEXT NOT NULL DEFAULT '',
    -- Секретное значение не показывается в списках панели (только по кнопке).
    is_secret INTEGER NOT NULL DEFAULT 0,
    note TEXT,
    updated_by INTEGER REFERENCES admin_users (id) ON DELETE SET NULL,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
-- Одно имя на уровень; имена без учёта регистра (как переменные среды Windows).
CREATE UNIQUE INDEX idx_host_variables_key ON host_variables (scope, IFNULL(scope_id, 0), name COLLATE NOCASE);

-- scope_id полиморфный, внешнего ключа нет — удаляем переменные вместе с владельцем.
CREATE TRIGGER trg_host_variables_pc_deleted AFTER DELETE ON pcs
BEGIN
    DELETE FROM host_variables WHERE scope = 'pc' AND scope_id = OLD.id;
END;
CREATE TRIGGER trg_host_variables_store_deleted AFTER DELETE ON stores
BEGIN
    DELETE FROM host_variables WHERE scope = 'store' AND scope_id = OLD.id;
END;
CREATE TRIGGER trg_host_variables_group_deleted AFTER DELETE ON host_groups
BEGIN
    DELETE FROM host_variables WHERE scope = 'group' AND scope_id = OLD.id;
END;

-- ---- Повторяющиеся оповещения -------------------------------------------------------
-- recurrence (daily / weekly / custom) была в схеме с самого начала; правило повтора —
-- JSON в repeat_rule (см. Core/Recurrence.php), очередной показ (occurrence) сервер
-- создаёт сам, когда подходит его время. Касса получает только последний наступивший
-- показ оповещения: пропущенные «вчерашние» напоминания не валятся пачкой.
ALTER TABLE notifications ADD COLUMN repeat_rule TEXT;
-- До какого момента повторять (UTC); NULL — пока не остановят.
ALTER TABLE notifications ADD COLUMN repeat_until TEXT;
-- Кнопка «Остановить повторы» (UTC).
ALTER TABLE notifications ADD COLUMN repeat_stopped_at TEXT;

-- ---- Фоновые задачи -----------------------------------------------------------------
-- Планировщика на сервере нет: раз в минуту задачу выполняет первый пришедший запрос
-- (Core/Housekeeping.php). Здесь — когда каждая задача выполнялась в последний раз.
CREATE TABLE housekeeping (
    job TEXT PRIMARY KEY,
    last_run TEXT NOT NULL DEFAULT '1970-01-01 00:00:00'
);
INSERT INTO housekeeping (job) VALUES ('smart_groups'), ('recurrence');
