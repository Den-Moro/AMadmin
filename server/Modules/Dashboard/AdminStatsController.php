<?php

// Сводка для дашборда: парк, активность за сутки, разбивка по магазинам и версиям
// агентов, последние события. Один запрос вместо десятка — дашборд обновляет её
// каждые 30 секунд, и на 3000 касс важно, чтобы это были несколько агрегатных SELECT,
// а не выгрузка всех ПК в браузер ради подсчёта.
class AdminStatsController
{
    // GET /admin/stats
    public static function index()
    {
        AdminAuth::requireLogin();

        $db = Db::get();
        $window = Settings::int('online_window_seconds', 180);

        $onlineExpr = "(p.last_seen IS NOT NULL AND (julianday('now') - julianday(p.last_seen)) * 86400.0 <= {$window})";

        // excluded_from_stats — планово недоступный хост (ремонт, переезд магазина и т.п.):
        // остаётся в списке «Хосты», но не портит общие проценты онлайн/офлайн здесь.
        $pcs = $db->query("
            SELECT COUNT(*) AS total,
                   SUM(CASE WHEN {$onlineExpr} THEN 1 ELSE 0 END) AS online,
                   SUM(CASE WHEN p.last_seen IS NULL THEN 1 ELSE 0 END) AS never_seen,
                   SUM(CASE WHEN p.last_seen IS NOT NULL AND (julianday('now') - julianday(p.last_seen)) > 1 THEN 1 ELSE 0 END) AS silent_day
            FROM pcs p
            WHERE p.excluded_from_stats = 0
        ")->fetch();

        // Условие исключения — в самом LEFT JOIN, не в WHERE: иначе магазин, где остались
        // только исключённые ПК, пропал бы из вывода целиком вместо total=0.
        $stores = $db->query("
            SELECT s.id, s.name, s.is_pilot,
                   COUNT(p.id) AS total,
                   SUM(CASE WHEN {$onlineExpr} THEN 1 ELSE 0 END) AS online
            FROM stores s
            LEFT JOIN pcs p ON p.store_id = s.id AND p.excluded_from_stats = 0
            GROUP BY s.id
            ORDER BY s.name
        ")->fetchAll();

        $versions = $db->query("
            SELECT COALESCE(agent_version, '—') AS version, COUNT(*) AS count
            FROM pcs WHERE excluded_from_stats = 0 GROUP BY agent_version ORDER BY count DESC
        ")->fetchAll();

        // current_agent_version не задана явно (свежая установка/ещё не заходили на
        // «Обновления») — считаем актуальной самую новую из реально отчитавшихся версий,
        // как раньше вычислялось на клиенте. Явно заданная версия админом всегда важнее.
        $baseline = Settings::get('current_agent_version', '');
        if ($baseline === '') {
            $baseline = null;
            foreach ($versions as $v) {
                if ($v['version'] === '—') {
                    continue;
                }
                if ($baseline === null || VersionCompare::compare($v['version'], $baseline) > 0) {
                    $baseline = $v['version'];
                }
            }
        }
        foreach ($versions as &$v) {
            $v['outdated'] = $baseline !== null && VersionCompare::isOutdated($v['version'], $baseline);
        }
        unset($v);

        $day = "datetime('now', '-1 day')";
        $activity = array(
            'notifications_24h' => (int) $db->query("SELECT COUNT(*) FROM notifications WHERE created_at >= {$day}")->fetchColumn(),
            'acks_24h'          => (int) $db->query("SELECT COUNT(*) FROM notification_acks WHERE acked_at >= {$day}")->fetchColumn(),
            'commands_24h'      => (int) $db->query("SELECT COUNT(*) FROM commands WHERE created_at >= {$day}")->fetchColumn(),
            'results_success_24h' => (int) $db->query("SELECT COUNT(*) FROM command_results WHERE executed_at >= {$day} AND status = 'success'")->fetchColumn(),
            'results_failed_24h'  => (int) $db->query("SELECT COUNT(*) FROM command_results WHERE executed_at >= {$day} AND status IN ('failed', 'timeout')")->fetchColumn(),
            'results_in_progress' => (int) $db->query("SELECT COUNT(*) FROM command_results WHERE status = 'in_progress'")->fetchColumn(),
            'files_count'       => (int) $db->query("SELECT COUNT(*) FROM deploy_files")->fetchColumn(),
            'files_bytes'       => (int) $db->query("SELECT COALESCE(SUM(size), 0) FROM deploy_files")->fetchColumn(),
            'groups'            => (int) $db->query("SELECT COUNT(*) FROM host_groups")->fetchColumn(),
            'admins'            => (int) $db->query("SELECT COUNT(*) FROM admin_users")->fetchColumn(),
        );

        // Лента последних событий: оповещения и команды вперемешку, по времени.
        $events = $db->query("
            SELECT * FROM (
                SELECT 'notification' AS kind, n.id, n.created_at AS at, n.text AS title, n.priority AS extra, u.username AS author
                FROM notifications n LEFT JOIN admin_users u ON u.id = n.created_by
                UNION ALL
                SELECT 'command' AS kind, c.id, c.created_at AS at, c.type AS title, c.payload AS extra, u.username AS author
                FROM commands c LEFT JOIN admin_users u ON u.id = c.created_by
            ) ORDER BY at DESC LIMIT 8
        ")->fetchAll();

        echo json_encode(array(
            'pcs'      => $pcs,
            'stores'   => $stores,
            'versions' => $versions,
            'agent_version_baseline' => $baseline,
            'activity' => $activity,
            'events'   => $events,
            'log_level' => Settings::get('log_level', 'debug'),
            'server_time' => gmdate('Y-m-d H:i:s'),
            'ntp' => self::ntpStatus(),
        ));
    }

    // Контроль расхождения часов сервера с NTP (см. NtpClient) — не чаще, чем раз в
    // ntp_check_interval_seconds, иначе дашборд на каждой перезагрузке долбил бы чужой
    // NTP-сервер. Результат кэшируется в файле рядом с БД, а не в settings — это не
    // настройка, а последний известный результат проверки.
    private static function ntpStatus()
    {
        if (!Settings::bool('ntp_enabled', false)) {
            return array(
                'enabled' => false, 'ok' => null, 'drift_seconds' => null,
                'threshold_seconds' => null, 'checked_at' => null, 'server' => null, 'error' => null,
            );
        }

        $server = Settings::get('ntp_server_address', 'pool.ntp.org');
        $threshold = Settings::int('ntp_drift_threshold_seconds', 5);
        $interval = Settings::int('ntp_check_interval_seconds', 300);
        $cacheFile = dirname(Config::get('db')['path']) . '/ntp-cache.json';

        $cached = null;
        if (is_file($cacheFile)) {
            $raw = json_decode(file_get_contents($cacheFile), true);
            if (is_array($raw) && isset($raw['checked_at']) && $raw['server'] === $server
                && (time() - strtotime($raw['checked_at'] . ' UTC')) < $interval) {
                $cached = $raw;
            }
        }

        if ($cached === null) {
            $result = NtpClient::checkDrift($server, 2);
            $cached = array(
                'checked_at' => gmdate('Y-m-d H:i:s'),
                'server' => $server,
                'ok' => $result['ok'],
                'drift_seconds' => $result['drift_seconds'],
                'error' => $result['error'],
            );
            @file_put_contents($cacheFile, json_encode($cached));
        }

        return array(
            'enabled' => true,
            'ok' => $cached['ok'],
            'drift_seconds' => $cached['drift_seconds'],
            'threshold_seconds' => $threshold,
            'checked_at' => $cached['checked_at'],
            'server' => $cached['server'],
            'error' => $cached['error'],
        );
    }
}
