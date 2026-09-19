<?php
// Разовый CLI-бутстрап ПЕРВОГО логина админ-панели. Дальше учётки заводятся на
// странице «Пользователи» в самой панели (нужна роль superadmin). Публичной
// регистрации нет и не будет.
// Запуск: php server/bin/create-admin.php <username> <password> [role]
// role: operator | administrator (по умолчанию) | superadmin

require __DIR__ . '/../Core/Config.php';
require __DIR__ . '/../Core/Db.php';

if ($argc < 3) {
    fwrite(STDERR, "Usage: php create-admin.php <username> <password> [role]\n");
    exit(1);
}

$username = $argv[1];
$password = $argv[2];
$role = isset($argv[3]) ? $argv[3] : 'administrator';

if (!in_array($role, array('operator', 'administrator', 'superadmin'), true)) {
    fwrite(STDERR, "role должна быть одной из: operator, administrator, superadmin\n");
    exit(1);
}

$db = Db::get();
$stmt = $db->prepare('INSERT INTO admin_users (username, password_hash, role) VALUES (:username, :hash, :role)');
$stmt->execute(array(
    'username' => $username,
    'hash'     => password_hash($password, PASSWORD_DEFAULT),
    'role'     => $role,
));

echo "Admin user '$username' created with role '$role' (id=" . $db->lastInsertId() . ").\n";
