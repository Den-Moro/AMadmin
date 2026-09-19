<?php

// Где на диске лежат файлы для раскатки по кассам. Имя файла на диске — его sha256:
// два одинаковых файла, загруженных дважды, займут место один раз, а агент по тому же
// хешу решает, качать ли вообще. Папка — data/files рядом с БД: она уже в .gitignore и
// уже на docker-томе, отдельно ничего настраивать не нужно.
class FileStorage
{
    public static function dir()
    {
        $dir = dirname(Config::get('db')['path']) . '/files';
        if (!is_dir($dir)) {
            mkdir($dir, 0775, true);
        }
        return $dir;
    }

    public static function path($sha256)
    {
        // Хеш приходит из БД, но всё равно оставляем только hex — чтобы ни при каких
        // обстоятельствах тут не мог оказаться путь вроде "../config.php".
        return self::dir() . '/' . preg_replace('/[^a-f0-9]/', '', strtolower($sha256));
    }
}
