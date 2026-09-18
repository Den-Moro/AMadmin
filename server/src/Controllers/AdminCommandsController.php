<?php

class AdminCommandsController
{
    // Защита от массовой ошибки (см. AGENTS.md, "Управление службами"): эти службы нельзя
    // остановить/перезапустить через это средство, даже случайно. Список провизорный —
    // это тот самый "список согласовать на этапе реализации", который в ТЗ явно оставлен
    // на усмотрение реализации; пересмотрите его под свою инфраструктуру перед реальным
    // использованием на кассах. RpcSs/DcomLaunch/EventLog/Winmgmt — базовые системные
    // службы Windows, без которых ОС становится нестабильна.
    private static $protectedServices = array('rpcss', 'dcomlaunch', 'eventlog', 'winmgmt');

    // GET /admin/commands — последние команды со сводкой по статусам среди уже
    // поступивших command_results (агенты узнают о команде только на следующем опросе,
    // поэтому сразу после создания результатов обычно ещё нет — это нормально).
    public static function index()
    {
        AdminAuth::requireLogin();

        $sql = "
            SELECT
                c.id, c.type, c.payload, c.target_type, c.target_id, c.created_at,
                (SELECT COUNT(*) FROM command_results r WHERE r.command_id = c.id AND r.status = 'in_progress') AS in_progress_count,
                (SELECT COUNT(*) FROM command_results r WHERE r.command_id = c.id AND r.status = 'success') AS success_count,
                (SELECT COUNT(*) FROM command_results r WHERE r.command_id = c.id AND r.status IN ('failed', 'timeout')) AS failed_count
            FROM commands c
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

    // POST /admin/commands   body: { type: 'service_control', payload: {...}, target: {type, id} }
    // Пока принимает только type='service_control' — диспетчер задач/файлы/скрипты
    // добавляются по очереди отдельными шагами (см. AGENTS.md, "Порядок работы", п.7).
    public static function store()
    {
        AdminAuth::requireLogin();

        $body = json_decode(file_get_contents('php://input'), true);
        $type = isset($body['type']) ? $body['type'] : '';

        if ($type !== 'service_control') {
            http_response_code(400);
            echo json_encode(array('error' => 'unsupported_type'));
            return;
        }

        $payload = isset($body['payload']) && is_array($body['payload']) ? $body['payload'] : array();
        $serviceName = isset($payload['service_name']) ? trim($payload['service_name']) : '';
        $action = isset($payload['action']) ? $payload['action'] : '';

        if ($serviceName === '') {
            http_response_code(400);
            echo json_encode(array('error' => 'service_name_required'));
            return;
        }

        if (!in_array($action, array('start', 'stop', 'restart'), true)) {
            http_response_code(400);
            echo json_encode(array('error' => 'invalid_action'));
            return;
        }

        if ($action !== 'start' && in_array(strtolower($serviceName), self::$protectedServices, true)) {
            Logger::warning("Попытка {$action} защищённой службы '{$serviceName}' автором='{$_SESSION['admin_username']}' — отклонено");
            http_response_code(400);
            echo json_encode(array('error' => 'protected_service'));
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

        $payloadJson = json_encode(array('service_name' => $serviceName, 'action' => $action));

        $stmt = Db::get()->prepare('
            INSERT INTO commands (type, payload, target_type, target_id, created_by)
            VALUES (:type, :payload, :target_type, :target_id, :created_by)
        ');
        $stmt->execute(array(
            'type'        => $type,
            'payload'     => $payloadJson,
            'target_type' => $targetType,
            'target_id'   => $targetType === 'all' ? null : $targetId,
            'created_by'  => $_SESSION['admin_id'],
        ));

        $id = Db::get()->lastInsertId();

        // Каждая команда логируется без возможности отключить (см. AGENTS.md,
        // "Безопасность и аудит") — сама строка в commands уже это гарантирует, лог
        // дополнительно дублирует для быстрого разбора без похода в БД.
        Logger::info(
            "Команда создана: id={$id} тип=service_control служба='{$serviceName}' действие={$action} " .
            "таргет={$targetType}" . ($targetId ? ":{$targetId}" : '') . " автор='{$_SESSION['admin_username']}'"
        );

        echo json_encode(array('status' => 'ok', 'id' => $id));
    }
}
