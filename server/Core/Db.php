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
            // 3000 касс опрашивают сервер каждые 30 с, и каждый опрос — запись last_seen.
            // В режиме WAL читатели не ждут писателя, а busy_timeout заставляет ждать
            // освобождения блокировки до 5 с вместо мгновенного "database is locked".
            self::$pdo->exec('PRAGMA journal_mode = WAL');
            self::$pdo->exec('PRAGMA busy_timeout = 5000');
        }

        return self::$pdo;
    }
}
