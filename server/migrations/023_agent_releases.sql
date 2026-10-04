-- Версии агента (страница «Обновления»): номер, статус, что изменилось и набор файлов.
-- Раскатать можно любую сохранённую версию — в том числе старую, чтобы быстро
-- откатиться на стабильную. Сама раскатка — всё те же file_deploy-команды одной пачкой
-- (update_batch_id), агенту на кассе эти таблицы не нужны.
CREATE TABLE agent_releases (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    version TEXT NOT NULL UNIQUE,
    -- testing — проверяется на пилоте; stable — можно на все кассы, на неё откатываются;
    -- bad — отозвана (нашлась проблема), раскатывать нельзя.
    status TEXT NOT NULL DEFAULT 'testing' CHECK (status IN ('testing', 'stable', 'bad')),
    notes TEXT,
    created_by INTEGER REFERENCES admin_users (id) ON DELETE SET NULL,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    status_changed_at TEXT
);

-- Файлы версии — строки той же библиотеки deploy_files (байты хранятся один раз).
-- Имя файла на кассе = deploy_files.original_name, кладётся в папку агента.
CREATE TABLE agent_release_files (
    release_id INTEGER NOT NULL REFERENCES agent_releases (id) ON DELETE CASCADE,
    file_id INTEGER NOT NULL REFERENCES deploy_files (id),
    PRIMARY KEY (release_id, file_id)
);

-- Какой версии принадлежит пачка команд — для истории раскаток версии и подписи
-- «версия 0.1.6» в списке команд.
ALTER TABLE commands ADD COLUMN release_id INTEGER;

-- Версия из ресурса .exe/.dll (VS_FIXEDFILEINFO), читается при загрузке; у прочих файлов NULL.
ALTER TABLE deploy_files ADD COLUMN pe_version TEXT;

-- Папка агента на кассах по умолчанию (install-client.ps1 -InstallDir); меняется прямо
-- в мастере раскатки версии и запоминается.
INSERT OR IGNORE INTO settings (key, value) VALUES ('agent_install_dir', 'C:\AMadmin');
