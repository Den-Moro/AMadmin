<?php

class OccurrencesController
{
    // GET /occurrences
    // Возвращает для текущего ПК (определяется по Bearer-токену) список показов
    // оповещений, которые уже наступили (fire_at <= NOW()) и на которые от этого ПК
    // ещё нет ack. Таргетинг — см. TargetMatcher.
    public static function index()
    {
        $pc = Auth::authenticatePc();
        if (!$pc) {
            Logger::warning('GET /occurrences: неверный или отсутствующий agent_token');
            http_response_code(401);
            echo json_encode(array('error' => 'invalid_token'));
            return;
        }

        // Одновременно и heartbeat: last_seen обновляется на каждом опросе.
        $update = Db::get()->prepare('UPDATE pcs SET last_seen = CURRENT_TIMESTAMP WHERE id = :id');
        $update->execute(array('id' => $pc['id']));

        $sql = "
            SELECT DISTINCT
                o.id AS occurrence_id,
                n.text,
                n.priority,
                n.manual_url,
                n.size,
                o.fire_at
            FROM notification_occurrences o
            JOIN notifications n ON n.id = o.notification_id
            JOIN notification_targets t ON t.notification_id = n.id
            " . TargetMatcher::JOIN . "
            LEFT JOIN notification_acks a ON a.occurrence_id = o.id AND a.pc_id = :ack_pc_id
            WHERE o.fire_at <= CURRENT_TIMESTAMP
              AND a.id IS NULL
              AND " . TargetMatcher::CONDITION . "
            ORDER BY (n.priority = 'important') DESC, o.fire_at ASC
        ";
        // (n.priority = 'important') DESC — в MySQL булево выражение даёт 0/1,
        // так важные оповещения оказываются раньше неважных без CASE.

        $params = TargetMatcher::params($pc);
        $params['ack_pc_id'] = $pc['id'];

        $stmt = Db::get()->prepare($sql);
        $stmt->execute($params);
        $rows = $stmt->fetchAll();

        Logger::debug('GET /occurrences: pc_id=' . $pc['id'] . ' отдано=' . count($rows));

        echo json_encode($rows);
    }
}
