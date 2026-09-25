-- Пароль защиты клиента от "шаловливых рук" (см. AGENTS.md, "Управление паролем
-- клиента") — хранится только хешем (PBKDF2, см. AdminSettingsController::update),
-- сам пароль сервер никогда не сохраняет. current_agent_version — версия, которая
-- считается актуальной (для "устаревшие агенты" и будущего обновления клиента).
INSERT INTO settings (key, value) VALUES
    ('client_lock_enabled', '0'),
    ('client_lock_password_hash', ''),
    ('current_agent_version', '');
