<?php

// Метрики ресурсов сервера для дашборда. Источник данных зависит от режима
// (ServerMode): в Docker — cgroup-метрики самого контейнера (v1 и v2 оба
// поддержаны), в Native на Windows — реальные ресурсы хоста через один вызов
// PowerShell. Результат кэшируется на CACHE_SECONDS — иначе дашборд с несколькими
// открытыми вкладками и 30-секундным авто-обновлением дёргал бы cgroup-файлы или
// (что дороже) спавнил бы PowerShell на каждый запрос.
class ServerMetrics
{
    const CACHE_SECONDS = 8;

    public static function collect()
    {
        $cacheFile = self::cacheFile();
        $cached = self::readCache($cacheFile);
        if ($cached !== null && (microtime(true) - $cached['collected_at_unix']) < self::CACHE_SECONDS) {
            return $cached['result'];
        }

        $prevRaw = $cached ? $cached['raw'] : array();
        $mode = ServerMode::current();

        if ($mode === 'docker') {
            list($result, $raw) = self::collectDocker($prevRaw);
        } elseif ($mode === 'native-windows') {
            list($result, $raw) = self::collectWindowsNative($prevRaw);
        } else {
            // Голый Linux без Docker — вне решённого при планировании объёма
            // (пользователь выбрал "авто по режиму": Docker или Windows Native).
            // Не падаем — просто отдаём пустые цифры с пометкой.
            $result = array(
                'cpu' => array('percent' => null, 'cores' => null, 'note' => 'не поддерживается в этом режиме'),
                'mem' => array('used_bytes' => null, 'limit_bytes' => null, 'percent' => null),
                'disk' => array('free_bytes' => null, 'total_bytes' => null, 'percent_used' => null),
                'connections' => array('tcp_count' => null),
                'traffic' => array('rx_bps' => null, 'tx_bps' => null),
                'uptime_seconds' => null,
                'ips' => self::localIps(),
            );
            $raw = array();
        }

        $result['mode'] = $mode;
        $result['collected_at'] = gmdate('Y-m-d H:i:s');

        self::writeCache($cacheFile, array(
            'collected_at_unix' => microtime(true),
            'result' => $result,
            'raw'    => $raw,
        ));

        return $result;
    }

    private static function cacheFile()
    {
        return dirname(Config::get('db')['path']) . '/server-metrics-cache.json';
    }

    private static function readCache($path)
    {
        if (!is_file($path)) {
            return null;
        }
        $data = json_decode((string) @file_get_contents($path), true);
        return is_array($data) && isset($data['collected_at_unix'], $data['result'], $data['raw']) ? $data : null;
    }

    private static function writeCache($path, $data)
    {
        @file_put_contents($path, json_encode($data));
    }

    // IP-адреса сервера — общее для Docker и Native: net_get_interfaces() (PHP 7.3+)
    // работает одинаково на Linux и Windows, без внешних утилит/WMI. 'family' на практике
    // приходит числом (AF_INET/AF_INET6/AF_PACKET), а не строкой 'ipv4' — надёжнее просто
    // проверить сам адрес как валидный IPv4, чем полагаться на конкретное числовое значение.
    private static function localIps()
    {
        $ips = array();
        if (function_exists('net_get_interfaces')) {
            $interfaces = @net_get_interfaces();
            if (is_array($interfaces)) {
                foreach ($interfaces as $info) {
                    if (empty($info['unicast'])) {
                        continue;
                    }
                    foreach ($info['unicast'] as $addr) {
                        if (!empty($addr['address']) && $addr['address'] !== '127.0.0.1'
                            && filter_var($addr['address'], FILTER_VALIDATE_IP, FILTER_FLAG_IPV4)) {
                            $ips[] = $addr['address'];
                        }
                    }
                }
            }
        }
        return array_values(array_unique($ips));
    }

    // Отметка первого запуска — /proc/uptime внутри контейнера показывает аптайм ХОСТА
    // (не пространство имён по умолчанию), поэтому для "аптайма" в Docker используем
    // свою метку, записанную при первом обращении.
    private static function appUptimeSeconds()
    {
        $marker = dirname(Config::get('db')['path']) . '/server-first-seen.txt';
        if (!is_file($marker)) {
            @file_put_contents($marker, (string) time());
        }
        $firstSeen = (int) trim((string) @file_get_contents($marker));
        return $firstSeen > 0 ? max(0, time() - $firstSeen) : 0;
    }

    // ---------------------------------------------------------------- Docker (cgroup) ---

    private static function collectDocker($prev)
    {
        $now = microtime(true);

        $cores = self::cpuCoreCount();
        $usageUsec = self::cpuUsageUsec();
        $cpuPercent = null;
        if ($usageUsec !== null && isset($prev['cpu_usage_usec'], $prev['at']) && $now > $prev['at']) {
            $deltaUsec = $usageUsec - $prev['cpu_usage_usec'];
            $deltaWallUsec = ($now - $prev['at']) * 1000000.0;
            if ($deltaWallUsec > 0 && $deltaUsec >= 0) {
                $cpuPercent = round(min(100, $deltaUsec / $deltaWallUsec / max(0.1, $cores) * 100), 1);
            }
        }

        $mem = self::memoryInfo();
        $diskFree = @disk_free_space('/');
        $diskTotal = @disk_total_space('/');
        $traffic = self::trafficTotals();

        $rxBps = null;
        $txBps = null;
        if ($traffic !== null && isset($prev['rx_bytes'], $prev['tx_bytes'], $prev['at']) && $now > $prev['at']) {
            $deltaT = $now - $prev['at'];
            if ($deltaT > 0) {
                $rxBps = max(0, (int) round(($traffic['rx_bytes'] - $prev['rx_bytes']) / $deltaT));
                $txBps = max(0, (int) round(($traffic['tx_bytes'] - $prev['tx_bytes']) / $deltaT));
            }
        }

        $result = array(
            'cpu' => array(
                'percent' => $cpuPercent, 'cores' => $cores,
                'note' => 'использование контейнера (cgroup), не всего хоста',
            ),
            'mem' => array(
                'used_bytes' => $mem['used_bytes'], 'limit_bytes' => $mem['limit_bytes'],
                'percent' => ($mem['used_bytes'] !== null && !empty($mem['limit_bytes']))
                    ? round($mem['used_bytes'] / $mem['limit_bytes'] * 100, 1) : null,
            ),
            'disk' => array(
                'free_bytes' => $diskFree !== false ? (int) $diskFree : null,
                'total_bytes' => $diskTotal !== false ? (int) $diskTotal : null,
                'percent_used' => ($diskFree !== false && $diskTotal)
                    ? round((1 - $diskFree / $diskTotal) * 100, 1) : null,
            ),
            'connections' => array('tcp_count' => self::tcpConnectionCount()),
            'traffic' => array('rx_bps' => $rxBps, 'tx_bps' => $txBps),
            'uptime_seconds' => self::appUptimeSeconds(),
            'ips' => self::localIps(),
        );

        $raw = array('at' => $now);
        if ($usageUsec !== null) {
            $raw['cpu_usage_usec'] = $usageUsec;
        }
        if ($traffic !== null) {
            $raw['rx_bytes'] = $traffic['rx_bytes'];
            $raw['tx_bytes'] = $traffic['tx_bytes'];
        }

        return array($result, $raw);
    }

    // Квота ядер, выделенных контейнеру (иначе процент считался бы от всех ядер
    // хоста, даже если контейнеру дали, скажем, пол-ядра) — v2 (cpu.max) или
    // v1 (cpu.cfs_quota_us/cpu.cfs_period_us), с откатом на число ядер /proc/cpuinfo.
    private static function cpuCoreCount()
    {
        if (is_file('/sys/fs/cgroup/cpu.max')) {
            $parts = preg_split('/\s+/', trim((string) @file_get_contents('/sys/fs/cgroup/cpu.max')));
            if (isset($parts[0], $parts[1]) && $parts[0] !== 'max' && (float) $parts[1] > 0) {
                return max(0.1, (float) $parts[0] / (float) $parts[1]);
            }
        } elseif (is_file('/sys/fs/cgroup/cpu/cpu.cfs_quota_us')) {
            $quota = (float) trim((string) @file_get_contents('/sys/fs/cgroup/cpu/cpu.cfs_quota_us'));
            $period = (float) trim((string) @file_get_contents('/sys/fs/cgroup/cpu/cpu.cfs_period_us'));
            if ($quota > 0 && $period > 0) {
                return max(0.1, $quota / $period);
            }
        }
        $cpuinfo = (string) @file_get_contents('/proc/cpuinfo');
        $n = preg_match_all('/^processor\s*:/m', $cpuinfo);
        return max(1, $n);
    }

    // Накопленное время CPU контейнера — usage_usec (v2) или cpuacct.usage в
    // наносекундах (v1, переводим в микросекунды для единообразия).
    private static function cpuUsageUsec()
    {
        if (is_file('/sys/fs/cgroup/cpu.stat')) {
            $stat = self::parseKeyValueFile('/sys/fs/cgroup/cpu.stat');
            return isset($stat['usage_usec']) ? (float) $stat['usage_usec'] : null;
        }
        if (is_file('/sys/fs/cgroup/cpuacct/cpuacct.usage')) {
            $ns = @file_get_contents('/sys/fs/cgroup/cpuacct/cpuacct.usage');
            return $ns !== false ? ((float) trim($ns)) / 1000.0 : null;
        }
        return null;
    }

    private static function parseKeyValueFile($path)
    {
        $out = array();
        foreach (explode("\n", (string) @file_get_contents($path)) as $line) {
            $parts = explode(' ', trim($line), 2);
            if (count($parts) === 2) {
                $out[$parts[0]] = trim($parts[1]);
            }
        }
        return $out;
    }

    private static function memoryInfo()
    {
        if (is_file('/sys/fs/cgroup/memory.current')) {
            $used = (float) trim((string) @file_get_contents('/sys/fs/cgroup/memory.current'));
            $maxRaw = trim((string) @file_get_contents('/sys/fs/cgroup/memory.max'));
            $limit = ($maxRaw === 'max' || $maxRaw === '') ? null : (float) $maxRaw;
            return array('used_bytes' => (int) $used, 'limit_bytes' => $limit !== null ? (int) $limit : null);
        }
        if (is_file('/sys/fs/cgroup/memory/memory.usage_in_bytes')) {
            $used = (float) trim((string) @file_get_contents('/sys/fs/cgroup/memory/memory.usage_in_bytes'));
            $limitRaw = (float) trim((string) @file_get_contents('/sys/fs/cgroup/memory/memory.limit_in_bytes'));
            // cgroup v1 отдаёт огромное число вместо "unlimited" — отсекаем как сантинел.
            $limit = ($limitRaw > 0 && $limitRaw < 1e15) ? (int) $limitRaw : null;
            return array('used_bytes' => (int) $used, 'limit_bytes' => $limit);
        }
        return array('used_bytes' => null, 'limit_bytes' => null);
    }

    // /proc/net/tcp(6) — по строке на соединение плюс строка заголовка.
    private static function tcpConnectionCount()
    {
        $count = 0;
        foreach (array('/proc/net/tcp', '/proc/net/tcp6') as $path) {
            $content = @file_get_contents($path);
            if ($content === false) {
                continue;
            }
            $lines = explode("\n", trim($content));
            $count += max(0, count($lines) - 1);
        }
        return $count;
    }

    // /proc/net/dev — суммируем rx/tx по всем интерфейсам кроме loopback.
    private static function trafficTotals()
    {
        $content = @file_get_contents('/proc/net/dev');
        if ($content === false) {
            return null;
        }
        $rx = 0;
        $tx = 0;
        foreach (explode("\n", $content) as $line) {
            if (strpos($line, ':') === false) {
                continue;
            }
            list($iface, $rest) = explode(':', $line, 2);
            if (trim($iface) === 'lo') {
                continue;
            }
            $fields = preg_split('/\s+/', trim($rest));
            if (count($fields) < 9) {
                continue;
            }
            $rx += (float) $fields[0];
            $tx += (float) $fields[8];
        }
        return array('rx_bytes' => $rx, 'tx_bytes' => $tx);
    }

    // ------------------------------------------------------------- Windows Native ---

    // Один вызов PowerShell вместо нескольких — на 3000-касcном стенде это всё ещё
    // дашборд одного администратора, но спавнить процесс на каждую метрику отдельно
    // незачем. Жёсткий предел 5 с: сам PowerShell + пара Get-CimInstance/WMI-запросов
    // на живой машине замерено занимает ~3 с (первый запуск после простоя — до 5 с),
    // так что 3 с оказались слишком строгим порогом и ловили бы обычную работу как
    // "не ответил"; результат всё равно кэшируется на 8 с, так что цена платится не
    // на каждый запрос дашборда, а раз в окно кэша.
    private static function collectWindowsNative($prev)
    {
        $script = <<<'PS1'
$ErrorActionPreference = 'SilentlyContinue'
$cpu = (Get-CimInstance Win32_Processor | Measure-Object -Property LoadPercentage -Average).Average
$os = Get-CimInstance Win32_OperatingSystem
$disk = Get-CimInstance Win32_LogicalDisk -Filter "DeviceID='C:'"
$net = Get-NetAdapterStatistics
$rx = ($net | Measure-Object -Property ReceivedBytes -Sum).Sum
$tx = ($net | Measure-Object -Property SentBytes -Sum).Sum
$tcp = (Get-NetTCPConnection).Count
[PSCustomObject]@{
    cpu_percent = $cpu
    mem_total_bytes = [int64]$os.TotalVisibleMemorySize * 1024
    mem_free_bytes = [int64]$os.FreePhysicalMemory * 1024
    disk_free_bytes = $disk.FreeSpace
    disk_total_bytes = $disk.Size
    rx_bytes = $rx
    tx_bytes = $tx
    tcp_count = $tcp
    boot_time = $os.LastBootUpTime.ToString('o')
} | ConvertTo-Json -Compress
PS1;

        $data = self::runPowerShell($script, 5.0);
        $now = microtime(true);

        if ($data === null) {
            return array(array(
                'cpu' => array('percent' => null, 'cores' => null, 'note' => 'PowerShell недоступен или не ответил за 5 с'),
                'mem' => array('used_bytes' => null, 'limit_bytes' => null, 'percent' => null),
                'disk' => array('free_bytes' => null, 'total_bytes' => null, 'percent_used' => null),
                'connections' => array('tcp_count' => null),
                'traffic' => array('rx_bps' => null, 'tx_bps' => null),
                'uptime_seconds' => null,
                'ips' => self::localIps(),
            ), array());
        }

        $memTotal = isset($data['mem_total_bytes']) ? (int) $data['mem_total_bytes'] : null;
        $memFree = isset($data['mem_free_bytes']) ? (int) $data['mem_free_bytes'] : null;
        $memUsed = ($memTotal !== null && $memFree !== null) ? max(0, $memTotal - $memFree) : null;

        $diskFree = isset($data['disk_free_bytes']) ? (int) $data['disk_free_bytes'] : null;
        $diskTotal = isset($data['disk_total_bytes']) ? (int) $data['disk_total_bytes'] : null;

        $rxBps = null;
        $txBps = null;
        if (isset($data['rx_bytes'], $data['tx_bytes']) && isset($prev['rx_bytes'], $prev['tx_bytes'], $prev['at']) && $now > $prev['at']) {
            $deltaT = $now - $prev['at'];
            if ($deltaT > 0) {
                $rxBps = max(0, (int) round(((float) $data['rx_bytes'] - $prev['rx_bytes']) / $deltaT));
                $txBps = max(0, (int) round(((float) $data['tx_bytes'] - $prev['tx_bytes']) / $deltaT));
            }
        }

        $uptimeSeconds = null;
        if (!empty($data['boot_time'])) {
            $boot = strtotime($data['boot_time']);
            if ($boot !== false) {
                $uptimeSeconds = max(0, time() - $boot);
            }
        }

        $result = array(
            'cpu' => array(
                'percent' => isset($data['cpu_percent']) && $data['cpu_percent'] !== null ? round((float) $data['cpu_percent'], 1) : null,
                'cores' => null, 'note' => 'загрузка хоста (Windows)',
            ),
            'mem' => array(
                'used_bytes' => $memUsed, 'limit_bytes' => $memTotal,
                'percent' => ($memUsed !== null && $memTotal) ? round($memUsed / $memTotal * 100, 1) : null,
            ),
            'disk' => array(
                'free_bytes' => $diskFree, 'total_bytes' => $diskTotal,
                'percent_used' => ($diskFree !== null && $diskTotal) ? round((1 - $diskFree / $diskTotal) * 100, 1) : null,
            ),
            'connections' => array('tcp_count' => isset($data['tcp_count']) ? (int) $data['tcp_count'] : null),
            'traffic' => array('rx_bps' => $rxBps, 'tx_bps' => $txBps),
            'uptime_seconds' => $uptimeSeconds,
            'ips' => self::localIps(),
        );

        $raw = array('at' => $now);
        if (isset($data['rx_bytes'])) {
            $raw['rx_bytes'] = (float) $data['rx_bytes'];
        }
        if (isset($data['tx_bytes'])) {
            $raw['tx_bytes'] = (float) $data['tx_bytes'];
        }

        return array($result, $raw);
    }

    // Запускает PowerShell как массив-команду (без участия shell — не нужно экранировать
    // кавычки), с жёстким пределом по времени. Возвращает разобранный JSON или null.
    private static function runPowerShell($script, $timeoutSeconds)
    {
        $descriptors = array(1 => array('pipe', 'w'), 2 => array('pipe', 'w'));
        $process = @proc_open(
            array('powershell.exe', '-NoProfile', '-NonInteractive', '-Command', $script),
            $descriptors,
            $pipes
        );
        if (!is_resource($process)) {
            return null;
        }

        stream_set_blocking($pipes[1], false);
        stream_set_blocking($pipes[2], false);

        $output = '';
        $deadline = microtime(true) + $timeoutSeconds;
        do {
            $output .= stream_get_contents($pipes[1]);
            $status = proc_get_status($process);
            if (!$status['running']) {
                break;
            }
            usleep(50000);
        } while (microtime(true) < $deadline);

        $output .= stream_get_contents($pipes[1]);
        $status = proc_get_status($process);
        fclose($pipes[1]);
        fclose($pipes[2]);
        if ($status['running']) {
            @proc_terminate($process);
            proc_close($process);
            return null;
        }
        proc_close($process);

        $data = json_decode(trim($output), true);
        return is_array($data) ? $data : null;
    }
}
