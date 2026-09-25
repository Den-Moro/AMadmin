<?php

// Определение узла (локальной сети) хоста по last_ip и настроенным CIDR-правилам
// узлов. При пересечении диапазонов побеждает более высокий priority, а при равном —
// более специфичная (длиннее префикс) подсеть, так что 192.168.1.0/24 бьёт
// 192.168.0.0/16 без необходимости вручную расставлять приоритеты в обычном случае.
// Только IPv4 — last_ip на практике всегда IPv4 (REMOTE_ADDR).
class NetworkSiteMatcher
{
    // $sites: [{id, cidr, priority}, ...]. Возвращает id подходящего узла или null
    // ("Без узла").
    public static function bestMatchingSite($ip, array $sites)
    {
        if ($ip === null || $ip === '') {
            return null;
        }

        $candidates = array();
        foreach ($sites as $site) {
            if (!empty($site['cidr']) && self::ipInCidr($ip, $site['cidr'])) {
                $candidates[] = $site;
            }
        }
        if (!$candidates) {
            return null;
        }

        usort($candidates, function ($a, $b) {
            $pa = (int) $a['priority'];
            $pb = (int) $b['priority'];
            if ($pa !== $pb) {
                return $pb - $pa; // выше приоритет — раньше
            }
            return self::prefixLength($b['cidr']) - self::prefixLength($a['cidr']); // длиннее префикс — раньше
        });

        return (int) $candidates[0]['id'];
    }

    public static function ipInCidr($ip, $cidr)
    {
        $parts = explode('/', $cidr, 2);
        $subnet = $parts[0];
        $bits = isset($parts[1]) ? (int) $parts[1] : 32;
        if ($bits < 0 || $bits > 32) {
            return false;
        }

        $ipLong = ip2long($ip);
        $subnetLong = ip2long($subnet);
        if ($ipLong === false || $subnetLong === false) {
            return false;
        }

        // Явная маска 32-битным числом без знака — ip2long отдаёт signed int на
        // 64-битном PHP, простой сдвиг ~0 << N мог бы разъехаться по знаку.
        $mask = $bits === 0 ? 0 : (0xFFFFFFFF << (32 - $bits)) & 0xFFFFFFFF;
        return (($ipLong & $mask) & 0xFFFFFFFF) === (($subnetLong & $mask) & 0xFFFFFFFF);
    }

    private static function prefixLength($cidr)
    {
        $parts = explode('/', $cidr, 2);
        return isset($parts[1]) ? (int) $parts[1] : 32;
    }
}
