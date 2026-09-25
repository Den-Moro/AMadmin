<?php

// Сравнение версий агента вида "X.Y.Z" по числам, а не по строке — иначе "0.10.0"
// оказался бы "меньше" "0.9.0". Раньше это же считалось на клиенте в dashboard.js —
// вынесено сюда, чтобы дашборд и страница «Обновления» пользовались одной логикой.
class VersionCompare
{
    // -1, 0, 1 — как обычно ждут от компаратора.
    public static function compare($a, $b)
    {
        $pa = self::parse($a);
        $pb = self::parse($b);
        for ($i = 0; $i < 3; $i++) {
            if ($pa[$i] !== $pb[$i]) {
                return $pa[$i] < $pb[$i] ? -1 : 1;
            }
        }
        return 0;
    }

    // true, только если $version однозначно старше $current. Пустая/нераспознанная
    // версия ($version — агент ни разу не отчитался, обычно приходит как плейсхолдер
    // '—'; $current — актуальная ещё не задана) — не "устаревшая", это другое
    // состояние, отдельно видно на дашборде. Проверяем не только null/'', но и что
    // строка вообще похожа на версию (начинается с цифры) — иначе '—' через intval()
    // молча превратился бы в 0.0.0 и попал бы в "устаревшие" наравне с реальным 0.0.1.
    public static function isOutdated($version, $current)
    {
        if (!self::isValid($version) || !self::isValid($current)) {
            return false;
        }
        return self::compare($version, $current) < 0;
    }

    private static function isValid($version)
    {
        return $version !== null && preg_match('/^\d/', (string) $version) === 1;
    }

    private static function parse($version)
    {
        $parts = array_map('intval', explode('.', (string) $version));
        while (count($parts) < 3) {
            $parts[] = 0;
        }
        return array_slice($parts, 0, 3);
    }
}
