<?php

class CommandsController
{
    // «Команда c адресована ПК p» — одно условие на всех: по нему агент получает команды
    // (commandsForPc) и по нему же панель показывает, кого команда ещё ждёт
    // (AdminCommandsController), поэтому они не могут разойтись. Группа — по текущему
    // составу, как и при выдаче агенту.
    const TARGETS_PC = "(
            c.target_type = 'all'
         OR (c.target_type = 'store' AND c.target_id = p.store_id)
         OR (c.target_type = 'pc' AND c.target_id = p.id)
         OR (c.target_type = 'device_type' AND c.target_id = p.device_type_id)
         OR (c.target_type = 'group' AND p.id IN (SELECT pc_id FROM host_group_members WHERE group_id = c.target_id))
    )";

    // Потолок на вывод одной команды с одного ПК (байт) — см. result().
    const MAX_OUTPUT_BYTES = 65536;

    // GET /commands
    // Команды для этого ПК (по Bearer-токену — тот же agent_token, что и у UI-агента,
    // токен привязан к ПК, а не к конкретному процессу на нём), на которые от этого ПК
    // ещё нет ни одной строки в command_results — т.е. ещё не "застолблены" (claim) и не
    // выполнены. "pending" в терминах AGENTS.md — это именно отсутствие строки, не статус.
    // ?after_restart=1 — первый опрос после запуска агента: плюс прерванные (in_progress),
    // агент закроет их как failed «повторно не запускалось».
    public static function index()
    {
        $pc = Auth::authenticatePc();
        if (!$pc) {
            Logger::warning('GET /commands: неверный или отсутствующий agent_token');
            http_response_code(401);
            echo json_encode(array('error' => 'invalid_token'));
            return;
        }

        // Heartbeat и отсюда тоже: если в сессии никто не залогинен, UI-агента нет, и без
        // этого касса на дашборде выглядела бы офлайн, хотя служба управления на связи.
        Auth::heartbeat($pc, false);

        $afterRestart = !empty($_GET['after_restart']);
        $rows = self::withVariables($pc, self::commandsForPc($pc, true, null, null, $afterRestart));

        // Настройки раскатки файлов подмешиваем в момент отдачи, а не при создании
        // команды — тот же приём, что и с настройками окна в /occurrences: админ меняет
        // их в панели, и следующий же опрос кассы работает по-новому.
        $deploySettings = null;
        foreach ($rows as &$row) {
            if ($row['type'] !== 'file_deploy') {
                continue;
            }
            if ($deploySettings === null) {
                $deploySettings = array(
                    'async'        => Settings::bool('file_deploy_async', true),
                    'max_parallel' => max(1, Settings::int('file_deploy_max_parallel', 2)),
                    'limit_kbps'   => max(0, Settings::int('file_deploy_limit_kbps', 0)),
                );
            }
            $payload = json_decode($row['payload'], true);
            if (is_array($payload)) {
                $row['payload'] = json_encode($payload + $deploySettings, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES);
            }
        }
        unset($row);

        Logger::debug('GET /commands: pc_id=' . $pc['id'] . ' отдано=' . count($rows) . ($afterRestart ? ' (первый опрос после запуска агента)' : ''));

        echo json_encode($rows);
    }

    // Переменные хоста (бета): в командах superadmin с пометкой use_vars подставляет
    // {{ИМЯ}} значениями этой кассы. Нет переменной у кассы (или путь файла после
    // подстановки неправильный) — команду ей не отдаём, а сразу закрываем ошибкой с
    // понятной причиной: запускать скрипт с неподставленным {{ИМЯ}} опаснее, чем не
    // запускать. Старому агенту делать ничего не нужно — он получает готовый текст.
    private static function withVariables($pc, array $rows)
    {
        $vars = null;
        $out = array();
        foreach ($rows as $row) {
            $payload = json_decode($row['payload'], true);
            if (!is_array($payload) || empty($payload['use_vars'])) {
                $out[] = $row;
                continue;
            }
            if ($vars === null) {
                $vars = HostVariables::effective($pc['id'], $pc['store_id']);
            }
            $missing = array();
            foreach (array('script', 'path', 'args', 'target_path', 'value') as $field) {
                if (isset($payload[$field]) && is_string($payload[$field])) {
                    $payload[$field] = HostVariables::render($payload[$field], $vars, $missing);
                }
            }
            unset($payload['use_vars']);

            $problem = null;
            if ($missing) {
                $problem = 'Не задана переменная хоста для этой кассы: ' . implode(', ', array_keys($missing)) .
                    '. Задайте её на странице «Переменные» (для всех касс, магазина, группы или этой кассы) и отправьте команду снова.';
            } elseif ($row['type'] === 'file_deploy' && ($code = AdminCommandsController::pathProblem($payload['target_path']))) {
                $problem = 'После подстановки переменных путь файла неправильный (' . $payload['target_path'] . '): ' . $code . '.';
            }

            if ($problem !== null) {
                // INSERT OR IGNORE: если строка уже есть (касса успела застолбить), не трогаем.
                Db::get()->prepare("
                    INSERT OR IGNORE INTO command_results (command_id, pc_id, status, output, claimed_at, executed_at)
                    VALUES (:command_id, :pc_id, 'failed', :output, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
                ")->execute(array('command_id' => $row['id'], 'pc_id' => $pc['id'], 'output' => $problem));
                Logger::warning('Команда id=' . $row['id'] . ' не выдана pc_id=' . $pc['id'] . ': ' . $problem);
                continue;
            }

            $row['payload'] = json_encode($payload, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES);
            $out[] = $row;
        }
        return $out;
    }

    // Команды, адресованные этому ПК и не старше command_ttl_hours (см. миграцию 009).
    //   $onlyPending — только те, на которые от этого ПК ещё нет строки в command_results
    //                  (то, что отдаём агенту на выполнение); false — все адресованные.
    //   $commandId   — ограничить одной командой (проверка "а этому ли ПК она адресована").
    //   $type        — ограничить типом (например, только file_deploy для скачивания файла).
    //   $includeInterrupted — вместе с $onlyPending: добавить застолблённые этим ПК, но так
    //                  и не завершённые (in_progress). Агент просит их один раз после своего
    //                  запуска: новый процесс их точно не выполняет, значит, прерваны.
    // Срок жизни (command_ttl_hours) к уже застолблённым этим ПК не применяется: он
    // защищает от выполнения старых команд, а отчитаться о прерванной нужно и через неделю.
    //
    // Таргетинг похож на TargetMatcher, но commands хранит target_type/target_id
    // прямо на своей строке (не через отдельную join-таблицу, как
    // notification_targets), поэтому условие своё — TARGETS_PC.
    public static function commandsForPc($pc, $onlyPending, $commandId = null, $type = null, $includeInterrupted = false)
    {
        $ttlHours = (int) Settings::int('command_ttl_hours', 24);

        $pending = $includeInterrupted ? "(r.id IS NULL OR r.status = 'in_progress')" : 'r.id IS NULL';
        $sql = "
            SELECT c.id, c.type, c.payload, c.created_at
            FROM commands c
            JOIN pcs p ON p.id = :pc_id
            LEFT JOIN command_results r ON r.command_id = c.id AND r.pc_id = p.id
            WHERE " . ($onlyPending ? $pending : '1 = 1') . "
              AND (c.created_at >= datetime('now', :ttl) OR r.status = 'in_progress')
              AND " . self::TARGETS_PC . "
        ";
        $params = array(
            'pc_id' => $pc['id'],
            'ttl'   => '-' . max(1, $ttlHours) . ' hours',
        );

        if ($commandId !== null) {
            $sql .= ' AND c.id = :command_id';
            $params['command_id'] = (int) $commandId;
        }
        if ($type !== null) {
            $sql .= ' AND c.type = :type';
            $params['type'] = $type;
        }

        $sql .= ' ORDER BY c.created_at ASC';

        $stmt = Db::get()->prepare($sql);
        $stmt->execute($params);

        return $stmt->fetchAll();
    }

    // Адресована ли команда этому ПК (и не протухла ли). Claim без этой проверки
    // позволял бы кассе с любым валидным токеном "отчитаться" за чужую команду и
    // замусорить аудит.
    private static function isTargeted($pc, $commandId)
    {
        return count(self::commandsForPc($pc, false, $commandId)) > 0;
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

        if (!self::isTargeted($pc, $commandId)) {
            Logger::warning('POST /commands/' . $commandId . '/claim: команда не адресована pc_id=' . $pc['id'] . ' (или устарела) — отказано');
            http_response_code(403);
            echo json_encode(array('error' => 'command_not_targeted_to_this_pc'));
            return;
        }

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
        $maxBytes = max(1, Settings::int('command_output_max_kb', self::MAX_OUTPUT_BYTES / 1024)) * 1024;
        if ($output !== null && strlen($output) > $maxBytes) {
            $output = substr($output, 0, $maxBytes) . "\n… [вывод обрезан сервером]";
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
