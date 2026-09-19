<?php

// Любая PHP-ошибка/предупреждение — в лог, а не в тело ответа: иначе одна Deprecated-
// строка ломает JSON у клиента и заодно показывает пути на сервере.
ini_set('display_errors', '0');
error_reporting(E_ALL);

// Кука сессии панели: недоступна из JS (HttpOnly), не уходит с чужих сайтов (SameSite),
// по HTTPS — только по HTTPS. Это защита сессии администратора, через которого
// выполняется код на всех кассах.
session_set_cookie_params(array(
    'httponly' => true,
    'samesite' => 'Lax',
    'secure'   => !empty($_SERVER['HTTPS']) && $_SERVER['HTTPS'] !== 'off',
    'path'     => '/',
));
session_start();

// Всё, что пишется в базу, храним в UTC: SQLite CURRENT_TIMESTAMP всегда UTC, и если бы
// PHP писал время в местной зоне, часть колонок разъехалась бы с другой частью. Местное
// время появляется только там, где его видит человек: в панели (переводится в браузере)
// и в тихих часах (переводятся по настройке timezone).
date_default_timezone_set('UTC');

require __DIR__ . '/../Core/Config.php';
require __DIR__ . '/../Core/Db.php';
require __DIR__ . '/../Core/Auth.php';
require __DIR__ . '/../Core/AdminAuth.php';
require __DIR__ . '/../Core/Logger.php';
set_error_handler(function ($severity, $message, $file, $line) {
    Logger::warning("PHP: {$message} в {$file}:{$line}");
    return true;
});
require __DIR__ . '/../Core/TargetMatcher.php';
require __DIR__ . '/../Core/Router.php';
require __DIR__ . '/../Modules/Notifications/OccurrencesController.php';
require __DIR__ . '/../Modules/Notifications/AckController.php';
require __DIR__ . '/../Modules/Notifications/AdminNotificationsController.php';
require __DIR__ . '/../Modules/Auth/AdminAuthController.php';
require __DIR__ . '/../Modules/Dashboard/AdminPcsController.php';
require __DIR__ . '/../Modules/Meta/AdminMetaController.php';
require __DIR__ . '/../Modules/Groups/AdminHostGroupsController.php';
require __DIR__ . '/../Modules/Manuals/AdminManualsController.php';
require __DIR__ . '/../Modules/Commands/CommandsController.php';
require __DIR__ . '/../Modules/Commands/AdminCommandsController.php';
require __DIR__ . '/../Modules/Commands/FileStorage.php';
require __DIR__ . '/../Modules/Commands/FilesController.php';
require __DIR__ . '/../Modules/Commands/AdminFilesController.php';
require __DIR__ . '/../Modules/Settings/AdminSettingsController.php';

header('Content-Type: application/json; charset=utf-8');

Logger::debug($_SERVER['REQUEST_METHOD'] . ' ' . $_SERVER['REQUEST_URI']);

$router = new Router();

// Агенты (токен в заголовке, не сессия)
$router->get('/occurrences', array('OccurrencesController', 'index'));
$router->post('/occurrences/{id}/ack', array('AckController', 'store'));
$router->get('/commands', array('CommandsController', 'index'));
$router->post('/commands/{id}/claim', array('CommandsController', 'claim'));
$router->post('/commands/{id}/result', array('CommandsController', 'result'));
$router->get('/files/{id}', array('FilesController', 'download'));

// Админ-панель (сессия, см. AdminAuth)
$router->post('/admin/login', array('AdminAuthController', 'login'));
$router->post('/admin/logout', array('AdminAuthController', 'logout'));
$router->get('/admin/me', array('AdminAuthController', 'me'));
$router->get('/admin/pcs', array('AdminPcsController', 'index'));
$router->post('/admin/pcs', array('AdminPcsController', 'store'));
$router->post('/admin/pcs/bulk', array('AdminPcsController', 'bulkStore'));
$router->get('/admin/pcs/configs.zip', array('AdminPcsController', 'exportConfigs'));
$router->get('/admin/stores', array('AdminMetaController', 'stores'));
$router->get('/admin/device-types', array('AdminMetaController', 'deviceTypes'));
$router->get('/admin/notifications', array('AdminNotificationsController', 'index'));
$router->post('/admin/notifications', array('AdminNotificationsController', 'store'));

$router->get('/admin/host-groups', array('AdminHostGroupsController', 'index'));
$router->post('/admin/host-groups', array('AdminHostGroupsController', 'store'));
$router->delete('/admin/host-groups/{id}', array('AdminHostGroupsController', 'destroy'));
$router->get('/admin/host-groups/{id}/members', array('AdminHostGroupsController', 'members'));
$router->post('/admin/host-groups/{id}/members', array('AdminHostGroupsController', 'addMember'));
$router->delete('/admin/host-groups/{id}/members/{pcId}', array('AdminHostGroupsController', 'removeMember'));

$router->get('/admin/manuals', array('AdminManualsController', 'index'));
$router->post('/admin/manuals', array('AdminManualsController', 'store'));
$router->put('/admin/manuals/{id}', array('AdminManualsController', 'update'));
$router->delete('/admin/manuals/{id}', array('AdminManualsController', 'destroy'));

$router->get('/admin/commands', array('AdminCommandsController', 'index'));
$router->post('/admin/commands', array('AdminCommandsController', 'store'));
$router->get('/admin/commands/{id}/results', array('AdminCommandsController', 'results'));
$router->get('/admin/files', array('AdminFilesController', 'index'));
$router->post('/admin/files', array('AdminFilesController', 'store'));
$router->delete('/admin/files/{id}', array('AdminFilesController', 'destroy'));

$router->get('/admin/settings', array('AdminSettingsController', 'index'));
$router->put('/admin/settings', array('AdminSettingsController', 'update'));

try {
    $router->dispatch($_SERVER['REQUEST_METHOD'], $_SERVER['REQUEST_URI']);
} catch (Exception $e) {
    // Ловим тут же, не даём PHP напечатать сырой стектрейс с путями сервера наружу.
    Logger::error($e->getMessage());
    http_response_code(500);
    echo json_encode(array('error' => 'internal_error'));
}
