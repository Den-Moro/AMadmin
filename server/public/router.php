<?php
// Только для `php -S` (встроенный dev-сервер) — на Apache/IIS его роль играет .htaccess.
//
// Без этого файла встроенный сервер для путей вида /admin/login (которые не совпадают
// ни с одним реальным файлом, но лежат "внутри" существующей директории public/admin/)
// сам отдаёт public/admin/index.html вместо того, чтобы передать запрос в index.php —
// это ломает все /admin/* API-маршруты (обнаружено вручную при тестировании).

$path = parse_url($_SERVER['REQUEST_URI'], PHP_URL_PATH);
$fullPath = __DIR__ . $path;

if ($path !== '/' && file_exists($fullPath) && !is_dir($fullPath)) {
    return false; // отдать как есть — статический файл (html/css/js)
}

require __DIR__ . '/index.php';
