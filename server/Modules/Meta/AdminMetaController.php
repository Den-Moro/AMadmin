<?php

// Справочники: магазины и типы устройств. Чтение — всем ролям (нужно для дропдаунов
// таргетинга), изменение — administrator+. Удалить можно только пустой справочник:
// у ПК жёсткая ссылка на магазин и тип, «повисших» касс быть не должно.
class AdminMetaController
{
    public static function stores()
    {
        AdminAuth::requireLogin();
        echo json_encode(Db::get()->query('
            SELECT s.id, s.name, s.is_pilot, s.brand_name, s.brand_contact, (SELECT COUNT(*) FROM pcs p WHERE p.store_id = s.id) AS pc_count
            FROM stores s ORDER BY s.name
        ')->fetchAll());
    }

    public static function deviceTypes()
    {
        AdminAuth::requireLogin();
        echo json_encode(Db::get()->query('
            SELECT d.id, d.name, (SELECT COUNT(*) FROM pcs p WHERE p.device_type_id = d.id) AS pc_count
            FROM device_types d ORDER BY d.name
        ')->fetchAll());
    }

    // POST /admin/stores   body: { name, is_pilot? }
    public static function storeStore()
    {
        AdminAuth::requireRole(array('administrator', 'superadmin'));
        $body = json_decode(file_get_contents('php://input'), true);
        $name = isset($body['name']) ? trim($body['name']) : '';
        if ($name === '') {
            http_response_code(400);
            echo json_encode(array('error' => 'name_required'));
            return;
        }
        $stmt = Db::get()->prepare('INSERT INTO stores (name, is_pilot, brand_name, brand_contact) VALUES (:name, :pilot, :brand_name, :brand_contact)');
        $stmt->execute(array(
            'name' => $name, 'pilot' => !empty($body['is_pilot']) ? 1 : 0,
            'brand_name' => isset($body['brand_name']) ? trim($body['brand_name']) : null,
            'brand_contact' => isset($body['brand_contact']) ? trim($body['brand_contact']) : null,
        ));
        $id = Db::get()->lastInsertId();
        Logger::info("Магазин создан: id={$id} '{$name}' автор='{$_SESSION['admin_username']}'");
        echo json_encode(array('status' => 'ok', 'id' => $id));
    }

    // PUT /admin/stores/{id}   body: { name?, is_pilot? }
    public static function updateStore($id)
    {
        AdminAuth::requireRole(array('administrator', 'superadmin'));
        $body = json_decode(file_get_contents('php://input'), true);
        $fields = array();
        $params = array('id' => (int) $id);
        if (isset($body['name']) && trim($body['name']) !== '') {
            $fields[] = 'name = :name';
            $params['name'] = trim($body['name']);
        }
        if (array_key_exists('is_pilot', $body)) {
            $fields[] = 'is_pilot = :pilot';
            $params['pilot'] = !empty($body['is_pilot']) ? 1 : 0;
        }
        if (array_key_exists('brand_name', $body)) {
            $fields[] = 'brand_name = :brand_name';
            $params['brand_name'] = trim($body['brand_name']) !== '' ? trim($body['brand_name']) : null;
        }
        if (array_key_exists('brand_contact', $body)) {
            $fields[] = 'brand_contact = :brand_contact';
            $params['brand_contact'] = trim($body['brand_contact']) !== '' ? trim($body['brand_contact']) : null;
        }
        if (!$fields) {
            http_response_code(400);
            echo json_encode(array('error' => 'nothing_to_update'));
            return;
        }
        Db::get()->prepare('UPDATE stores SET ' . implode(', ', $fields) . ' WHERE id = :id')->execute($params);
        Logger::info("Магазин id={$id} изменён автором='{$_SESSION['admin_username']}'");
        echo json_encode(array('status' => 'ok'));
    }

    // DELETE /admin/stores/{id}
    public static function destroyStore($id)
    {
        AdminAuth::requireRole(array('administrator', 'superadmin'));
        self::destroyRef('stores', 'store_id', (int) $id, 'Магазин');
    }

    // POST /admin/device-types   body: { name }
    public static function storeDeviceType()
    {
        AdminAuth::requireRole(array('administrator', 'superadmin'));
        $body = json_decode(file_get_contents('php://input'), true);
        $name = isset($body['name']) ? trim($body['name']) : '';
        if ($name === '') {
            http_response_code(400);
            echo json_encode(array('error' => 'name_required'));
            return;
        }
        Db::get()->prepare('INSERT INTO device_types (name) VALUES (:name)')->execute(array('name' => $name));
        $id = Db::get()->lastInsertId();
        Logger::info("Тип устройства создан: id={$id} '{$name}' автор='{$_SESSION['admin_username']}'");
        echo json_encode(array('status' => 'ok', 'id' => $id));
    }

    // PUT /admin/device-types/{id}   body: { name }
    public static function updateDeviceType($id)
    {
        AdminAuth::requireRole(array('administrator', 'superadmin'));
        $body = json_decode(file_get_contents('php://input'), true);
        $name = isset($body['name']) ? trim($body['name']) : '';
        if ($name === '') {
            http_response_code(400);
            echo json_encode(array('error' => 'name_required'));
            return;
        }
        Db::get()->prepare('UPDATE device_types SET name = :name WHERE id = :id')->execute(array('name' => $name, 'id' => (int) $id));
        echo json_encode(array('status' => 'ok'));
    }

    // DELETE /admin/device-types/{id}
    public static function destroyDeviceType($id)
    {
        AdminAuth::requireRole(array('administrator', 'superadmin'));
        self::destroyRef('device_types', 'device_type_id', (int) $id, 'Тип устройства');
    }

    private static function destroyRef($table, $pcColumn, $id, $label)
    {
        $count = Db::get()->prepare("SELECT COUNT(*) FROM pcs WHERE {$pcColumn} = :id");
        $count->execute(array('id' => $id));
        if ((int) $count->fetchColumn() > 0) {
            http_response_code(409);
            echo json_encode(array('error' => 'has_pcs'));
            return;
        }
        $stmt = Db::get()->prepare("DELETE FROM {$table} WHERE id = :id");
        $stmt->execute(array('id' => $id));
        if ($stmt->rowCount() === 0) {
            http_response_code(404);
            echo json_encode(array('error' => 'not_found'));
            return;
        }
        Logger::info("{$label} id={$id} удалён автором='{$_SESSION['admin_username']}'");
        echo json_encode(array('status' => 'ok'));
    }
}
