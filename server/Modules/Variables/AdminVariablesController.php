<?php

// Переменные хоста в панели (бета, только superadmin) — см. Core/HostVariables.php.
class AdminVariablesController
{
    // GET /admin/variables — все переменные всех уровней.
    public static function index()
    {
        AdminAuth::requireSuperadmin();
        $rows = Db::get()->query("
            SELECT v.id, v.scope, v.scope_id, v.name, v.value, v.is_secret, v.note, v.updated_at,
                   u.username AS updated_by_username,
                   CASE v.scope
                       WHEN 'store' THEN (SELECT name FROM stores WHERE id = v.scope_id)
                       WHEN 'group' THEN (SELECT name FROM host_groups WHERE id = v.scope_id)
                       WHEN 'pc' THEN (SELECT COALESCE(NULLIF(display_name, ''), hostname) FROM pcs WHERE id = v.scope_id)
                   END AS scope_name
            FROM host_variables v
            LEFT JOIN admin_users u ON u.id = v.updated_by
            ORDER BY v.name COLLATE NOCASE,
                     CASE v.scope WHEN 'global' THEN 1 WHEN 'store' THEN 2 WHEN 'group' THEN 3 ELSE 4 END,
                     scope_name
        ")->fetchAll();
        echo json_encode($rows);
    }

    // POST /admin/variables  body: { scope, scope_id?, name, value, is_secret?, note? }
    public static function store()
    {
        AdminAuth::requireSuperadmin();
        $checked = self::check(self::body(), null);
        if (isset($checked['error'])) {
            return self::fail($checked['error']);
        }
        $v = $checked['row'];

        try {
            Db::get()->prepare('
                INSERT INTO host_variables (scope, scope_id, name, value, is_secret, note, updated_by)
                VALUES (:scope, :scope_id, :name, :value, :is_secret, :note, :updated_by)
            ')->execute($v + array('updated_by' => $_SESSION['admin_id']));
        } catch (PDOException $e) {
            if ($e->getCode() === '23000') {
                return self::fail('variable_exists');
            }
            throw $e;
        }
        $id = (int) Db::get()->lastInsertId();
        Logger::info("Переменная хоста создана: {$v['name']} уровень={$v['scope']}" . ($v['scope_id'] ? ":{$v['scope_id']}" : '') .
            ($v['is_secret'] ? ' (секретная)' : '') . " автор='{$_SESSION['admin_username']}'");
        self::afterChange();
        echo json_encode(array('status' => 'ok', 'id' => $id));
    }

    // PUT /admin/variables/{id}  — те же поля.
    public static function update($id)
    {
        AdminAuth::requireSuperadmin();
        $old = self::find($id);
        if (!$old) {
            return self::fail('not_found', 404);
        }
        $checked = self::check(self::body(), $old);
        if (isset($checked['error'])) {
            return self::fail($checked['error']);
        }
        $v = $checked['row'];

        try {
            Db::get()->prepare('
                UPDATE host_variables
                SET scope = :scope, scope_id = :scope_id, name = :name, value = :value, is_secret = :is_secret,
                    note = :note, updated_by = :updated_by, updated_at = CURRENT_TIMESTAMP
                WHERE id = :id
            ')->execute($v + array('updated_by' => $_SESSION['admin_id'], 'id' => (int) $id));
        } catch (PDOException $e) {
            if ($e->getCode() === '23000') {
                return self::fail('variable_exists');
            }
            throw $e;
        }
        // Значение секретной переменной в лог не пишем.
        Logger::info("Переменная хоста изменена: id={$id} {$v['name']} уровень={$v['scope']}" . ($v['scope_id'] ? ":{$v['scope_id']}" : '') .
            ($v['is_secret'] ? '' : " значение='" . mb_substr($v['value'], 0, 120) . "'") . " автор='{$_SESSION['admin_username']}'");
        self::afterChange();
        echo json_encode(array('status' => 'ok'));
    }

    // DELETE /admin/variables/{id}
    public static function destroy($id)
    {
        AdminAuth::requireSuperadmin();
        $old = self::find($id);
        if (!$old) {
            return self::fail('not_found', 404);
        }
        Db::get()->prepare('DELETE FROM host_variables WHERE id = :id')->execute(array('id' => (int) $id));
        Logger::info("Переменная хоста удалена: {$old['name']} уровень={$old['scope']}" . ($old['scope_id'] ? ":{$old['scope_id']}" : '') . " автор='{$_SESSION['admin_username']}'");
        self::afterChange();
        echo json_encode(array('status' => 'ok'));
    }

    // GET /admin/variables/effective?pc_id=N — что получит эта касса: значение и откуда.
    public static function effective()
    {
        AdminAuth::requireSuperadmin();
        $pcId = isset($_GET['pc_id']) ? (int) $_GET['pc_id'] : 0;
        $stmt = Db::get()->prepare('SELECT id, store_id FROM pcs WHERE id = :id');
        $stmt->execute(array('id' => $pcId));
        $pc = $stmt->fetch();
        if (!$pc) {
            return self::fail('not_found', 404);
        }
        $vars = array_values(HostVariables::effective($pc['id'], $pc['store_id']));
        usort($vars, function ($a, $b) { return strcasecmp($a['name'], $b['name']); });
        echo json_encode($vars);
    }

    // ---- Помощники ----------------------------------------------------------------

    // Проверка полей; $old — текущая строка при правке (поля, которых нет в теле, берутся из неё).
    private static function check(array $body, $old)
    {
        $get = function ($key, $default) use ($body, $old) {
            if (array_key_exists($key, $body)) {
                return $body[$key];
            }
            return $old && array_key_exists($key, $old) ? $old[$key] : $default;
        };

        $scope = (string) $get('scope', '');
        if (!isset(HostVariables::SCOPE_RANK[$scope])) {
            return array('error' => 'invalid_scope');
        }
        $scopeId = $scope === 'global' ? null : (int) $get('scope_id', 0);
        if ($scope !== 'global') {
            $table = array('store' => 'stores', 'group' => 'host_groups', 'pc' => 'pcs');
            $stmt = Db::get()->prepare('SELECT 1 FROM ' . $table[$scope] . ' WHERE id = :id');
            $stmt->execute(array('id' => $scopeId));
            if (!$stmt->fetch()) {
                return array('error' => 'scope_not_found');
            }
        }

        $name = trim((string) $get('name', ''));
        if (!preg_match(HostVariables::NAME_PATTERN, $name)) {
            return array('error' => 'invalid_variable_name');
        }
        $value = (string) $get('value', '');
        if (mb_strlen($value) > 4000) {
            return array('error' => 'value_too_long');
        }
        // Значение подставляется в скрипты как есть; перевод строки в нём почти всегда
        // ошибка копирования и ломает однострочные команды.
        if (strpos($value, "\n") !== false || strpos($value, "\r") !== false) {
            return array('error' => 'value_multiline');
        }
        $note = trim((string) $get('note', ''));

        return array('row' => array(
            'scope'     => $scope,
            'scope_id'  => $scopeId,
            'name'      => $name,
            'value'     => $value,
            'is_secret' => $get('is_secret', 0) ? 1 : 0,
            'note'      => $note !== '' ? mb_substr($note, 0, 300) : null,
        ));
    }

    // Условия смарт-групп могут зависеть от переменных — пересчитать сразу, а не через минуту.
    private static function afterChange()
    {
        try {
            SmartGroups::refresh();
        } catch (Exception $e) {
            Logger::error('Пересчёт смарт-групп после правки переменной: ' . $e->getMessage());
        }
    }

    private static function find($id)
    {
        $stmt = Db::get()->prepare('SELECT * FROM host_variables WHERE id = :id');
        $stmt->execute(array('id' => (int) $id));
        return $stmt->fetch();
    }

    private static function body()
    {
        $body = json_decode(file_get_contents('php://input'), true);
        return is_array($body) ? $body : array();
    }

    private static function fail($error, $code = 400)
    {
        http_response_code($code);
        echo json_encode(array('error' => $error));
        return null;
    }
}
