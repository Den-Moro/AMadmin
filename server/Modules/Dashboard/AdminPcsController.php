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
}
