<?php

class AckController
{
    // POST /occurrences/{id}/ack
    // Тело запроса (опционально): {"reacted": true}
    // Идемпотентно: повторный ack от того же ПК на тот же occurrence не создаёт вторую
    // запись, а обновляет существующую (см. UNIQUE(occurrence_id, pc_id) в схеме) —
    // это защищает от дублей, если агент повторит запрос после обрыва сети.
    public static function store($occurrenceId)
    {
        $pc = Auth::authenticatePc();
        if (!$pc) {
            Logger::warning('POST /occurrences/' . $occurrenceId . '/ack: неверный или отсутствующий agent_token');
            http_response_code(401);
            echo json_encode(array('error' => 'invalid_token'));
            return;
        }

        $occurrenceId = (int) $occurrenceId;

        $stmt = Db::get()->prepare('SELECT id FROM notification_occurrences WHERE id = :id');
        $stmt->execute(array('id' => $occurrenceId));
        if (!$stmt->fetch()) {
            Logger::warning('POST /occurrences/' . $occurrenceId . '/ack: occurrence не найден (pc_id=' . $pc['id'] . ')');
            http_response_code(404);
            echo json_encode(array('error' => 'occurrence_not_found'));
            return;
        }

        // Occurrence существует, но относится ли она вообще к этому ПК? Без этой проверки
        // любой ПК с валидным токеном мог бы подтвердить чужое оповещение (другого
        // магазина/группы) и испортить статистику подтверждений.
        $checkSql = "
            SELECT 1
            FROM notification_occurrences o
            JOIN notifications n ON n.id = o.notification_id
            JOIN notification_targets t ON t.notification_id = n.id
            " . TargetMatcher::JOIN . "
            WHERE o.id = :occurrence_id
              AND " . TargetMatcher::CONDITION . "
            LIMIT 1
        ";
        $checkParams = TargetMatcher::params($pc);
        $checkParams['occurrence_id'] = $occurrenceId;

        $check = Db::get()->prepare($checkSql);
        $check->execute($checkParams);
        if (!$check->fetch()) {
            Logger::warning('POST /occurrences/' . $occurrenceId . '/ack: occurrence не таргетирован на pc_id=' . $pc['id']);
            http_response_code(403);
            echo json_encode(array('error' => 'occurrence_not_targeted'));
            return;
        }

        $body = json_decode(file_get_contents('php://input'), true);
        $reacted = (!empty($body['reacted'])) ? 1 : null;

        // ON CONFLICT — диалект SQLite для upsert (аналог MySQL-ного ON DUPLICATE KEY
        // UPDATE), опирается на UNIQUE(occurrence_id, pc_id) из схемы.
        $upsert = Db::get()->prepare('
            INSERT INTO notification_acks (occurrence_id, pc_id, acked_at, reacted)
            VALUES (:occurrence_id, :pc_id, CURRENT_TIMESTAMP, :reacted)
            ON CONFLICT (occurrence_id, pc_id) DO UPDATE SET
                acked_at = CURRENT_TIMESTAMP,
                reacted = excluded.reacted
        ');
        $upsert->execute(array(
            'occurrence_id' => $occurrenceId,
            'pc_id'         => $pc['id'],
            'reacted'       => $reacted,
        ));

        Logger::info('Ack: occurrence_id=' . $occurrenceId . ' pc_id=' . $pc['id'] . ' reacted=' . ($reacted ? '1' : '0'));

        echo json_encode(array('status' => 'ok'));
    }
}
