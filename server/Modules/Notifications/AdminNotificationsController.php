<?php

class AdminNotificationsController
{
    // Касса p под цель t оповещения — то же, что TargetMatcher, но для всех касс сразу.
    const TARGETS_PC = "
        t.target_type = 'all'
        OR (t.target_type = 'store' AND t.target_id = p.store_id)
        OR (t.target_type = 'pc' AND t.target_id = p.id)
        OR (t.target_type = 'device_type' AND t.target_id = p.device_type_id)
        OR (t.target_type = 'group' AND EXISTS (SELECT 1 FROM host_group_members m WHERE m.group_id = t.target_id AND m.pc_id = p.id))
    ";

    // GET /admin/notifications — последние оповещения со сводными счётчиками.
    // Таблица подтверждений по каждому конкретному ПК — уже полный функционал
    // (см. AGENTS.md, шаг 6), пока только агрегаты.
    public static function index()
    {
        AdminAuth::requireLogin();

        // Кому ушло (имя цели) и сколько касс под цель подходит сейчас — чтобы история
        // сразу отвечала на «все ли увидели»: «подтвердили 5 из 7», а не голое «5».
        // Условие «касса под цель» — то же, что у агента (TargetMatcher), только для
        // всех касс сразу.
        $sql = "
            SELECT
                n.id, n.text, n.priority, COALESCE(n.level, CASE n.priority WHEN 'important' THEN 'important' ELSE 'warning' END) AS level,
                n.images, n.size, n.manual_url, n.recurrence, n.created_at,
                t.target_type, t.target_id,
                CASE t.target_type
                    WHEN 'store' THEN (SELECT name FROM stores WHERE id = t.target_id)
                    WHEN 'group' THEN (SELECT name FROM host_groups WHERE id = t.target_id)
                    WHEN 'device_type' THEN (SELECT name FROM device_types WHERE id = t.target_id)
                    WHEN 'pc' THEN (SELECT COALESCE(NULLIF(display_name, ''), hostname) FROM pcs WHERE id = t.target_id)
                END AS target_name,
                (SELECT COUNT(*) FROM pcs p WHERE " . self::TARGETS_PC . ") AS target_count,
                (SELECT MIN(o.fire_at) FROM notification_occurrences o WHERE o.notification_id = n.id) AS fire_at,
                (SELECT MIN(o.fire_at) FROM notification_occurrences o WHERE o.notification_id = n.id) > CURRENT_TIMESTAMP AS scheduled,
                (SELECT COUNT(*) FROM notification_occurrences o WHERE o.notification_id = n.id) AS occurrences_count,
                (SELECT COUNT(*) FROM notification_acks a
                    JOIN notification_occurrences o2 ON o2.id = a.occurrence_id
                    WHERE o2.notification_id = n.id) AS acks_count,
                -- Повторяющееся: подтверждения последнего наступившего показа — «все ли
                -- увидели сегодняшнее напоминание», а не сумма за все дни.
                n.repeat_rule, n.repeat_until, n.repeat_stopped_at,
                (SELECT MAX(o.fire_at) FROM notification_occurrences o WHERE o.notification_id = n.id) AS last_fire,
                (SELECT MAX(o.fire_at) FROM notification_occurrences o WHERE o.notification_id = n.id AND o.fire_at <= CURRENT_TIMESTAMP) AS last_shown_at,
                (SELECT COUNT(*) FROM notification_acks a3 WHERE a3.occurrence_id = (
                    SELECT o4.id FROM notification_occurrences o4
                    WHERE o4.notification_id = n.id AND o4.fire_at <= CURRENT_TIMESTAMP
                    ORDER BY o4.fire_at DESC LIMIT 1)) AS last_acks_count
            FROM notifications n
            LEFT JOIN notification_targets t ON t.notification_id = n.id
            GROUP BY n.id
            ORDER BY n.created_at DESC
            LIMIT 100
        ";

        $rows = Db::get()->query($sql)->fetchAll();
        foreach ($rows as &$row) {
            $row['images'] = MediaController::listFor($row['images']);
            $row['next_fire_at'] = $row['repeat_rule'] ? Recurrence::upcoming($row) : null;
            $row['repeat_rule'] = $row['repeat_rule'] ? json_decode($row['repeat_rule'], true) : null;
        }
        unset($row);
        echo json_encode($rows);
    }

    // Уровни важности (см. миграцию 026). priority — для агентов старых версий:
    // «Важно» и «Критично» для них «important», остальное — «normal».
    const LEVELS = array('info', 'warning', 'important', 'critical');

    public static function priorityOf($level)
    {
        return in_array($level, array('important', 'critical'), true) ? 'important' : 'normal';
    }

    // POST /admin/notifications
    // body: { text, level (или устаревшее priority), size, manual_url?, images?: [media id],
    //         target: { type, id? }, fire_at?, repeat?: {every, time?, days?, hours?}, repeat_until? }
    // С repeat — повторяющееся (Core/Recurrence.php): первый показ — ближайшее подходящее
    // время не раньше fire_at (или «сейчас»), дальше сервер создаёт показы сам.
    public static function store()
    {
        AdminAuth::requireLogin();

        $body = json_decode(file_get_contents('php://input'), true);

        $text = isset($body['text']) ? trim($body['text']) : '';
        $level = isset($body['level']) ? $body['level']
            : ((isset($body['priority']) && $body['priority'] === 'important') ? 'important' : 'warning');
        if (!in_array($level, self::LEVELS, true)) {
            http_response_code(400);
            echo json_encode(array('error' => 'invalid_level'));
            return;
        }
        $priority = self::priorityOf($level);
        $images = MediaController::normalizeIds(isset($body['images']) ? $body['images'] : null);
        $size = isset($body['size']) ? $body['size'] : 'medium';
        $manualUrl = (!empty($body['manual_url'])) ? trim($body['manual_url']) : null;
        // fire_at — когда показать (UTC, «Y-m-d H:i:s» или ISO 8601). Нет или уже прошло —
        // сразу. Строку целиком не доверяем: агент сравнивает fire_at с CURRENT_TIMESTAMP
        // как текст, кривой формат дал бы оповещение, которое не покажется никогда.
        $fireAt = date('Y-m-d H:i:s');
        if (!empty($body['fire_at'])) {
            $ts = strtotime((string) $body['fire_at']);
            if ($ts === false) {
                http_response_code(400);
                echo json_encode(array('error' => 'invalid_fire_at'));
                return;
            }
            if ($ts > time()) {
                $fireAt = gmdate('Y-m-d H:i:s', $ts);
            }
        }

        $target = isset($body['target']) && is_array($body['target']) ? $body['target'] : array();
        $targetType = isset($target['type']) ? $target['type'] : '';
        $targetId = (!empty($target['id'])) ? (int) $target['id'] : null;

        if ($text === '') {
            http_response_code(400);
            echo json_encode(array('error' => 'text_required'));
            return;
        }

        if (!in_array($priority, array('important', 'normal'), true)) {
            http_response_code(400);
            echo json_encode(array('error' => 'invalid_priority'));
            return;
        }

        if (!in_array($size, array('small', 'medium', 'large'), true)) {
            http_response_code(400);
            echo json_encode(array('error' => 'invalid_size'));
            return;
        }

        if (!in_array($targetType, array('all', 'store', 'group', 'pc', 'device_type'), true)) {
            http_response_code(400);
            echo json_encode(array('error' => 'invalid_target_type'));
            return;
        }

        if ($targetType !== 'all' && !$targetId) {
            http_response_code(400);
            echo json_encode(array('error' => 'target_id_required'));
            return;
        }

        // target_id полиморфный (см. TargetMatcher.php) — БД не проверяет его FK-констрейнтом,
        // поэтому здесь явно убеждаемся, что указанный id реально существует в нужной таблице.
        // Без этой проверки оповещение с опечаткой в id осталось бы "висеть", ни на кого не
        // таргетированным, без единой явной ошибки при создании.
        if ($targetType !== 'all' && !self::targetExists($targetType, $targetId)) {
            Logger::warning("Создание оповещения: target {$targetType}:{$targetId} не найден (автор='{$_SESSION['admin_username']}')");
            http_response_code(400);
            echo json_encode(array('error' => 'target_not_found'));
            return;
        }

        if (!SmartGroups::targetAllowed($targetType, $targetId)) {
            http_response_code(403);
            echo json_encode(array('error' => 'smart_group_requires_superadmin'));
            return;
        }

        // Повторы.
        $recurrence = 'once';
        $repeatRule = null;
        $repeatUntil = null;
        $intervalMinutes = null;
        if (!empty($body['repeat'])) {
            $checked = Recurrence::validate($body['repeat']);
            if (isset($checked['error'])) {
                http_response_code(400);
                echo json_encode(array('error' => $checked['error']));
                return;
            }
            $recurrence = $checked['recurrence'];
            $intervalMinutes = $checked['interval_minutes'];
            $repeatRule = $checked['rule'];
            if (!empty($body['repeat_until'])) {
                $ts = strtotime((string) $body['repeat_until']);
                if ($ts === false) {
                    http_response_code(400);
                    echo json_encode(array('error' => 'invalid_repeat_until'));
                    return;
                }
                $repeatUntil = gmdate('Y-m-d H:i:s', $ts);
            }
            $fireAt = Recurrence::first($repeatRule, $fireAt);
            if ($fireAt === null || ($repeatUntil !== null && $fireAt > $repeatUntil)) {
                http_response_code(400);
                echo json_encode(array('error' => 'repeat_never_fires'));
                return;
            }
        }

        $db = Db::get();
        $db->beginTransaction();

        try {
            $stmt = $db->prepare('
                INSERT INTO notifications (text, priority, level, images, manual_url, size, recurrence,
                                           recurrence_interval_minutes, repeat_rule, repeat_until, created_by)
                VALUES (:text, :priority, :level, :images, :manual_url, :size, :recurrence,
                        :interval_minutes, :repeat_rule, :repeat_until, :created_by)
            ');
            $stmt->execute(array(
                'text'             => $text,
                'priority'         => $priority,
                'level'            => $level,
                'images'           => $images,
                'manual_url'       => $manualUrl,
                'size'             => $size,
                'recurrence'       => $recurrence,
                'interval_minutes' => $intervalMinutes,
                'repeat_rule'      => $repeatRule ? json_encode($repeatRule) : null,
                'repeat_until'     => $repeatUntil,
                'created_by'       => $_SESSION['admin_id'],
            ));
            $notificationId = $db->lastInsertId();

            $stmt = $db->prepare('INSERT INTO notification_occurrences (notification_id, fire_at) VALUES (:id, :fire_at)');
            $stmt->execute(array('id' => $notificationId, 'fire_at' => $fireAt));
            $occurrenceId = $db->lastInsertId();

            $stmt = $db->prepare('INSERT INTO notification_targets (notification_id, target_type, target_id) VALUES (:id, :type, :target_id)');
            $stmt->execute(array(
                'id'        => $notificationId,
                'type'      => $targetType,
                'target_id' => $targetType === 'all' ? null : $targetId,
            ));

            $db->commit();
        } catch (Exception $e) {
            $db->rollBack();
            throw $e;
        }

        Logger::info(
            "Оповещение создано: id={$notificationId} автор='{$_SESSION['admin_username']}' " .
            "таргет={$targetType}" . ($targetId ? ":{$targetId}" : '') . " уровень={$level}" . ($images ? " картинки={$images}" : '') .
            ($repeatRule ? ' повтор=' . json_encode($repeatRule) . ($repeatUntil ? " до {$repeatUntil} UTC" : '') . ' первый' : '') . " показ={$fireAt} UTC"
        );

        echo json_encode(array('status' => 'ok', 'notification_id' => $notificationId, 'occurrence_id' => $occurrenceId));
    }

    // GET /admin/notifications/{id}/acks — кто из ПК уже подтвердил (по всем показам).
    public static function acks($id)
    {
        AdminAuth::requireLogin();
        $stmt = Db::get()->prepare('
            SELECT a.acked_at, a.reacted, p.id AS pc_id, p.hostname, p.display_name, s.name AS store_name
            FROM notification_acks a
            JOIN notification_occurrences o ON o.id = a.occurrence_id
            JOIN pcs p ON p.id = a.pc_id
            JOIN stores s ON s.id = p.store_id
            WHERE o.notification_id = :id
            ORDER BY a.acked_at DESC
        ');
        $stmt->execute(array('id' => (int) $id));
        echo json_encode($stmt->fetchAll());
    }

    // DELETE /admin/notifications/{id} — отозвать: кассы, которые ещё не показали окно,
    // его уже не получат; история подтверждений тех, кто успел, удаляется вместе с ним.
    public static function destroy($id)
    {
        AdminAuth::requireLogin();
        $stmt = Db::get()->prepare('DELETE FROM notifications WHERE id = :id');
        $stmt->execute(array('id' => (int) $id));
        if ($stmt->rowCount() === 0) {
            http_response_code(404);
            echo json_encode(array('error' => 'not_found'));
            return;
        }
        Logger::info("Оповещение id={$id} отозвано автором='{$_SESSION['admin_username']}'");
        echo json_encode(array('status' => 'ok'));
    }

    // POST /admin/notifications/{id}/stop — остановить повторы. Уже показанные остаются в
    // истории с подтверждениями; запланированный, но ещё не наступивший показ удаляется.
    public static function stopRepeat($id)
    {
        AdminAuth::requireLogin();
        $db = Db::get();
        $stmt = $db->prepare("UPDATE notifications SET repeat_stopped_at = CURRENT_TIMESTAMP WHERE id = :id AND recurrence <> 'once' AND repeat_stopped_at IS NULL");
        $stmt->execute(array('id' => (int) $id));
        if ($stmt->rowCount() === 0) {
            http_response_code(404);
            echo json_encode(array('error' => 'not_repeating'));
            return;
        }
        $db->prepare('DELETE FROM notification_occurrences WHERE notification_id = :id AND fire_at > CURRENT_TIMESTAMP')
            ->execute(array('id' => (int) $id));
        Logger::info("Повторы оповещения id={$id} остановлены автором='{$_SESSION['admin_username']}'");
        echo json_encode(array('status' => 'ok'));
    }

    // GET /admin/notifications/stats.csv?from=…&to=…&by=pc|store — выгрузка статистики
    // (ТЗ: «по ПК/магазину — количество полученных оповещений, подтверждений, явных
    // реакций, среднее время реакции»). Период — по времени показа, from/to — ISO 8601
    // или «Y-m-d H:i:s» (UTC); по умолчанию последние 30 дней.
    //
    // «Адресовано» — показы за период, под цель которых касса подходит (по её текущему
    // магазину и группам, как и в истории оповещений). Касса не сообщает «окно показано»
    // отдельно — показанное и закрытое она подтверждает (ack).
    public static function statsCsv()
    {
        AdminAuth::requireLogin();
        $to = !empty($_GET['to']) && strtotime($_GET['to']) !== false ? strtotime($_GET['to']) : time();
        $from = !empty($_GET['from']) && strtotime($_GET['from']) !== false ? strtotime($_GET['from']) : $to - 30 * 86400;
        $byStore = isset($_GET['by']) && $_GET['by'] === 'store';
        $params = array('from' => gmdate('Y-m-d H:i:s', $from), 'to' => gmdate('Y-m-d H:i:s', $to));

        $db = Db::get();
        $stmt = $db->prepare("
            SELECT p.id,
                   COUNT(DISTINCT o.id) AS addressed,
                   COUNT(DISTINCT a.id) AS acked,
                   COUNT(DISTINCT CASE WHEN a.reacted = 1 THEN a.id END) AS reacted,
                   COUNT(DISTINCT CASE WHEN COALESCE(n.level, n.priority) IN ('important', 'critical') THEN o.id END) AS important,
                   SUM(CASE WHEN a.id IS NOT NULL THEN (julianday(a.acked_at) - julianday(o.fire_at)) * 1440.0 END) AS reaction_sum,
                   MAX(a.acked_at) AS last_ack
            FROM pcs p
            JOIN notification_occurrences o ON o.fire_at >= :from AND o.fire_at < :to AND o.fire_at <= CURRENT_TIMESTAMP
            JOIN notifications n ON n.id = o.notification_id
            JOIN notification_targets t ON t.notification_id = o.notification_id AND (" . self::TARGETS_PC . ")
            LEFT JOIN notification_acks a ON a.occurrence_id = o.id AND a.pc_id = p.id
            GROUP BY p.id
        ");
        $stmt->execute($params);
        $stats = array();
        foreach ($stmt as $r) {
            $stats[(int) $r['id']] = $r;
        }

        $pcs = $db->query('
            SELECT p.id, p.hostname, p.display_name, p.excluded_from_stats, s.id AS store_id, s.name AS store_name
            FROM pcs p JOIN stores s ON s.id = p.store_id
            ORDER BY s.name, p.hostname
        ')->fetchAll();

        $fmtMin = function ($sum, $count) { return $count ? number_format($sum / $count, 1, ',', '') : ''; };
        $pct = function ($a, $b) { return $b ? round($a * 100 / $b) . '%' : ''; };
        $period = date('Ymd', $from) . '-' . date('Ymd', $to);

        if (!$byStore) {
            $out = array(array('Магазин', 'Касса', 'Hostname', 'Адресовано показов', 'Из них важных', 'Подтверждено', '% подтверждения',
                'Открыли инструкцию', 'Не подтверждено', 'Среднее время реакции, мин', 'Последнее подтверждение (UTC)', 'Исключена из статистики'));
            foreach ($pcs as $p) {
                $s = isset($stats[(int) $p['id']]) ? $stats[(int) $p['id']] : array('addressed' => 0, 'acked' => 0, 'reacted' => 0, 'important' => 0, 'reaction_sum' => 0, 'last_ack' => null);
                $out[] = array($p['store_name'], $p['display_name'] ?: $p['hostname'], $p['hostname'], (int) $s['addressed'], (int) $s['important'],
                    (int) $s['acked'], $pct($s['acked'], $s['addressed']), (int) $s['reacted'], (int) $s['addressed'] - (int) $s['acked'],
                    $fmtMin($s['reaction_sum'], (int) $s['acked']), $s['last_ack'], (int) $p['excluded_from_stats'] ? 'да' : '');
            }
            Csv::send('amadmin-stats-pcs-' . $period . '.csv', $out);
            return;
        }

        // По магазинам — суммы по его кассам (исключённые из статистики не считаются).
        $byStoreRows = array();
        foreach ($pcs as $p) {
            if ((int) $p['excluded_from_stats']) {
                continue;
            }
            $k = (int) $p['store_id'];
            if (!isset($byStoreRows[$k])) {
                $byStoreRows[$k] = array('name' => $p['store_name'], 'pcs' => 0, 'addressed' => 0, 'acked' => 0, 'reacted' => 0, 'important' => 0, 'reaction_sum' => 0.0, 'silent' => 0);
            }
            $row = &$byStoreRows[$k];
            $row['pcs']++;
            if (isset($stats[(int) $p['id']])) {
                $s = $stats[(int) $p['id']];
                $row['addressed'] += (int) $s['addressed'];
                $row['acked'] += (int) $s['acked'];
                $row['reacted'] += (int) $s['reacted'];
                $row['important'] += (int) $s['important'];
                $row['reaction_sum'] += (float) $s['reaction_sum'];
                if ((int) $s['addressed'] > 0 && (int) $s['acked'] === 0) {
                    $row['silent']++;
                }
            }
            unset($row);
        }
        $out = array(array('Магазин', 'Касс', 'Адресовано показов', 'Из них важных', 'Подтверждено', '% подтверждения', 'Открыли инструкцию',
            'Не подтверждено', 'Среднее время реакции, мин', 'Касс без единого подтверждения'));
        foreach ($byStoreRows as $r) {
            $out[] = array($r['name'], $r['pcs'], $r['addressed'], $r['important'], $r['acked'], $pct($r['acked'], $r['addressed']), $r['reacted'],
                $r['addressed'] - $r['acked'], $fmtMin($r['reaction_sum'], $r['acked']), $r['silent']);
        }
        Csv::send('amadmin-stats-stores-' . $period . '.csv', $out);
    }

    private static function targetExists($type, $id)
    {
        // Фиксированный список — $type уже проверен через in_array выше, но имя таблицы
        // всё равно берём из этой белой карты, а не собираем из ввода напрямую.
        $table = array(
            'store'       => 'stores',
            'group'       => 'host_groups',
            'pc'          => 'pcs',
            'device_type' => 'device_types',
        );

        if (!isset($table[$type])) {
            return false;
        }

        $stmt = Db::get()->prepare('SELECT 1 FROM ' . $table[$type] . ' WHERE id = :id');
        $stmt->execute(array('id' => $id));

        return (bool) $stmt->fetch();
    }
}
