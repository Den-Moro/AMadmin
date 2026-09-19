<?php

class CommandsController
{
    // Потолок на вывод одной команды с одного ПК (байт) — см. result().
    const MAX_OUTPUT_BYTES = 65536;

    // GET /commands
    // Команды для этого ПК (по Bearer-токену — тот же agent_token, что и у UI-агента,
    // токен привязан к ПК, а не к конкретному процессу на нём), на которые от этого ПК
    // ещё нет ни одной строки в command_results — т.е. ещё не "застолблены" (claim) и не
    // выполнены. "pending" в терминах AGENTS.md — это именно отсутствие строки, не статус.
    public static function index()
    {
        $pc = Auth::authenticatePc();
        if (!$pc) {
            Logger::warning('GET /commands: неверный или отсутствующий agent_token');
            http_response_code(401);
            echo json_encode(array('error' => 'invalid_token'));
            return;
        }

        $rows = self::commandsForPc($pc, true);

        Logger::debug('GET /commands: pc_id=' . $pc['id'] . ' отдано=' . count($rows));

        echo json_encode($rows);
    }

    // Команды, адресованные этому ПК. $onlyPending = true — только те, на которые от
    // этого ПК ещё нет строки в command_results (то, что отдаём агенту на выполнение);
    // false — все адресованные, включая уже застолблённые (нужно, например, чтобы
    // проверить право агента скачать файл из уже взятой в работу команды).
    //
    // Таргетинг похож на TargetMatcher, но commands хранит target_type/target_id
    // прямо на своей строке (не через отдельную join-таблицу, как
    // notification_targets), поэтому условие здесь своё, не переиспользует класс.
    public static function commandsForPc($pc, $onlyPending)
    {
        $sql = "
            SELECT c.id, c.type, c.payload, c.created_at
            FROM commands c
            LEFT JOIN command_results r ON r.command_id = c.id AND r.pc_id = :pc_id1
            LEFT JOIN host_group_members hgm ON hgm.pc_id = :pc_id2 AND hgm.group_id = c.target_id
            WHERE " . ($onlyPending ? 'r.id IS NULL' : '1 = 1') . "
              AND (
                    c.target_type = 'all'
                 OR (c.target_type = 'store' AND c.target_id = :store_id)
                 OR (c.target_type = 'pc' AND c.target_id = :pc_id3)
                 OR (c.target_type = 'device_type' AND c.target_id = :device_type_id)
                 OR (c.target_type = 'group' AND hgm.pc_id IS NOT NULL)
              )
            ORDER BY c.created_at ASC
        ";

        $stmt = Db::get()->prepare($sql);
        $stmt->execute(array(
            'pc_id1'         => $pc['id'],
            'pc_id2'         => $pc['id'],
            'pc_id3'         => $pc['id'],
            'store_id'       => $pc['store_id'],
            'device_type_id' => $pc['device_type_id'],
        ));

        return $stmt->fetchAll();
    }

    // POST /commands/{id}/claim
    // "Застолбить" команду перед выполнением — см. пояснение про идемпотентность
    // в миграции 003_commands.sql. Если строка уже есть (агент повторяет попытку после
    // сбоя, или это дубль в двух параллельных опросах), возвращаем текущий статус вместо
    // ошибки — агент сам решает, выполнять ли команду ещё раз.
    public static function claim($commandId)
    {
        $pc = Auth::authenticatePc();
        if (!$pc) {
            http_response_code(401);
            echo json_encode(array('error' => 'invalid_token'));
            return;
        }

        $commandId = (int) $commandId;

        try {
            $stmt = Db::get()->prepare('
                INSERT INTO command_results (command_id, pc_id, status, claimed_at)
                VALUES (:command_id, :pc_id, \'in_progress\', CURRENT_TIMESTAMP)
            ');
            $stmt->execute(array('command_id' => $commandId, 'pc_id' => $pc['id']));

            Logger::info('Команда застолблена: command_id=' . $commandId . ' pc_id=' . $pc['id']);
            echo json_encode(array('status' => 'claimed'));
        } catch (PDOException $e) {
            // 23000 = нарушение UNIQUE(command_id, pc_id) — уже застолблена раньше.
            if ($e->getCode() !== '23000') {
                throw $e;
            }

            $existing = Db::get()->prepare('SELECT status FROM command_results WHERE command_id = :command_id AND pc_id = :pc_id');
            $existing->execute(array('command_id' => $commandId, 'pc_id' => $pc['id']));
            $row = $existing->fetch();

            Logger::warning('Команда уже была застолблена ранее: command_id=' . $commandId . ' pc_id=' . $pc['id'] . ' статус=' . ($row ? $row['status'] : '?'));
            echo json_encode(array('status' => 'already_claimed', 'existing_status' => $row ? $row['status'] : null));
        }
    }

    // POST /commands/{id}/result   body: { status: success|failed|timeout, output }
    // Разрешён только переход in_progress -> финальный статус — без предварительного
    // claim результат принять нельзя (это не то же самое, что "забыли застолбить", это
    // защита от отправки результата без выполнения через сам протокол).
    public static function result($commandId)
    {
        $pc = Auth::authenticatePc();
        if (!$pc) {
            http_response_code(401);
            echo json_encode(array('error' => 'invalid_token'));
            return;
        }

        $commandId = (int) $commandId;
        $body = json_decode(file_get_contents('php://input'), true);
        $status = isset($body['status']) ? $body['status'] : '';
        $output = isset($body['output']) ? (string) $body['output'] : null;

        if (!in_array($status, array('success', 'failed', 'timeout'), true)) {
            http_response_code(400);
            echo json_encode(array('error' => 'invalid_status'));
            return;
        }

        // Вывод скрипта или список процессов может быть большим; хранить мегабайты на
        // каждую из 3000 касс в SQLite незачем — обрезаем с пометкой, начало важнее.
        if ($output !== null && strlen($output) > self::MAX_OUTPUT_BYTES) {
            $output = substr($output, 0, self::MAX_OUTPUT_BYTES) . "\n… [вывод обрезан сервером]";
        }

        $stmt = Db::get()->prepare("
            UPDATE command_results
            SET status = :status, output = :output, executed_at = CURRENT_TIMESTAMP
            WHERE command_id = :command_id AND pc_id = :pc_id AND status = 'in_progress'
        ");
        $stmt->execute(array(
            'status'     => $status,
            'output'     => $output,
            'command_id' => $commandId,
            'pc_id'      => $pc['id'],
        ));

        if ($stmt->rowCount() === 0) {
            Logger::warning('POST /commands/' . $commandId . '/result: нет незавершённого claim для pc_id=' . $pc['id']);
            http_response_code(409);
            echo json_encode(array('error' => 'not_claimed_or_already_finished'));
            return;
        }

        Logger::info('Результат команды: command_id=' . $commandId . ' pc_id=' . $pc['id'] . ' status=' . $status);
        echo json_encode(array('status' => 'ok'));
    }
}
