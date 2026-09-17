<?php

class Db
{
    private static $pdo = null;

    public static function get()
    {
        if (self::$pdo === null) {
            $db = Config::get('db');
            $dsn = sprintf('mysql:host=%s;dbname=%s;charset=%s', $db['host'], $db['name'], $db['charset']);
            self::$pdo = new PDO($dsn, $db['user'], $db['pass'], array(
                PDO::ATTR_ERRMODE            => PDO::ERRMODE_EXCEPTION,
                PDO::ATTR_DEFAULT_FETCH_MODE => PDO::FETCH_ASSOC,
            ));
        }

        return self::$pdo;
    }
}
