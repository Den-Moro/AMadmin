<?php

class Config
{
    private static $data = null;

    public static function get($key)
    {
        if (self::$data === null) {
            $path = __DIR__ . '/../config.php';
            if (!file_exists($path)) {
                throw new RuntimeException(
                    'config.php не найден — скопируйте config.example.php в config.php и заполните реальными данными'
                );
            }
            self::$data = require $path;
        }

        return isset(self::$data[$key]) ? self::$data[$key] : null;
    }
}
