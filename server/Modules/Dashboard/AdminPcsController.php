<?php

class AdminPcsController
{
    // ПК считается "онлайн", если опрашивал сервер недавно. Окно шире, чем максимальный
    // интервал опроса клиента (30-60 сек, см. AGENTS.md), чтобы обычная сетевая задержка
    // между опросами не превращалась в ложное мигание онлайн/офлайн на дашборде.
    const ONLINE_WINDOW_SECONDS = 180;

    // GET /admin/pcs?search=&store_id=&device_type_id=
    public static function index()
    {
        AdminAuth::requireLogin();

        $storeId = isset($_GET['store_id']) && $_GET['store_id'] !== '' ? (int) $_GET['store_id'] : null;
        $deviceTypeId = isset($_GET['device_type_id']) && $_GET['device_type_id'] !== '' ? (int) $_GET['device_type_id'] : null;
        $search = isset($_GET['search']) ? trim($_GET['search']) : '';

        $sql = "
            SELECT
                p.id, p.hostname, p.username, p.display_name, p.last_seen, p.agent_version,
                p.agent_token, p.store_id, p.device_type_id,
                s.name AS store_name,
                dt.name AS device_type_name,
                (julianday('now') - julianday(p.last_seen)) * 86400.0 AS seconds_since_seen
            FROM pcs p
            JOIN stores s ON s.id = p.store_id
            JOIN device_types dt ON dt.id = p.device_type_id
            WHERE 1 = 1
        ";
        $params = array();

        if ($storeId) {
            $sql .= ' AND p.store_id = :store_id';
            $params['store_id'] = $storeId;
        }
        if ($deviceTypeId) {
            $sql .= ' AND p.device_type_id = :device_type_id';
            $params['device_type_id'] = $deviceTypeId;
        }
        if ($search !== '') {
            $sql .= ' AND (p.hostname LIKE :search OR p.username LIKE :search OR p.display_name LIKE :search OR s.name LIKE :search)';
            $params['search'] = '%' . $search . '%';
        }

        $sql .= ' ORDER BY p.last_seen DESC';

        $stmt = Db::get()->prepare($sql);
        $stmt->execute($params);
        $rows = $stmt->fetchAll();

        foreach ($rows as &$row) {
            $row['online'] = $row['last_seen'] !== null && $row['seconds_since_seen'] <= self::ONLINE_WINDOW_SECONDS;
            unset($row['seconds_since_seen']);
        }

        echo json_encode($rows);
    }

    // POST /admin/pcs   body: { store_id, device_type_id, hostname, display_name? }
    // Заводит ПК и сам генерирует agent_token — раньше это делалось только руками через
    // SQL (см. dev-seed.sql), из-за чего "легко получить готовый конфиг для новой кассы"
    // было просто неоткуда взять. Токен возвращаем в ответе один раз — панель сама
    // сразу показывает готовый config.json, копировать вручную из БД не нужно.
    public static function store()
    {
        AdminAuth::requireLogin();

        $body = json_decode(file_get_contents('php://input'), true);
        $storeId = isset($body['store_id']) ? (int) $body['store_id'] : 0;
        $deviceTypeId = isset($body['device_type_id']) ? (int) $body['device_type_id'] : 0;
        $hostname = isset($body['hostname']) ? trim($body['hostname']) : '';
        $displayName = (!empty($body['display_name'])) ? trim($body['display_name']) : null;

        if (!$storeId || !$deviceTypeId || $hostname === '') {
            http_response_code(400);
            echo json_encode(array('error' => 'store_id_device_type_id_hostname_required'));
            return;
        }

        // random_bytes — криптографически стойкий генератор (не mt_rand/uniqid), это
        // секретный токен, который заменяет пароль для агента на этом ПК.
        $token = bin2hex(random_bytes(32));

        $stmt = Db::get()->prepare('
            INSERT INTO pcs (store_id, device_type_id, hostname, display_name, agent_token)
            VALUES (:store_id, :device_type_id, :hostname, :display_name, :token)
        ');
        $stmt->execute(array(
            'store_id'      => $storeId,
            'device_type_id' => $deviceTypeId,
            'hostname'      => $hostname,
            'display_name'  => $displayName,
            'token'         => $token,
        ));

        $id = Db::get()->lastInsertId();
        Logger::info("ПК создан вручную из панели: id={$id} hostname='{$hostname}' автор='{$_SESSION['admin_username']}'");

        echo json_encode(array('status' => 'ok', 'id' => $id, 'agent_token' => $token));
    }
}
