<?php

class AdminHostGroupsController
{
    // GET /admin/host-groups — список групп со счётчиком участников (для экрана
    // управления группами; для дропдауна таргетинга в форме оповещения достаточно
    // AdminMetaController::hostGroups, он этот счётчик не тянет).
    public static function index()
    {
        AdminAuth::requireLogin();

        $sql = "
            SELECT g.id, g.name,
                (SELECT COUNT(*) FROM host_group_members m WHERE m.group_id = g.id) AS member_count
            FROM host_groups g
            ORDER BY g.name
        ";
        echo json_encode(Db::get()->query($sql)->fetchAll());
    }

    // POST /admin/host-groups  body: { name }
    public static function store()
    {
        AdminAuth::requireLogin();

        $body = json_decode(file_get_contents('php://input'), true);
        $name = isset($body['name']) ? trim($body['name']) : '';

        if ($name === '') {
            http_response_code(400);
            echo json_encode(array('error' => 'name_required'));
            return;
        }

        $stmt = Db::get()->prepare('INSERT INTO host_groups (name) VALUES (:name)');
        $stmt->execute(array('name' => $name));

        $id = Db::get()->lastInsertId();
        Logger::info("Группа хостов создана: id={$id} name='{$name}' автор='{$_SESSION['admin_username']}'");

        echo json_encode(array('status' => 'ok', 'id' => $id));
    }

    // DELETE /admin/host-groups/{id} — участники удаляются каскадом (ON DELETE CASCADE
    // на host_group_members), оповещения, уже нацеленные на эту группу, не трогаем —
    // они просто перестанут кому-либо попадать, это история, а не живая настройка.
    // PUT /admin/host-groups/{id}   body: { name }
    public static function update($id)
    {
        AdminAuth::requireLogin();
        $body = json_decode(file_get_contents('php://input'), true);
        $name = isset($body['name']) ? trim($body['name']) : '';
        if ($name === '') {
            http_response_code(400);
            echo json_encode(array('error' => 'name_required'));
            return;
        }
        Db::get()->prepare('UPDATE host_groups SET name = :name WHERE id = :id')->execute(array('name' => $name, 'id' => (int) $id));
        echo json_encode(array('status' => 'ok'));
    }

    public static function destroy($id)
    {
        AdminAuth::requireLogin();

        $id = (int) $id;
        $stmt = Db::get()->prepare('DELETE FROM host_groups WHERE id = :id');
        $stmt->execute(array('id' => $id));

        Logger::info("Группа хостов удалена: id={$id} автор='{$_SESSION['admin_username']}'");

        echo json_encode(array('status' => 'ok'));
    }

    // GET /admin/host-groups/{id}/members
    public static function members($id)
    {
        AdminAuth::requireLogin();

        $stmt = Db::get()->prepare('
            SELECT p.id, p.hostname, p.display_name, s.name AS store_name
            FROM host_group_members m
            JOIN pcs p ON p.id = m.pc_id
            JOIN stores s ON s.id = p.store_id
            WHERE m.group_id = :group_id
            ORDER BY p.hostname
        ');
        $stmt->execute(array('group_id' => (int) $id));

        echo json_encode($stmt->fetchAll());
    }

    // POST /admin/host-groups/{id}/members  body: { pc_id }
    public static function addMember($id)
    {
        AdminAuth::requireLogin();

        $body = json_decode(file_get_contents('php://input'), true);
        // Один pc_id или сразу список pc_ids — группу обычно наполняют пачкой.
        $ids = array();
        if (!empty($body['pc_id'])) {
            $ids[] = (int) $body['pc_id'];
        }
        if (!empty($body['pc_ids']) && is_array($body['pc_ids'])) {
            foreach ($body['pc_ids'] as $pcId) {
                $ids[] = (int) $pcId;
            }
        }
        $ids = array_values(array_unique(array_filter($ids)));

        if (!$ids) {
            http_response_code(400);
            echo json_encode(array('error' => 'pc_id_required'));
            return;
        }

        // INSERT OR IGNORE — добавление уже состоящего в группе ПК просто ничего не делает,
        // а не падает на PRIMARY KEY (group_id, pc_id).
        $stmt = Db::get()->prepare('INSERT OR IGNORE INTO host_group_members (group_id, pc_id) VALUES (:group_id, :pc_id)');
        foreach ($ids as $pcId) {
            $stmt->execute(array('group_id' => (int) $id, 'pc_id' => $pcId));
        }

        echo json_encode(array('status' => 'ok', 'added' => count($ids)));
    }

    // DELETE /admin/host-groups/{id}/members/{pcId}
    public static function removeMember($id, $pcId)
    {
        AdminAuth::requireLogin();

        $stmt = Db::get()->prepare('DELETE FROM host_group_members WHERE group_id = :group_id AND pc_id = :pc_id');
        $stmt->execute(array('group_id' => (int) $id, 'pc_id' => (int) $pcId));

        echo json_encode(array('status' => 'ok'));
    }
}
