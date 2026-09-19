<?php

// Учётки админ-панели: список, создание, смена роли/пароля, разблокировка, удаление.
// Всё — только для superadmin (единственная роль, которая может менять права других).
// Своя учётка — отдельный маршрут /admin/me/password, доступный всем.
class AdminUsersController
{
    const ROLES = array('operator', 'administrator', 'superadmin');
    const MIN_PASSWORD_LENGTH = 8;

    // GET /admin/users
    public static function index()
    {
        AdminAuth::requireRole(array('superadmin'));

        $rows = Db::get()->query("
            SELECT id, username, role, created_at, failed_attempts,
                   CASE WHEN locked_until IS NOT NULL AND locked_until > CURRENT_TIMESTAMP THEN locked_until END AS locked_until
            FROM admin_users
            ORDER BY username
        ")->fetchAll();

        echo json_encode($rows);
    }

    // POST /admin/users   body: { username, password, role }
    public static function store()
    {
        AdminAuth::requireRole(array('superadmin'));

        $body = json_decode(file_get_contents('php://input'), true);
        $username = isset($body['username']) ? trim($body['username']) : '';
        $password = isset($body['password']) ? (string) $body['password'] : '';
        $role = isset($body['role']) ? $body['role'] : 'operator';

        if (!preg_match('/^[A-Za-z0-9._-]{2,64}$/', $username)) {
            http_response_code(400);
            echo json_encode(array('error' => 'invalid_username'));
            return;
        }
        if (!in_array($role, self::ROLES, true)) {
            http_response_code(400);
            echo json_encode(array('error' => 'invalid_role'));
            return;
        }
        if ($error = self::passwordError($password)) {
            http_response_code(400);
            echo json_encode(array('error' => $error));
            return;
        }

        try {
            $stmt = Db::get()->prepare('INSERT INTO admin_users (username, password_hash, role) VALUES (:u, :h, :r)');
            $stmt->execute(array('u' => $username, 'h' => password_hash($password, PASSWORD_DEFAULT), 'r' => $role));
        } catch (PDOException $e) {
            if ($e->getCode() !== '23000') {
                throw $e;
            }
            http_response_code(409);
            echo json_encode(array('error' => 'username_taken'));
            return;
        }

        $id = Db::get()->lastInsertId();
        Logger::info("Учётка панели создана: '{$username}' роль={$role} автор='{$_SESSION['admin_username']}'");
        echo json_encode(array('status' => 'ok', 'id' => $id));
    }

    // PUT /admin/users/{id}   body: { role?, password? }
    public static function update($id)
    {
        AdminAuth::requireRole(array('superadmin'));

        $id = (int) $id;
        $user = self::find($id);
        if (!$user) {
            http_response_code(404);
            echo json_encode(array('error' => 'not_found'));
            return;
        }

        $body = json_decode(file_get_contents('php://input'), true);
        $changes = array();

        if (isset($body['role']) && $body['role'] !== $user['role']) {
            if (!in_array($body['role'], self::ROLES, true)) {
                http_response_code(400);
                echo json_encode(array('error' => 'invalid_role'));
                return;
            }
            // Последнего superadmin понизить нельзя — иначе учётками станет некому управлять.
            if ($user['role'] === 'superadmin' && self::superadminCount() <= 1) {
                http_response_code(400);
                echo json_encode(array('error' => 'last_superadmin'));
                return;
            }
            Db::get()->prepare('UPDATE admin_users SET role = :r WHERE id = :id')->execute(array('r' => $body['role'], 'id' => $id));
            $changes[] = "роль {$user['role']} -> {$body['role']}";
        }

        if (!empty($body['password'])) {
            if ($error = self::passwordError($body['password'])) {
                http_response_code(400);
                echo json_encode(array('error' => $error));
                return;
            }
            // Новый пароль заодно снимает блокировку после подбора — это и есть способ
            // "вернуть доступ" человеку, который забыл пароль и залочил себя.
            Db::get()->prepare('UPDATE admin_users SET password_hash = :h, failed_attempts = 0, locked_until = NULL WHERE id = :id')
                ->execute(array('h' => password_hash($body['password'], PASSWORD_DEFAULT), 'id' => $id));
            $changes[] = 'пароль сброшен';
        }

        if ($changes) {
            Logger::info("Учётка '{$user['username']}' изменена: " . implode(', ', $changes) . " автор='{$_SESSION['admin_username']}'");
        }
        echo json_encode(array('status' => 'ok'));
    }

    // POST /admin/users/{id}/unlock — снять блокировку после неудачных попыток входа.
    public static function unlock($id)
    {
        AdminAuth::requireRole(array('superadmin'));

        $id = (int) $id;
        $user = self::find($id);
        if (!$user) {
            http_response_code(404);
            echo json_encode(array('error' => 'not_found'));
            return;
        }

        Db::get()->prepare('UPDATE admin_users SET failed_attempts = 0, locked_until = NULL WHERE id = :id')->execute(array('id' => $id));
        Logger::info("Учётка '{$user['username']}' разблокирована автором='{$_SESSION['admin_username']}'");
        echo json_encode(array('status' => 'ok'));
    }

    // DELETE /admin/users/{id}
    public static function destroy($id)
    {
        AdminAuth::requireRole(array('superadmin'));

        $id = (int) $id;
        $user = self::find($id);
        if (!$user) {
            http_response_code(404);
            echo json_encode(array('error' => 'not_found'));
            return;
        }
        if ($id === (int) $_SESSION['admin_id']) {
            http_response_code(400);
            echo json_encode(array('error' => 'cannot_delete_self'));
            return;
        }
        if ($user['role'] === 'superadmin' && self::superadminCount() <= 1) {
            http_response_code(400);
            echo json_encode(array('error' => 'last_superadmin'));
            return;
        }

        // История команд/файлов ссылается на автора (created_by) — записи остаются,
        // автор в них станет пустым, а не пропадёт вся история.
        $db = Db::get();
        $db->prepare('UPDATE commands SET created_by = NULL WHERE created_by = :id')->execute(array('id' => $id));
        $db->prepare('UPDATE deploy_files SET uploaded_by = NULL WHERE uploaded_by = :id')->execute(array('id' => $id));
        $db->prepare('DELETE FROM admin_users WHERE id = :id')->execute(array('id' => $id));

        Logger::info("Учётка '{$user['username']}' удалена автором='{$_SESSION['admin_username']}'");
        echo json_encode(array('status' => 'ok'));
    }

    // POST /admin/me/password   body: { current_password, new_password } — для всех ролей.
    public static function changeOwnPassword()
    {
        AdminAuth::requireLogin();

        $body = json_decode(file_get_contents('php://input'), true);
        $current = isset($body['current_password']) ? (string) $body['current_password'] : '';
        $new = isset($body['new_password']) ? (string) $body['new_password'] : '';

        $user = self::find((int) $_SESSION['admin_id']);
        if (!$user || !password_verify($current, $user['password_hash'])) {
            http_response_code(400);
            echo json_encode(array('error' => 'wrong_current_password'));
            return;
        }
        if ($error = self::passwordError($new)) {
            http_response_code(400);
            echo json_encode(array('error' => $error));
            return;
        }

        Db::get()->prepare('UPDATE admin_users SET password_hash = :h WHERE id = :id')
            ->execute(array('h' => password_hash($new, PASSWORD_DEFAULT), 'id' => $user['id']));

        Logger::info("Пользователь '{$user['username']}' сменил свой пароль");
        echo json_encode(array('status' => 'ok'));
    }

    // ---- Помощники ----------------------------------------------------------------

    private static function find($id)
    {
        $stmt = Db::get()->prepare('SELECT * FROM admin_users WHERE id = :id');
        $stmt->execute(array('id' => $id));
        return $stmt->fetch() ?: null;
    }

    private static function superadminCount()
    {
        return (int) Db::get()->query("SELECT COUNT(*) FROM admin_users WHERE role = 'superadmin'")->fetchColumn();
    }

    // Минимум 8 символов — через эту учётку выполняется код на всех кассах, «1234» тут
    // недопустимо (см. AGENTS.md, "строгий пароль").
    private static function passwordError($password)
    {
        if (mb_strlen($password) < self::MIN_PASSWORD_LENGTH) {
            return 'password_too_short';
        }
        return null;
    }
}
