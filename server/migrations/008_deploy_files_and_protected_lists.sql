-- Стандартные команды удалённого администрирования поверх инфраструктуры из 003:
-- диспетчер задач (process_action), скрипты (script_run) и доставка файлов (file_deploy).
-- Сами типы в CHECK таблицы commands уже были заложены в 003 — здесь только то, чего
-- не хватало: хранилище файлов для раскатки и настраиваемые "защитные" списки.

-- Файлы, которые администратор загрузил на сервер, чтобы разложить по кассам. Сам файл
-- лежит на диске в data/files/<sha256> (не в БД — SQLite и сотни мегабайт бинарников
-- плохо сочетаются), а здесь — только описание. Хеш нужен агенту: он сравнивает его с
-- хешем локального файла и качает только если они отличаются (см. AGENTS.md,
-- "Управление файлами со сравнением по хешу") — на узком канале за прокси это главное.
CREATE TABLE deploy_files (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    original_name TEXT NOT NULL,
    sha256 TEXT NOT NULL,
    size INTEGER NOT NULL,
    uploaded_by INTEGER REFERENCES admin_users (id),
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX idx_deploy_files_sha256 ON deploy_files (sha256);

-- Защитные списки для массовых команд (см. AGENTS.md, "Защита от массовой ошибки").
-- Раньше список служб был захардкожен в контроллере; теперь оба списка — настройки,
-- чтобы добавить, например, процесс кассовой программы "Профи-Т" можно было из панели,
-- не трогая код. Через запятую, регистр не важен, без расширения .exe.
INSERT INTO settings (key, value) VALUES
    -- Службы, которые нельзя остановить/перезапустить через панель.
    -- RpcSs/DcomLaunch/EventLog/Winmgmt — базовые службы Windows, без них ОС нестабильна.
    ('protected_services', 'RpcSs, DcomLaunch, EventLog, Winmgmt, AMadminAgent'),

    -- Процессы, которые нельзя завершить через панель. explorer/csrss/winlogon/wininit/
    -- smss/services/lsass/svchost/dwm — системные: один неверный клик положил бы
    -- explorer.exe на сотне касс разом. AMadmin.* — сами агенты.
    ('protected_processes', 'explorer, csrss, winlogon, wininit, smss, services, lsass, svchost, dwm, System, AMadmin.UiAgent, AMadmin.ManagementAgent'),

    -- Ограничение по времени на один скрипт (секунды). Долгие/интерактивные скрипты
    -- в первой версии не поддерживаются — агент убьёт процесс и вернёт статус timeout.
    ('script_timeout_seconds_default', '60');
