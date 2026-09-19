<?php

// Настройки по умолчанию для новых оповещений (см. AGENTS.md, "Интерфейс настроек").
// Простая key-value таблица вместо отдельной подсистемы — осознанно, чтобы не усложнять
// архитектуру ради шести полей.
class AdminSettingsController
{
    // GET /admin/settings
    public static function index()
    {
        AdminAuth::requireLogin();

        $rows = Db::get()->query('SELECT key, value FROM settings')->fetchAll();

        $settings = array();
        foreach ($rows as $row) {
            $settings[$row['key']] = $row['value'];
        }

        echo json_encode($settings);
    }

    // PUT /admin/settings   body: { key1: value1, key2: value2, ... }
    // Обновляет только те ключи, что реально существуют в таблице (см. миграцию
    // 005_settings.sql) — так тело запроса не может завести произвольный новый ключ.
    public static function update()
    {
        // Настройки по умолчанию влияют на все будущие оповещения сразу — тот же уровень
        // риска, что и создание команд, поэтому та же роль.
        AdminAuth::requireRole(array('administrator', 'superadmin'));

        $body = json_decode(file_get_contents('php://input'), true);
        if (!is_array($body)) {
            http_response_code(400);
            echo json_encode(array('error' => 'invalid_body'));
            return;
        }

        $existing = Db::get()->query('SELECT key FROM settings')->fetchAll(PDO::FETCH_COLUMN);

        // Серверные ключи (уровень лога, блокировка входа, сессии) — только superadmin:
        // они влияют на безопасность самой панели, а не на поведение касс.
        foreach ($body as $key => $value) {
            if (in_array($key, Settings::$serverKeys, true) && $_SESSION['admin_role'] !== 'superadmin') {
                http_response_code(403);
                echo json_encode(array('error' => 'server_settings_require_superadmin', 'key' => $key));
                return;
            }
        }

        if (isset($body['log_level']) && !in_array($body['log_level'], array('debug', 'info', 'warning', 'error'), true)) {
            http_response_code(400);
            echo json_encode(array('error' => 'invalid_log_level'));
            return;
        }

        $stmt = Db::get()->prepare('UPDATE settings SET value = :value WHERE key = :key');
        foreach ($body as $key => $value) {
            if (!in_array($key, $existing, true)) {
                continue;
            }
            $stmt->execute(array('key' => $key, 'value' => (string) $value));
        }
        Settings::forget();

        Logger::info("Настройки обновлены автором='{$_SESSION['admin_username']}'");

        echo json_encode(array('status' => 'ok'));
    }
}
