<?php

// Группы хостов. Обычная группа (kind = 'static') наполняется руками; смарт-группа
// (kind = 'smart', бета) — по правилам, её состав считает Core/SmartGroups.php. Смарт-
// группы видит и ведёт только superadmin: остальным они не показываются ни здесь, ни в
// выборе цели, а адресовать им что-либо сервер не даст (SmartGroups::targetAllowed).
class AdminHostGroupsController
{
    // GET /admin/host-groups — список групп со счётчиком участников.
    public static function index()
    {
        AdminAuth::requireLogin();
        $super = AdminAuth::isSuperadmin();

        $sql = "
            SELECT g.id, g.name, g.kind, g.rules, g.description, g.refreshed_at, g.brand_name, g.brand_contact,
                (SELECT COUNT(*) FROM host_group_members m WHERE m.group_id = g.id) AS member_count
            FROM host_groups g
            " . ($super ? '' : "WHERE g.kind = 'static'") . "
            ORDER BY g.kind = 'smart', g.name
        ";
        $rows = Db::get()->query($sql)->fetchAll();
        foreach ($rows as &$row) {
            $row['rules'] = $row['rules'] ? json_decode($row['rules'], true) : null;
        }
        unset($row);
        echo json_encode($rows);
    }

    // POST /admin/host-groups  body: { name, brand_name?, brand_contact?, kind?, rules?, description? }
    public static function store()
    {
        AdminAuth::requireLogin();

        $body = self::body();
        $name = isset($body['name']) ? trim($body['name']) : '';
        if ($name === '') {
            return self::fail(400, 'name_required');
        }

        $smart = isset($body['kind']) && $body['kind'] === 'smart';
        $rules = null;
        if ($smart) {
            AdminAuth::requireSuperadmin();
            $checked = SmartGroups::validate(isset($body['rules']) ? $body['rules'] : null);
            if (isset($checked['error'])) {
                return self::fail(400, $checked['error'], isset($checked['index']) ? $checked['index'] : null);
            }
            $rules = json_encode($checked['rules'], JSON_UNESCAPED_UNICODE);
        }

        $stmt = Db::get()->prepare('
            INSERT INTO host_groups (name, brand_name, brand_contact, kind, rules, description)
            VALUES (:name, :brand_name, :brand_contact, :kind, :rules, :description)
        ');
        $stmt->execute(array(
            'name'          => $name,
            'brand_name'    => self::optional($body, 'brand_name'),
            'brand_contact' => self::optional($body, 'brand_contact'),
            'kind'          => $smart ? 'smart' : 'static',
            'rules'         => $rules,
            'description'   => self::optional($body, 'description'),
        ));

        $id = (int) Db::get()->lastInsertId();
        $count = null;
        if ($smart) {
            $counts = SmartGroups::refresh($id);
            $count = isset($counts[$id]) ? $counts[$id] : 0;
        }
        Logger::info(($smart ? 'Смарт-группа' : 'Группа хостов') . " создана: id={$id} name='{$name}'" .
            ($smart ? " правила={$rules} касс={$count}" : '') . " автор='{$_SESSION['admin_username']}'");

        echo json_encode(array('status' => 'ok', 'id' => $id, 'member_count' => $count));
    }

    // PUT /admin/host-groups/{id}   body: { name, brand_name?, brand_contact?, rules?, description? }
    // Вид группы (обычная/смарт) после создания не меняется.
    public static function update($id)
    {
        AdminAuth::requireLogin();
        $group = self::find($id);
        if (!$group) {
            return self::fail(404, 'not_found');
        }
        $smart = $group['kind'] === 'smart';
        if ($smart) {
            AdminAuth::requireSuperadmin();
        }

        $body = self::body();
        $name = isset($body['name']) ? trim($body['name']) : '';
        if ($name === '') {
            return self::fail(400, 'name_required');
        }

        $rules = $group['rules'];
        if ($smart && isset($body['rules'])) {
            $checked = SmartGroups::validate($body['rules']);
            if (isset($checked['error'])) {
                return self::fail(400, $checked['error'], isset($checked['index']) ? $checked['index'] : null);
            }
            $rules = json_encode($checked['rules'], JSON_UNESCAPED_UNICODE);
        }

        Db::get()->prepare('
            UPDATE host_groups
            SET name = :name, brand_name = :brand_name, brand_contact = :brand_contact, rules = :rules, description = :description
            WHERE id = :id
        ')->execute(array(
            'id'            => (int) $id,
            'name'          => $name,
            'brand_name'    => self::optional($body, 'brand_name'),
            'brand_contact' => self::optional($body, 'brand_contact'),
            'rules'         => $rules,
            'description'   => self::optional($body, 'description'),
        ));

        $count = null;
        if ($smart) {
            $counts = SmartGroups::refresh((int) $id);
            $count = isset($counts[(int) $id]) ? $counts[(int) $id] : 0;
            if ($rules !== $group['rules']) {
                Logger::info("Смарт-группа id={$id} '{$name}': правила изменены на {$rules}, касс={$count} автор='{$_SESSION['admin_username']}'");
            }
        }
        echo json_encode(array('status' => 'ok', 'member_count' => $count));
    }

    // DELETE /admin/host-groups/{id} — участники удаляются каскадом (ON DELETE CASCADE
    // на host_group_members), оповещения, уже нацеленные на эту группу, не трогаем —
    // они просто перестанут кому-либо попадать, это история, а не живая настройка.
    public static function destroy($id)
    {
        AdminAuth::requireLogin();
        $group = self::find($id);
        if (!$group) {
            return self::fail(404, 'not_found');
        }
        if ($group['kind'] === 'smart') {
            AdminAuth::requireSuperadmin();
        }

        Db::get()->prepare('DELETE FROM host_groups WHERE id = :id')->execute(array('id' => (int) $id));
        Logger::info(($group['kind'] === 'smart' ? 'Смарт-группа' : 'Группа хостов') . " удалена: id={$id} name='{$group['name']}' автор='{$_SESSION['admin_username']}'");

        echo json_encode(array('status' => 'ok'));
    }

    // GET /admin/host-groups/{id}/members
    public static function members($id)
    {
        AdminAuth::requireLogin();
        $group = self::find($id);
        if (!$group) {
            return self::fail(404, 'not_found');
        }
        if ($group['kind'] === 'smart') {
            AdminAuth::requireSuperadmin();
        }

        $stmt = Db::get()->prepare('
            SELECT p.id, p.hostname, p.display_name, p.last_ip, s.name AS store_name
            FROM host_group_members m
            JOIN pcs p ON p.id = m.pc_id
            JOIN stores s ON s.id = p.store_id
            WHERE m.group_id = :group_id
            ORDER BY s.name, p.hostname
        ');
        $stmt->execute(array('group_id' => (int) $id));

        echo json_encode($stmt->fetchAll());
    }

    // POST /admin/host-groups/{id}/members  body: { pc_id } или { pc_ids: [...] }
    public static function addMember($id)
    {
        AdminAuth::requireLogin();
        $group = self::find($id);
        if (!$group) {
            return self::fail(404, 'not_found');
        }
        if ($group['kind'] === 'smart') {
            return self::fail(400, 'smart_group_members_are_computed');
        }

        $body = self::body();
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
            return self::fail(400, 'pc_id_required');
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
        $group = self::find($id);
        if ($group && $group['kind'] === 'smart') {
            return self::fail(400, 'smart_group_members_are_computed');
        }

        $stmt = Db::get()->prepare('DELETE FROM host_group_members WHERE group_id = :group_id AND pc_id = :pc_id');
        $stmt->execute(array('group_id' => (int) $id, 'pc_id' => (int) $pcId));

        echo json_encode(array('status' => 'ok'));
    }

    // POST /admin/host-groups/preview  body: { rules } — кто попадёт под правила прямо
    // сейчас (для конструктора смарт-группы, ничего не сохраняет).
    public static function preview()
    {
        AdminAuth::requireSuperadmin();
        $body = self::body();
        $checked = SmartGroups::validate(isset($body['rules']) ? $body['rules'] : null);
        if (isset($checked['error'])) {
            return self::fail(400, $checked['error'], isset($checked['index']) ? $checked['index'] : null);
        }

        $contexts = SmartGroups::contexts();
        $ids = SmartGroups::matchingIds($checked['rules'], $contexts);
        $online = 0;
        foreach ($contexts as $ctx) {
            if ($ctx['status'] === 'online' && in_array($ctx['id'], $ids, true)) {
                $online++;
            }
        }

        $sample = array();
        if ($ids) {
            $first = array_slice($ids, 0, 200);
            $stmt = Db::get()->query('
                SELECT p.id, p.hostname, p.display_name, p.last_ip, p.agent_version, p.ui_agent_version, s.name AS store_name
                FROM pcs p JOIN stores s ON s.id = p.store_id
                WHERE p.id IN (' . implode(',', array_map('intval', $first)) . ')
                ORDER BY s.name, p.hostname
            ');
            $sample = $stmt->fetchAll();
        }

        echo json_encode(array('count' => count($ids), 'online' => $online, 'total' => count($contexts), 'pcs' => $sample));
    }

    // POST /admin/host-groups/{id}/refresh — пересчитать состав смарт-группы сейчас.
    public static function refresh($id)
    {
        AdminAuth::requireSuperadmin();
        $counts = SmartGroups::refresh((int) $id);
        if (!isset($counts[(int) $id])) {
            return self::fail(404, 'not_found');
        }
        echo json_encode(array('status' => 'ok', 'member_count' => $counts[(int) $id]));
    }

    // ---- Помощники ----------------------------------------------------------------

    private static function find($id)
    {
        $stmt = Db::get()->prepare('SELECT id, name, kind, rules FROM host_groups WHERE id = :id');
        $stmt->execute(array('id' => (int) $id));
        return $stmt->fetch();
    }

    private static function body()
    {
        $body = json_decode(file_get_contents('php://input'), true);
        return is_array($body) ? $body : array();
    }

    private static function optional($body, $key)
    {
        return isset($body[$key]) && trim((string) $body[$key]) !== '' ? trim((string) $body[$key]) : null;
    }

    private static function fail($code, $error, $index = null)
    {
        http_response_code($code);
        $out = array('error' => $error);
        if ($index !== null) {
            $out['index'] = $index;
        }
        echo json_encode($out);
        return null;
    }
}
