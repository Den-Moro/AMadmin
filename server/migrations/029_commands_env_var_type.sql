-- Новый тип команды env_var — переменные среды Windows на кассах (бета, только
-- superadmin, агент 0.2.0+). Тип команды ограничен CHECK ещё в 003, а изменить CHECK
-- в SQLite нельзя — таблица пересобирается по стандартной процедуре SQLite: новая
-- таблица → копия данных → замена старой. Внешние ключи на это время выключены, иначе
-- DROP TABLE каскадом снёс бы command_results; ссылка command_results → commands после
-- переименования указывает на новую таблицу.
PRAGMA foreign_keys = OFF;

BEGIN;

CREATE TABLE commands_new (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    type TEXT NOT NULL CHECK (type IN ('service_control', 'process_action', 'file_deploy', 'script_run', 'env_var')),
    payload TEXT NOT NULL, -- JSON, формат зависит от type
    target_type TEXT NOT NULL CHECK (target_type IN ('all', 'store', 'group', 'pc', 'device_type')),
    target_id INTEGER,
    created_by INTEGER REFERENCES admin_users (id),
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    update_batch_id TEXT,
    release_id INTEGER
);

INSERT INTO commands_new (id, type, payload, target_type, target_id, created_by, created_at, update_batch_id, release_id)
SELECT id, type, payload, target_type, target_id, created_by, created_at, update_batch_id, release_id FROM commands;

DROP TABLE commands;
ALTER TABLE commands_new RENAME TO commands;

CREATE INDEX idx_commands_created_by ON commands (created_by);
CREATE INDEX idx_commands_created_at ON commands (created_at);

COMMIT;

PRAGMA foreign_keys = ON;
