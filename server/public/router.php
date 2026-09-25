<?php
// Только для `php -S` (встроенный dev-сервер) — на Apache/IIS его роль играет .htaccess.
//
// Без этого файла встроенный сервер для путей вида /admin/login (которые не совпадают
// ни с одним реальным файлом, но лежат "внутри" существующей директории public/admin/)
// сам отдаёт директорию как 404, вместо того чтобы передать запрос в index.php —
// это ломает все /admin/* API-маршруты и страницы панели (обнаружено вручную при
// тестировании).

$path = parse_url($_SERVER['REQUEST_URI'], PHP_URL_PATH);
$fullPath = __DIR__ . $path;

// Страницы панели живут в server/Views, а не в public. Старый public/admin/*.html,
// оставшийся после обновления "распаковкой поверх", не должен перекрывать редирект
// со старой ссылки на чистый URL — такие запросы всегда идут в index.php.
$isStalePanelHtml = (bool) preg_match('~^/admin/.+\.html$~', $path);

if ($path !== '/' && !$isStalePanelHtml && file_exists($fullPath) && !is_dir($fullPath)) {
    return false; // отдать как есть — статический файл (css/js/картинки)
}

require __DIR__ . '/index.php';
