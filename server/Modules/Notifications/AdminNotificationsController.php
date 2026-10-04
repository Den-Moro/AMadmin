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
                n.id, n.text, n.priority, n.size, n.manual_url, n.recurrence, n.created_at,
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
                    WHERE o2.notification_id = n.id) AS acks_count
            FROM notifications n
            LEFT JOIN notification_targets t ON t.notification_id = n.id
            GROUP BY n.id
            ORDER BY n.created_at DESC
            LIMIT 100
        ";

        echo json_encode(Db::get()->query($sql)->fetchAll());
    }

    // POST /admin/notifications
    // body: { text, priority, size, manual_url?, target: { type, id? }, fire_at? }
    // Пока только разовая рассылка (recurrence всегда 'once') — генерация повторов по
    // расписанию появится вместе с полным функционалом оповещений (шаг 6 плана).
    public static function store()
    {
        AdminAuth::requireLogin();

        $body = json_decode(file_get_contents('php://input'), true);

        $text = isset($body['text']) ? trim($body['text']) : '';
        $priority = isset($body['priority']) ? $body['priority'] : 'normal';
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

        $db = Db::get();
        $db->beginTransaction();

        try {
            $stmt = $db->prepare('
                INSERT INTO notifications (text, priority, manual_url, size, recurrence, created_by)
                VALUES (:text, :priority, :manual_url, :size, :recurrence, :created_by)
            ');
            $stmt->execute(array(
                'text'         => $text,
                'priority'     => $priority,
                'manual_url'   => $manualUrl,
                'size'         => $size,
                'recurrence'   => 'once',
                'created_by'   => $_SESSION['admin_id'],
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
            "таргет={$targetType}" . ($targetId ? ":{$targetId}" : '') . " priority={$priority} показ={$fireAt} UTC"
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
