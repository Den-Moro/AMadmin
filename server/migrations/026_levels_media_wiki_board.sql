-- 1. Градация важности оповещений: четыре уровня вместо «важное / неважное».
--    info      — Информация: мягкое окно в углу, тихие часы действуют;
--    warning   — Внимание: как прежнее «неважное» (режим показа — по настройке);
--    important — Важно: принудительное окно поверх всех, тихие часы не действуют;
--    critical  — Критично: как «Важно», плюс звук всегда и показывается первым.
--    priority (important/normal) остаётся: его по-прежнему читают агенты старых версий,
--    сервер выводит его из level.
ALTER TABLE notifications ADD COLUMN level TEXT;
UPDATE notifications SET level = CASE priority WHEN 'important' THEN 'important' ELSE 'warning' END WHERE level IS NULL;
ALTER TABLE message_templates ADD COLUMN level TEXT;
UPDATE message_templates SET level = CASE priority WHEN 'important' THEN 'important' ELSE 'warning' END WHERE level IS NULL;

-- 2. Картинки (оповещения, шаблоны, статьи Wiki). Байты — в том же хранилище по
--    SHA-256, что и файлы для раскатки (data/files), но отдельной таблицей: картинки не
--    засоряют библиотеку «Файлы».
CREATE TABLE media (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    sha256 TEXT NOT NULL,
    original_name TEXT NOT NULL,
    mime TEXT NOT NULL,
    size INTEGER NOT NULL,
    width INTEGER,
    height INTEGER,
    uploaded_by INTEGER REFERENCES admin_users (id) ON DELETE SET NULL,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- Картинки оповещения/шаблона — JSON-массив id из media, по порядку показа.
ALTER TABLE notifications ADD COLUMN images TEXT;
ALTER TABLE message_templates ADD COLUMN images TEXT;

-- 3. Доска «Важная информация» на дашборде — для всех пользователей панели.
CREATE TABLE announcements (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    text TEXT NOT NULL,
    level TEXT NOT NULL DEFAULT 'info' CHECK (level IN ('info', 'warning', 'critical')),
    expires_at TEXT,
    created_by INTEGER REFERENCES admin_users (id) ON DELETE SET NULL,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT
);

-- 4. Мини-Wiki: разделы (с вложенностью) и статьи. Заменяет «Мануалы»: мануал —
--    это статья, которую можно приложить к оповещению.
CREATE TABLE wiki_sections (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    parent_id INTEGER REFERENCES wiki_sections (id) ON DELETE CASCADE,
    sort_order INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE wiki_articles (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    section_id INTEGER REFERENCES wiki_sections (id) ON DELETE SET NULL,
    title TEXT NOT NULL,
    body TEXT NOT NULL DEFAULT '',
    created_by INTEGER REFERENCES admin_users (id) ON DELETE SET NULL,
    updated_by INTEGER REFERENCES admin_users (id) ON DELETE SET NULL,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX idx_wiki_articles_section ON wiki_articles (section_id);

-- Мануалы переезжают в раздел «Инструкции для кассиров». Таблица manuals остаётся
-- нетронутой (данные не теряются), панель её больше не использует.
INSERT INTO wiki_sections (name, sort_order) VALUES ('Инструкции для кассиров', 10);
INSERT INTO wiki_articles (section_id, title, body, created_at, updated_at)
    SELECT (SELECT id FROM wiki_sections WHERE name = 'Инструкции для кассиров'), title, url_or_text, created_at, COALESCE(updated_at, created_at)
    FROM manuals;
INSERT INTO wiki_sections (name, sort_order) VALUES ('Для администраторов', 20);
