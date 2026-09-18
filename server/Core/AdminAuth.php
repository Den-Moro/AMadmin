<?php

class AdminAuth
{
    const MAX_ATTEMPTS = 5;
    const LOCKOUT_MINUTES = 15;

    // Останавливает выполнение с 401, если в панель никто не вошёл. Вызывается первой
    // строкой в каждом admin-контроллере, кроме самого login.
    public static function requireLogin()
    {
        if (empty($_SESSION['admin_id'])) {
            http_response_code(401);
            echo json_encode(array('error' => 'auth_required'));
            exit;
        }
    }

    // Как requireLogin(), но ещё и проверяет роль — для самых рискованных действий
    // (например, отправка команд удалённого администрирования). $allowedRoles — список
    // ролей, которым это разрешено, например array('administrator', 'superadmin').
    public static function requireRole($allowedRoles)
    {
        self::requireLogin();

        if (!in_array($_SESSION['admin_role'], $allowedRoles, true)) {
            http_response_code(403);
            echo json_encode(array('error' => 'insufficient_role'));
            exit;
        }
    }

    // true — вход выполнен, false — неверный логин/пароль, 'locked' — учётка временно
    // заблокирована из-за подбора.
    public static function attemptLogin($username, $password)
    {
        $stmt = Db::get()->prepare('SELECT * FROM admin_users WHERE username = :username');
        $stmt->execute(array('username' => $username));
        $user = $stmt->fetch();

        // Одинаковый ответ на "нет такого логина" и "неверный пароль" — не подтверждаем
        // существование конкретного логина отдельным кодом ошибки.
        if (!$user) {
            return false;
        }

        if ($user['locked_until'] !== null && strtotime($user['locked_until']) > time()) {
            return 'locked';
        }

        if (!password_verify($password, $user['password_hash'])) {
            self::registerFailedAttempt($user);
            return false;
        }

        self::resetAttempts($user['id']);
        $_SESSION['admin_id'] = $user['id'];
        $_SESSION['admin_username'] = $user['username'];
        $_SESSION['admin_role'] = $user['role'];

        return true;
    }

    private static function registerFailedAttempt($user)
    {
        $attempts = $user['failed_attempts'] + 1;
        $lockedUntil = null;

        if ($attempts >= self::MAX_ATTEMPTS) {
            $lockedUntil = date('Y-m-d H:i:s', time() + self::LOCKOUT_MINUTES * 60);
        }

        $stmt = Db::get()->prepare('UPDATE admin_users SET failed_attempts = :attempts, locked_until = :locked WHERE id = :id');
        $stmt->execute(array('attempts' => $attempts, 'locked' => $lockedUntil, 'id' => $user['id']));
    }

    private static function resetAttempts($id)
    {
        $stmt = Db::get()->prepare('UPDATE admin_users SET failed_attempts = 0, locked_until = NULL WHERE id = :id');
        $stmt->execute(array('id' => $id));
    }
}
