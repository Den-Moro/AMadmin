-- Блокировка admin_users после нескольких неудачных попыток входа (требование из
-- AGENTS.md, раздел про безопасность канала связи) — до этого шага в схеме не было
-- полей для отслеживания попыток.

ALTER TABLE admin_users ADD COLUMN failed_attempts INTEGER NOT NULL DEFAULT 0;
ALTER TABLE admin_users ADD COLUMN locked_until TEXT;
