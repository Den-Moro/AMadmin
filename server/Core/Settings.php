<?php

// Настройки из таблицы settings с кэшем на время запроса. Раньше каждый модуль
// делал свой SELECT по key — теперь одна точка, и «серверные» настройки (уровень
// лога, окно онлайна, блокировка входа) тоже живут здесь, а не в config.php: их
// можно менять из панели без доступа к файлам сервера.
class Settings
{
    private static $cache = null;

    // Ключи, которые меняют поведение самого сервера. Их правит только superadmin
    // (см. AdminSettingsController::update); остальные — administrator+.
    public static $serverKeys = array(
        'log_level',
        'online_window_seconds',
        'login_max_attempts',
        'login_lockout_minutes',
        'session_lifetime_hours',
        'command_output_max_kb',
        'command_ttl_hours',
    );

    public static function all()
    {
        if (self::$cache === null) {
            self::$cache = array();
            try {
                foreach (Db::get()->query('SELECT key, value FROM settings')->fetchAll() as $row) {
                    self::$cache[$row['key']] = $row['value'];
                }
            } catch (Exception $e) {
                // До первой миграции таблицы ещё нет — работаем на умолчаниях.
            }
        }
        return self::$cache;
    }

    public static function get($key, $default = null)
    {
        $all = self::all();
        return isset($all[$key]) && $all[$key] !== '' ? $all[$key] : $default;
    }

    public static function int($key, $default)
    {
        return (int) self::get($key, $default);
    }

    public static function bool($key, $default = false)
    {
        $v = self::get($key, null);
        return $v === null ? $default : $v === '1';
    }

    public static function forget()
    {
        self::$cache = null;
    }
}
