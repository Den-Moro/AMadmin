<?php
// Разовый CLI-бутстрап первого логина админ-панели. Публичного эндпоинта регистрации
// нет и не будет — учётки панели заводятся так, руками, с доступом к серверу.
// Запуск: php server/bin/create-admin.php <username> <password>

require __DIR__ . '/../src/Config.php';
require __DIR__ . '/../src/Db.php';

if ($argc < 3) {
    fwrite(STDERR, "Usage: php create-admin.php <username> <password>\n");
    exit(1);
}

$username = $argv[1];
$password = $argv[2];

$db = Db::get();
$stmt = $db->prepare('INSERT INTO admin_users (username, password_hash) VALUES (:username, :hash)');
$stmt->execute(array(
    'username' => $username,
    'hash'     => password_hash($password, PASSWORD_DEFAULT),
));

echo "Admin user '$username' created (id=" . $db->lastInsertId() . ").\n";
