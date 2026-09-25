<?php

class AdminCommandsController
{
    // GET /admin/commands — последние команды со сводкой по статусам среди уже
    // поступивших command_results (агенты узнают о команде только на следующем опросе,
    // поэтому сразу после создания результатов обычно ещё нет — это нормально).
    public static function index()
    {
        AdminAuth::requireLogin();

        $sql = "
            SELECT
                c.id, c.type, c.payload, c.target_type, c.target_id, c.created_at, c.update_batch_id,
                u.username AS created_by_username,
                (SELECT COUNT(*) FROM command_results r WHERE r.command_id = c.id AND r.status = 'in_progress') AS in_progress_count,
                (SELECT COUNT(*) FROM command_results r WHERE r.command_id = c.id AND r.status = 'success') AS success_count,
                (SELECT COUNT(*) FROM command_results r WHERE r.command_id = c.id AND r.status IN ('failed', 'timeout')) AS failed_count
            FROM commands c
            LEFT JOIN admin_users u ON u.id = c.created_by
            ORDER BY c.created_at DESC
            LIMIT 100
        ";
        echo json_encode(Db::get()->query($sql)->fetchAll());
    }

    // GET /admin/commands/{id}/results — по хостам, только те, что уже отозвались
    // (застолбили и/или выполнили). ПК, которые ещё не опрашивали сервер с момента
    // создания команды, здесь не появятся — у нас нет способа заранее перечислить "кого
    // именно затронет" таргет без дублирования логики таргетинга агентов, а раз агент сам
    // вот-вот появится по факту опроса — это осознанное упрощение, не забытая деталь.
    public static function results($commandId)
    {
        AdminAuth::requireLogin();

        $stmt = Db::get()->prepare('
            SELECT r.status, r.output, r.claimed_at, r.executed_at,
                   p.id AS pc_id, p.hostname, p.display_name, s.name AS store_name
            FROM command_results r
            JOIN pcs p ON p.id = r.pc_id
            JOIN stores s ON s.id = p.store_id
            WHERE r.command_id = :command_id
            ORDER BY r.claimed_at DESC
        ');
        $stmt->execute(array('command_id' => (int) $commandId));

        echo json_encode($stmt->fetchAll());
    }

    // POST /admin/commands   body: { type, payload: {...}, target: {type, id} }
    //
    // Четыре стандартных типа (см. AGENTS.md, "Удалённое администрирование"):
    //   service_control — { service_name, action: start|stop|restart|list }
    //   process_action  — { action: kill|list, process_name?, pid? }
    //   script_run      — { engine: powershell|cmd, script? | path?, args?, timeout_seconds }
    //   file_deploy     — { file_id, target_path }  (файл заранее загружен через /admin/files)
    //
    // Сервер только проверяет форму команды и защитные списки; исполняет её агент
    // управления на ПК. Что бы ни пришло в payload сверх описанного — отбрасывается:
    // в БД и агенту уходит только то, что собрано валидатором руками.
    public static function store()
    {
        // Самое рискованное действие в панели — удалённое выполнение команд на кассах —
        // требует роль administrator/superadmin, обычному operator недоступно.
        AdminAuth::requireRole(array('administrator', 'superadmin'));

        $body = json_decode(file_get_contents('php://input'), true);
        $type = isset($body['type']) ? $body['type'] : '';
        $payload = isset($body['payload']) && is_array($body['payload']) ? $body['payload'] : array();

        $validators = array(
            'service_control' => 'validateServiceControl',
            'process_action'  => 'validateProcessAction',
            'script_run'      => 'validateScriptRun',
            'file_deploy'     => 'validateFileDeploy',
        );

        if (!isset($validators[$type])) {
            http_response_code(400);
            echo json_encode(array('error' => 'unsupported_type'));
            return;
        }

        // Валидатор возвращает либо array('payload' => ..., 'summary' => 'для лога'),
        // либо array('error' => 'код') — тогда отвечаем 400 и ничего не создаём.
        $method = $validators[$type];
        $checked = self::$method($payload);
        if (isset($checked['error'])) {
            if (isset($checked['warn'])) {
                Logger::warning($checked['warn'] . " автор='{$_SESSION['admin_username']}' — отклонено");
            }
            http_response_code(400);
            echo json_encode(array('error' => $checked['error']));
            return;
        }

        $target = isset($body['target']) && is_array($body['target']) ? $body['target'] : array();
        $targetType = isset($target['type']) ? $target['type'] : '';
        $targetId = (!empty($target['id'])) ? (int) $target['id'] : null;

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

        // Завершение по PID имеет смысл только на одном конкретном ПК: на разных
        // машинах под одним PID живут разные процессы.
        if ($type === 'process_action' && isset($checked['payload']['pid']) && $targetType !== 'pc') {
            http_response_code(400);
            echo json_encode(array('error' => 'pid_requires_single_pc_target'));
            return;
        }

        $stmt = Db::get()->prepare('
            INSERT INTO commands (type, payload, target_type, target_id, created_by)
            VALUES (:type, :payload, :target_type, :target_id, :created_by)
        ');
        $stmt->execute(array(
            'type'        => $type,
            'payload'     => json_encode($checked['payload'], JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES),
            'target_type' => $targetType,
            'target_id'   => $targetType === 'all' ? null : $targetId,
            'created_by'  => $_SESSION['admin_id'],
        ));

        $id = Db::get()->lastInsertId();

        // Каждая команда логируется без возможности отключить (см. AGENTS.md,
        // "Безопасность и аудит") — сама строка в commands уже это гарантирует, лог
        // дополнительно дублирует для быстрого разбора без похода в БД.
        Logger::info(
            "Команда создана: id={$id} тип={$type} {$checked['summary']} " .
            "таргет={$targetType}" . ($targetId ? ":{$targetId}" : '') . " автор='{$_SESSION['admin_username']}'"
        );

        echo json_encode(array('status' => 'ok', 'id' => $id));
    }

    // POST /admin/commands/batch   body: { target: {type, id}, items: [{payload: {file_id, target_path}}, ...] }
    //
    // Несколько file_deploy-команд одним логическим действием (страница «Обновления» —
    // например, сразу оба файла агента на одни и те же кассы). Каждая команда — всё та
    // же отдельная строка commands, что и всегда (агенту/исполнению это не меняет), но
    // с общим update_batch_id, чтобы в истории команд показывались одной группой, а не
    // неотличимыми друг от друга строками. Валидируем все элементы ДО первой вставки —
    // одна плохая строка не должна создавать половину пачки.
    public static function storeBatch()
    {
        AdminAuth::requireRole(array('administrator', 'superadmin'));

        $body = json_decode(file_get_contents('php://input'), true);
        $items = isset($body['items']) && is_array($body['items']) ? $body['items'] : array();
        if (!$items) {
            http_response_code(400);
            echo json_encode(array('error' => 'items_required'));
            return;
        }

        $target = isset($body['target']) && is_array($body['target']) ? $body['target'] : array();
        $targetType = isset($target['type']) ? $target['type'] : '';
        $targetId = (!empty($target['id'])) ? (int) $target['id'] : null;

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

        $checkedItems = array();
        foreach ($items as $i => $item) {
            $itemType = isset($item['type']) ? $item['type'] : 'file_deploy';
            if ($itemType !== 'file_deploy') {
                http_response_code(400);
                echo json_encode(array('error' => 'unsupported_type', 'index' => $i));
                return;
            }
            $payload = isset($item['payload']) && is_array($item['payload']) ? $item['payload'] : array();
            $checked = self::validateFileDeploy($payload);
            if (isset($checked['error'])) {
                http_response_code(400);
                echo json_encode(array('error' => $checked['error'], 'index' => $i));
                return;
            }
            $checkedItems[] = $checked;
        }

        $batchId = bin2hex(random_bytes(8));
        $db = Db::get();
        $stmt = $db->prepare('
            INSERT INTO commands (type, payload, target_type, target_id, created_by, update_batch_id)
            VALUES (:type, :payload, :target_type, :target_id, :created_by, :batch_id)
        ');

        $ids = array();
        $db->beginTransaction();
        try {
            foreach ($checkedItems as $checked) {
                $stmt->execute(array(
                    'type'        => 'file_deploy',
                    'payload'     => json_encode($checked['payload'], JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES),
                    'target_type' => $targetType,
                    'target_id'   => $targetType === 'all' ? null : $targetId,
                    'created_by'  => $_SESSION['admin_id'],
                    'batch_id'    => $batchId,
                ));
                $ids[] = $db->lastInsertId();
            }
            $db->commit();
        } catch (Exception $e) {
            $db->rollBack();
            throw $e;
        }

        Logger::info(
            'Пакетная команда создана: batch=' . $batchId . ' команд=' . count($ids) .
            " таргет={$targetType}" . ($targetId ? ":{$targetId}" : '') . " автор='{$_SESSION['admin_username']}'"
        );

        echo json_encode(array('status' => 'ok', 'update_batch_id' => $batchId, 'ids' => $ids));
    }

    // ---- Валидаторы по типам ------------------------------------------------------

    private static function validateServiceControl($p)
    {
        $serviceName = isset($p['service_name']) ? trim($p['service_name']) : '';
        $action = isset($p['action']) ? $p['action'] : '';

        if (!in_array($action, array('start', 'stop', 'restart', 'list'), true)) {
            return array('error' => 'invalid_action');
        }

        if ($action === 'list') {
            return array('payload' => array('action' => 'list'), 'summary' => 'список служб');
        }

        if ($serviceName === '') {
            return array('error' => 'service_name_required');
        }

        // Защита от массовой ошибки: эти службы нельзя остановить/перезапустить через
        // панель, даже случайно. Список — настройка protected_services (см. миграцию 008).
        if ($action !== 'start' && self::inProtectedList('protected_services', $serviceName)) {
            return array(
                'error' => 'protected_service',
                'warn'  => "Попытка {$action} защищённой службы '{$serviceName}'",
            );
        }

        return array(
            'payload' => array('service_name' => $serviceName, 'action' => $action),
            'summary' => "служба='{$serviceName}' действие={$action}",
        );
    }

    private static function validateProcessAction($p)
    {
        $action = isset($p['action']) ? $p['action'] : '';
        $processName = isset($p['process_name']) ? trim($p['process_name']) : '';
        $pid = (!empty($p['pid'])) ? (int) $p['pid'] : null;

        if (!in_array($action, array('kill', 'list'), true)) {
            return array('error' => 'invalid_action');
        }

        if ($action === 'list') {
            return array('payload' => array('action' => 'list'), 'summary' => 'список процессов');
        }

        if ($processName === '' && !$pid) {
            return array('error' => 'process_name_or_pid_required');
        }

        // "explorer" и "Explorer.exe" — один и тот же процесс, храним без расширения.
        $processName = preg_replace('/\.exe$/i', '', $processName);

        if ($processName !== '' && self::inProtectedList('protected_processes', $processName)) {
            return array(
                'error' => 'protected_process',
                'warn'  => "Попытка завершить защищённый процесс '{$processName}'",
            );
        }

        $payload = array('action' => 'kill');
        if ($processName !== '') {
            $payload['process_name'] = $processName;
        }
        if ($pid) {
            $payload['pid'] = $pid;
        }

        return array(
            'payload' => $payload,
            'summary' => 'завершить процесс ' . ($processName !== '' ? "'{$processName}'" : '') . ($pid ? " pid={$pid}" : ''),
        );
    }

    private static function validateScriptRun($p)
    {
        $engine = isset($p['engine']) ? $p['engine'] : 'powershell';
        $script = isset($p['script']) ? (string) $p['script'] : '';
        $path = isset($p['path']) ? trim($p['path']) : '';
        $args = isset($p['args']) ? trim((string) $p['args']) : '';
        $timeout = isset($p['timeout_seconds']) && (int) $p['timeout_seconds'] > 0
            ? (int) $p['timeout_seconds']
            : Settings::int('script_timeout_seconds_default', 60);

        if (!in_array($engine, array('powershell', 'cmd'), true)) {
            return array('error' => 'invalid_engine');
        }

        // Либо текст скрипта, либо путь к уже лежащему на ПК файлу/программе — не оба.
        if (trim($script) === '' && $path === '') {
            return array('error' => 'script_or_path_required');
        }
        if (trim($script) !== '' && $path !== '') {
            return array('error' => 'script_and_path_are_exclusive');
        }

        // Верхняя граница — синхронный запуск с таймаутом; дольше 10 минут агент всё
        // равно ждать не будет (см. AGENTS.md: долгие скрипты не поддерживаем).
        $timeout = min($timeout, 600);

        $payload = array(
            'engine'          => $engine,
            'script'          => trim($script) !== '' ? $script : null,
            'path'            => $path !== '' ? $path : null,
            'args'            => $args,
            'timeout_seconds' => $timeout,
        );

        // В лог — только первая строка, а не весь текст: полный скрипт и так лежит в БД.
        $firstLine = strtok(trim($script) !== '' ? trim($script) : $path, "\r\n");
        return array(
            'payload' => $payload,
            'summary' => "{$engine} '" . mb_substr($firstLine, 0, 80) . "' таймаут={$timeout}с",
        );
    }

    private static function validateFileDeploy($p)
    {
        $fileId = (!empty($p['file_id'])) ? (int) $p['file_id'] : 0;
        $targetPath = isset($p['target_path']) ? trim($p['target_path']) : '';

        if (!$fileId) {
            return array('error' => 'file_id_required');
        }

        // Полный путь Windows вместе с именем файла: C:\... или \\server\share\...
        if ($targetPath === '' || !preg_match('#^([A-Za-z]:\\\\|\\\\\\\\)#', $targetPath)) {
            return array('error' => 'target_path_must_be_absolute_windows_path');
        }

        $stmt = Db::get()->prepare('SELECT id, original_name, sha256, size FROM deploy_files WHERE id = :id');
        $stmt->execute(array('id' => $fileId));
        $file = $stmt->fetch();
        if (!$file) {
            return array('error' => 'file_not_found');
        }

        // Хеш и размер кладём прямо в команду: агент по ним решает, качать ли файл
        // вообще, не делая лишнего запроса на сервер.
        return array(
            'payload' => array(
                'file_id'       => (int) $file['id'],
                'original_name' => $file['original_name'],
                'sha256'        => $file['sha256'],
                'size'          => (int) $file['size'],
                'target_path'   => $targetPath,
            ),
            'summary' => "файл='{$file['original_name']}' -> '{$targetPath}'",
        );
    }

    // ---- Помощники ----------------------------------------------------------------


    // Списки в настройках — через запятую, регистр не важен, ".exe" у процессов
    // отбрасываем с обеих сторон, чтобы "explorer" и "Explorer.exe" считались одним.
    private static function inProtectedList($settingKey, $name)
    {
        $needle = strtolower(preg_replace('/\.exe$/i', '', trim($name)));
        foreach (explode(',', (string) Settings::get($settingKey, '')) as $item) {
            $item = strtolower(preg_replace('/\.exe$/i', '', trim($item)));
            if ($item !== '' && $item === $needle) {
                return true;
            }
        }
        return false;
    }
}
