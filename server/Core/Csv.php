<?php

// Выгрузки для Excel. Русский Excel открывает двойным кликом CSV с разделителем «;» и
// понимает UTF-8, только если в начале файла есть BOM — иначе вместо кириллицы кракозябры.
class Csv
{
    // $rows — массив строк (первая — заголовки). Отдаёт файл и завершает ответ.
    public static function send($filename, array $rows)
    {
        header('Content-Type: text/csv; charset=utf-8');
        header('Content-Disposition: attachment; filename="' . $filename . '"');
        header('Cache-Control: no-store');
        echo "\xEF\xBB\xBF";
        foreach ($rows as $row) {
            echo implode(';', array_map(array('Csv', 'cell'), $row)) . "\r\n";
        }
    }

    private static function cell($value)
    {
        $s = $value === null ? '' : (string) $value;
        // Значение, начинающееся с = + - @, Excel принял бы за формулу (CSV-инъекция:
        // вывод скрипта с кассы мог бы выполнить формулу у администратора).
        if ($s !== '' && strpos('=+-@', $s[0]) !== false) {
            $s = "'" . $s;
        }
        return '"' . str_replace('"', '""', $s) . '"';
    }
}
