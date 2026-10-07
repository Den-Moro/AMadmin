<?php

class AdminCommandsController
{
    // GET /admin/commands — последние команды со сводкой: сколько касс адресовано,
    // сколько отчитались и сколько ещё не забрали (из них — на связи прямо сейчас, то есть
    // заберут на ближайшем опросе). expired — срок жизни команды истёк: кто не забрал, уже
    // не получит.
    public static function index()
    {
        AdminAuth::requireLogin();

        $notClaimed = 'NOT EXISTS (SELECT 1 FROM command_results r WHERE r.command_id = c.id AND r.pc_id = p.id)';
        // Окно «онлайн» — целым числом прямо в SQL, не параметром: PDO передаёт параметры
        // строкой, а в SQLite число всегда «меньше» строки — сравнение было бы всегда истинным.
        $window = self::onlineWindow();
        $sql = "
            SELECT
                c.id, c.type, c.payload, c.target_type, c.target_id, c.created_at, c.update_batch_id, c.release_id,
                (SELECT version FROM agent_releases WHERE id = c.release_id) AS release_version,
                u.username AS created_by_username,
                -- Имя цели, чтобы в списке было «Магазин Центральный», а не «Магазин #3».
                CASE c.target_type
                    WHEN 'store' THEN (SELECT name FROM stores WHERE id = c.target_id)
                    WHEN 'group' THEN (SELECT name FROM host_groups WHERE id = c.target_id)
                    WHEN 'device_type' THEN (SELECT name FROM device_types WHERE id = c.target_id)
                    WHEN 'pc' THEN (SELECT COALESCE(NULLIF(display_name, ''), hostname) FROM pcs WHERE id = c.target_id)
                END AS target_name,
                (SELECT COUNT(*) FROM command_results r WHERE r.command_id = c.id AND r.status = 'in_progress') AS in_progress_count,
                (SELECT COUNT(*) FROM command_results r WHERE r.command_id = c.id AND r.status = 'success') AS success_count,
                (SELECT COUNT(*) FROM command_results r WHERE r.command_id = c.id AND r.status IN ('failed', 'timeout')) AS failed_count,
                (SELECT COUNT(*) FROM pcs p WHERE " . CommandsController::TARGETS_PC . ") AS target_count,
                (SELECT COUNT(*) FROM pcs p WHERE " . CommandsController::TARGETS_PC . " AND {$notClaimed}) AS pending_count,
                (SELECT COUNT(*) FROM pcs p WHERE " . CommandsController::TARGETS_PC . " AND {$notClaimed}
                    AND p.last_seen IS NOT NULL AND (julianday('now') - julianday(p.last_seen)) * 86400.0 <= {$window}) AS pending_online_count,
                (c.created_at < datetime('now', :ttl)) AS expired
            FROM commands c
            LEFT JOIN admin_users u ON u.id = c.created_by
            ORDER BY c.created_at DESC
            LIMIT 100
        ";
        $stmt = Db::get()->prepare($sql);
        $stmt->execute(array('ttl' => self::ttlModifier()));
        echo json_encode($stmt->fetchAll());
    }

    // GET /admin/commands/{id}/results — все кассы, которым адресована команда: и
    // отчитавшиеся, и ещё не забравшие её (status = 'pending', с пометкой «на связи»).
    // Кого команда затронет, считает то же условие, по которому её получают агенты
    // (CommandsController::TARGETS_PC). Касса, переведённая в другой магазин уже после
    // своего отчёта, остаётся в списке — по строке результата.
    public static function results($commandId)
    {
        AdminAuth::requireLogin();

        $window = self::onlineWindow();
        $stmt = Db::get()->prepare("
            SELECT r.status, r.output, r.claimed_at, r.executed_at,
                   p.id AS pc_id, p.hostname, p.display_name, p.last_seen, s.name AS store_name,
                   (p.last_seen IS NOT NULL AND (julianday('now') - julianday(p.last_seen)) * 86400.0 <= {$window}) AS online
            FROM commands c
            JOIN pcs p
            JOIN stores s ON s.id = p.store_id
            LEFT JOIN command_results r ON r.command_id = c.id AND r.pc_id = p.id
            WHERE c.id = :command_id
              AND (r.id IS NOT NULL OR " . CommandsController::TARGETS_PC . ")
            ORDER BY (r.id IS NULL) DESC, r.claimed_at DESC, s.name, p.hostname
        ");
        $stmt->execute(array('command_id' => (int) $commandId));

        $rows = $stmt->fetchAll();
        foreach ($rows as &$row) {
            if ($row['status'] === null) {
                $row['status'] = 'pending';
            }
            $row['online'] = (bool) $row['online'];
        }
        unset($row);

        echo json_encode($rows);
    }

    private static function onlineWindow()
    {
        return (int) Settings::int('online_window_seconds', AdminPcsController::ONLINE_WINDOW_SECONDS);
    }

    private static function ttlModifier()
    {
        return '-' . max(1, Settings::int('command_ttl_hours', 24)) . ' hours';
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
            'env_var'         => 'validateEnvVar',
        );

        if (!isset($validators[$type])) {
            http_response_code(400);
            echo json_encode(array('error' => 'unsupported_type'));
            return;
        }

        // Переменные среды Windows (бета) — только главному администратору.
        if ($type === 'env_var') {
            AdminAuth::requireSuperadmin();
        }

        // Валидатор возвращает либо array('payload' => ..., 'summary' => 'для лога'),
        // либо array('error' => 'код') — тогда отвечаем 400 и ничего не создаём.
        $method = $validators[$type];
        $checked = $type === 'file_deploy' ? self::validateFileDeploy($payload, AdminAuth::isSuperadmin()) : self::$method($payload);
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

        if (!SmartGroups::targetAllowed($targetType, $targetId)) {
            http_response_code(403);
            echo json_encode(array('error' => 'smart_group_requires_superadmin'));
            return;
        }

        $checked['payload'] = self::markVariables($checked['payload']);

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
        if (!SmartGroups::targetAllowed($targetType, $targetId)) {
            http_response_code(403);
            echo json_encode(array('error' => 'smart_group_requires_superadmin'));
            return;
        }

        $payloads = array();
        foreach ($items as $i => $item) {
            $itemType = isset($item['type']) ? $item['type'] : 'file_deploy';
            if ($itemType !== 'file_deploy') {
                http_response_code(400);
                echo json_encode(array('error' => 'unsupported_type', 'index' => $i));
                return;
            }
            $payloads[] = isset($item['payload']) && is_array($item['payload']) ? $item['payload'] : array();
        }

        $result = self::createFileBatch($payloads, $targetType, $targetId, null);
        if (isset($result['error'])) {
            http_response_code(400);
        }
        echo json_encode($result);
    }

    // Пачка file_deploy-команд с общим update_batch_id (и, для версии агента, release_id).
    // Все элементы проверяются ДО первой вставки — одна плохая строка не должна создавать
    // половину пачки. Возвращает array('status' => 'ok', 'update_batch_id', 'ids') или
    // array('error' => код, 'index' => номер элемента). Цель проверяет вызывающий.
    public static function createFileBatch(array $payloads, $targetType, $targetId, $releaseId)
    {
        $checkedItems = array();
        // Переменные в пути ({{ИМЯ}}) — только у superadmin и не для версий агента.
        $allowVars = AdminAuth::isSuperadmin() && !$releaseId;
        foreach ($payloads as $i => $payload) {
            $checked = self::validateFileDeploy($payload, $allowVars);
            if (isset($checked['error'])) {
                return array('error' => $checked['error'], 'index' => $i);
            }
            $checked['payload'] = self::markVariables($checked['payload']);
            $checkedItems[] = $checked;
        }

        $batchId = bin2hex(random_bytes(8));
        $db = Db::get();
        $stmt = $db->prepare('
            INSERT INTO commands (type, payload, target_type, target_id, created_by, update_batch_id, release_id)
            VALUES (:type, :payload, :target_type, :target_id, :created_by, :batch_id, :release_id)
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
                    'release_id'  => $releaseId,
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
            ($releaseId ? " версия_агента_id={$releaseId}" : '') .
            " таргет={$targetType}" . ($targetId ? ":{$targetId}" : '') . " автор='{$_SESSION['admin_username']}'"
        );

        return array('status' => 'ok', 'update_batch_id' => $batchId, 'ids' => $ids);
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

    // $allowVars — путь может содержать {{ИМЯ}} (переменные хоста, только superadmin):
    // тогда здесь проверяется путь с подставленными «заглушками», а настоящий — после
    // подстановки, при выдаче команде конкретной кассе (CommandsController).
    private static function validateFileDeploy($p, $allowVars = false)
    {
        $fileId = (!empty($p['file_id'])) ? (int) $p['file_id'] : 0;
        $targetPath = isset($p['target_path']) ? trim($p['target_path']) : '';

        if (!$fileId) {
            return array('error' => 'file_id_required');
        }

        $probe = $targetPath;
        if ($allowVars && HostVariables::hasPlaceholders($targetPath)) {
            // Путь, начинающийся с переменной ({{ProfiT}}\config.ini), — считаем, что в ней
            // полный путь к папке.
            $probe = preg_replace('/^' . substr(HostVariables::PLACEHOLDER, 1, -1) . '/', 'C:\\\\V', $targetPath);
            $probe = preg_replace(HostVariables::PLACEHOLDER, 'V', $probe);
        }

        $problem = self::pathProblem($probe);
        if ($problem) {
            return array('error' => $problem);
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

    // Путь файла на кассе: полный путь Windows вместе с именем файла. null — всё в порядке,
    // иначе код ошибки. Нужен и здесь, и при выдаче команды после подстановки переменных.
    public static function pathProblem($targetPath)
    {
        // C:\... или \\server\share\...
        if ($targetPath === '' || !preg_match('#^([A-Za-z]:\\\\|\\\\\\\\)#', $targetPath)) {
            return 'target_path_must_be_absolute_windows_path';
        }
        // Путь заканчивается на «\» — это папка без имени файла: агент попытался бы
        // записать файл с пустым именем. Раньше так легко было ошибиться, вписав папку.
        if (substr($targetPath, -1) === '\\') {
            return 'target_path_is_folder';
        }
        // Символы, недопустимые в путях Windows (двоеточие — только после буквы диска).
        if (preg_match('#[<>"|?*]#', $targetPath) || strpos(substr($targetPath, 2), ':') !== false) {
            return 'target_path_invalid_chars';
        }
        return null;
    }

    // Переменные среды Windows на кассе (бета, только superadmin). Системные (уровень
    // компьютера, HKLM) — служба работает от SYSTEM, переменных конкретного пользователя
    // она не касается.
    //   list        — все системные переменные;
    //   get         — одна;
    //   set         — задать (создать или заменить);
    //   delete      — удалить;
    //   path_add    — добавить папку в PATH (если её там ещё нет);
    //   path_remove — убрать папку из PATH.
    // Ключевые системные переменные (PATH, ComSpec, SystemRoot…) можно только смотреть;
    // PATH — менять по одной папке, целиком перезаписать нельзя. Тот же список проверяет
    // и сам агент.
    const PROTECTED_ENV = array('path', 'pathext', 'comspec', 'systemroot', 'windir', 'temp', 'tmp', 'os',
        'psmodulepath', 'number_of_processors', 'processor_architecture', 'processor_identifier',
        'processor_level', 'processor_revision', 'driverdata', 'username', 'systemdrive', 'programdata',
        'programfiles', 'programfiles(x86)', 'programw6432', 'commonprogramfiles', 'commonprogramfiles(x86)',
        'commonprogramw6432', 'allusersprofile', 'public', 'computername');

    private static function validateEnvVar($p)
    {
        $action = isset($p['action']) ? (string) $p['action'] : '';
        if (!in_array($action, array('list', 'get', 'set', 'delete', 'path_add', 'path_remove'), true)) {
            return array('error' => 'invalid_action');
        }
        if ($action === 'list') {
            return array('payload' => array('action' => 'list'), 'summary' => 'переменные среды: список');
        }

        $name = $action === 'path_add' || $action === 'path_remove' ? 'Path' : (isset($p['name']) ? trim((string) $p['name']) : '');
        $value = isset($p['value']) ? trim((string) $p['value']) : '';
        if (!preg_match('/^[A-Za-z_][A-Za-z0-9_().\-]{0,127}$/', $name)) {
            return array('error' => 'invalid_env_name');
        }

        $protected = in_array(strtolower($name), self::PROTECTED_ENV, true);
        if (($action === 'set' || $action === 'delete') && $protected) {
            return array('error' => 'protected_env_var', 'warn' => "Попытка {$action} системной переменной среды '{$name}'");
        }
        if ($action === 'set') {
            if ($value === '') {
                return array('error' => 'env_value_required');
            }
            if (mb_strlen($value) > 2047 || strpos($value, "\n") !== false) {
                return array('error' => 'env_value_invalid');
            }
        }
        if ($action === 'path_add' || $action === 'path_remove') {
            // Одна папка: полный путь или путь от переменной (%ProgramFiles%\...), без «;».
            if ($value === '' || strpos($value, ';') !== false || !preg_match('#^([A-Za-z]:\\\\|%[A-Za-z_()]+%|\{\{)#', $value)) {
                return array('error' => 'env_path_folder_invalid');
            }
        }

        $payload = array('action' => $action, 'name' => $name);
        if ($action === 'set' || $action === 'path_add' || $action === 'path_remove') {
            $payload['value'] = $value;
        }
        $labels = array('get' => 'показать', 'set' => 'задать', 'delete' => 'удалить', 'path_add' => 'добавить в PATH', 'path_remove' => 'убрать из PATH');
        return array(
            'payload' => $payload,
            'summary' => "переменная среды '{$name}': {$labels[$action]}" . (isset($payload['value']) ? " '" . mb_substr($value, 0, 80) . "'" : ''),
        );
    }

    // Команда superadmin с {{ИМЯ}} в тексте скрипта, пути или значении — пометить, чтобы
    // сервер подставил переменные хоста при выдаче. У остальных ролей текст уходит как
    // есть: переменные (в том числе секретные) им недоступны.
    private static function markVariables(array $payload)
    {
        if (!AdminAuth::isSuperadmin()) {
            return $payload;
        }
        foreach (array('script', 'path', 'args', 'target_path', 'value') as $field) {
            if (isset($payload[$field]) && HostVariables::hasPlaceholders($payload[$field])) {
                $payload['use_vars'] = true;
                break;
            }
        }
        return $payload;
    }

    // GET /admin/commands/{id}/results.csv — результаты по каждой кассе одним файлом
    // (открывается в Excel): удобно собрать вывод скрипта с сотни касс в одну таблицу.
    public static function resultsCsv($commandId)
    {
        AdminAuth::requireLogin();
        $stmt = Db::get()->prepare('SELECT id, type, created_at FROM commands WHERE id = :id');
        $stmt->execute(array('id' => (int) $commandId));
        $command = $stmt->fetch();
        if (!$command) {
            http_response_code(404);
            echo json_encode(array('error' => 'not_found'));
            return;
        }

        $rows = Db::get()->prepare("
            SELECT s.name AS store_name, p.hostname, p.display_name, r.status, r.claimed_at, r.executed_at, r.output
            FROM commands c
            JOIN pcs p
            JOIN stores s ON s.id = p.store_id
            LEFT JOIN command_results r ON r.command_id = c.id AND r.pc_id = p.id
            WHERE c.id = :command_id AND (r.id IS NOT NULL OR " . CommandsController::TARGETS_PC . ")
            ORDER BY s.name, p.hostname
        ");
        $rows->execute(array('command_id' => (int) $commandId));

        $labels = array('success' => 'ок', 'failed' => 'ошибка', 'timeout' => 'таймаут', 'in_progress' => 'в работе');
        $out = array(array('Магазин', 'Касса', 'Hostname', 'Статус', 'Забрала (UTC)', 'Выполнила (UTC)', 'Вывод'));
        foreach ($rows as $r) {
            $out[] = array($r['store_name'], $r['display_name'] ?: $r['hostname'], $r['hostname'],
                $r['status'] ? $labels[$r['status']] : 'ждёт', $r['claimed_at'], $r['executed_at'], $r['output']);
        }
        Csv::send('amadmin-command-' . (int) $commandId . '.csv', $out);
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
