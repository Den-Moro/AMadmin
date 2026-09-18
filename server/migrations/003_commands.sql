-- Инфраструктура удалённого администрирования (шаг 7 плана). Сначала только сами
-- таблицы + generic-протокол claim/result; конкретные типы команд (services, дальше —
-- диспетчер задач, файлы, скрипты) добавляются поверх этого по очереди.

CREATE TABLE commands (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    type TEXT NOT NULL CHECK (type IN ('service_control', 'process_action', 'file_deploy', 'script_run')),
    payload TEXT NOT NULL, -- JSON, формат зависит от type
    target_type TEXT NOT NULL CHECK (target_type IN ('all', 'store', 'group', 'pc', 'device_type')),
    target_id INTEGER,
    created_by INTEGER REFERENCES admin_users (id),
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX idx_commands_created_by ON commands (created_by);
CREATE INDEX idx_commands_created_at ON commands (created_at);

-- Один command может выполняться на многих хостах сразу — статус и результат у каждого
-- хоста свои, ровно по той же причине, по которой notification_acks разведён с
-- notifications (см. миграцию 001). UNIQUE(command_id, pc_id) — тот же приём для
-- идемпотентности: агент сначала "застолбит" строку (claim, status=in_progress) через
-- INSERT, и только потом выполняет команду. Если агент упадёт после выполнения, но до
-- отправки финального статуса, повторный INSERT при следующем опросе упрётся в этот
-- UNIQUE — агент поймёт "уже застолблено" и не выполнит команду дважды, вместо того
-- чтобы создавать вторую попытку с нуля.
CREATE TABLE command_results (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    command_id INTEGER NOT NULL REFERENCES commands (id) ON DELETE CASCADE,
    pc_id INTEGER NOT NULL REFERENCES pcs (id) ON DELETE CASCADE,
    status TEXT NOT NULL DEFAULT 'in_progress' CHECK (status IN ('in_progress', 'success', 'failed', 'timeout')),
    output TEXT,
    claimed_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    executed_at TEXT,
    UNIQUE (command_id, pc_id)
);

CREATE INDEX idx_command_results_pc_id ON command_results (pc_id);
CREATE INDEX idx_command_results_command_id ON command_results (command_id);
