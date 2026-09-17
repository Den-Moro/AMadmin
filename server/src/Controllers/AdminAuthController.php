<?php

class AdminAuthController
{
    public static function login()
    {
        $body = json_decode(file_get_contents('php://input'), true);
        $username = isset($body['username']) ? trim($body['username']) : '';
        $password = isset($body['password']) ? (string) $body['password'] : '';

        if ($username === '' || $password === '') {
            http_response_code(400);
            echo json_encode(array('error' => 'missing_credentials'));
            return;
        }

        $result = AdminAuth::attemptLogin($username, $password);

        if ($result === true) {
            Logger::info("Вход в админ-панель: '{$username}' успешно");
            echo json_encode(array('status' => 'ok', 'username' => $_SESSION['admin_username']));
            return;
        }

        if ($result === 'locked') {
            Logger::warning("Вход в админ-панель: '{$username}' заблокирован после подбора пароля");
            http_response_code(423);
            echo json_encode(array('error' => 'account_locked'));
            return;
        }

        Logger::warning("Вход в админ-панель: неверный пароль для '{$username}'");
        http_response_code(401);
        echo json_encode(array('error' => 'invalid_credentials'));
    }

    public static function logout()
    {
        if (!empty($_SESSION['admin_username'])) {
            Logger::info("Выход из админ-панели: '{$_SESSION['admin_username']}'");
        }
        $_SESSION = array();
        session_destroy();
        echo json_encode(array('status' => 'ok'));
    }

    public static function me()
    {
        AdminAuth::requireLogin();
        echo json_encode(array('username' => $_SESSION['admin_username']));
    }
}
