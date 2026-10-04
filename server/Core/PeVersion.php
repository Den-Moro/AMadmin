<?php

// Версия из исполняемого файла Windows (.exe/.dll) — без запуска и без расширений PHP.
// У каждой сборки с ресурсом версии есть структура VS_FIXEDFILEINFO с сигнатурой
// 0xFEEF04BD, сразу за ней — dwStrucVersion и FileVersion (MS/LS: по два 16-битных
// числа). Агент сообщает о себе Version.ToString(3) — поэтому и здесь три части.
class PeVersion
{
    // Файлы больше этого не читаем: агентские .exe/.dll — сотни КБ, а ресурс версии
    // в больших установщиках может быть где угодно — версия им не нужна.
    const MAX_BYTES = 33554432; // 32 МБ

    // '0.1.6' или null, если это не PE-файл или ресурса версии нет.
    public static function read($path)
    {
        if (!is_file($path) || filesize($path) > self::MAX_BYTES) {
            return null;
        }
        $data = file_get_contents($path);
        if ($data === false || substr($data, 0, 2) !== 'MZ') {
            return null;
        }
        $pos = strpos($data, "\xBD\x04\xEF\xFE");
        if ($pos === false || strlen($data) < $pos + 16) {
            return null;
        }
        $v = unpack('Vsig/Vstruc/Vms/Vls', substr($data, $pos, 16));
        return sprintf('%d.%d.%d', ($v['ms'] >> 16) & 0xFFFF, $v['ms'] & 0xFFFF, ($v['ls'] >> 16) & 0xFFFF);
    }
}
