<?php

class Db
{
    private static $pdo = null;

    public static function get()
    {
        if (self::$pdo === null) {
            $db = Config::get('db');
            self::$pdo = new PDO('sqlite:' . $db['path']);
            self::$pdo->setAttribute(PDO::ATTR_ERRMODE, PDO::ERRMODE_EXCEPTION);
            self::$pdo->setAttribute(PDO::ATTR_DEFAULT_FETCH_MODE, PDO::FETCH_ASSOC);
            // SQLite по умолчанию НЕ проверяет внешние ключи на каждом отдельном
            // соединении — без этого PRAGMA все FOREIGN KEY в схеме ничего не гарантируют.
            self::$pdo->exec('PRAGMA foreign_keys = ON');
        }

        return self::$pdo;
    }
}
