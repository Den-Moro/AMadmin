<?php

session_start();

require __DIR__ . '/../src/Config.php';
require __DIR__ . '/../src/Db.php';
require __DIR__ . '/../src/Auth.php';
require __DIR__ . '/../src/AdminAuth.php';
require __DIR__ . '/../src/Logger.php';
require __DIR__ . '/../src/TargetMatcher.php';
require __DIR__ . '/../src/Router.php';
require __DIR__ . '/../src/Controllers/OccurrencesController.php';
require __DIR__ . '/../src/Controllers/AckController.php';
require __DIR__ . '/../src/Controllers/AdminAuthController.php';
require __DIR__ . '/../src/Controllers/AdminPcsController.php';
require __DIR__ . '/../src/Controllers/AdminMetaController.php';
require __DIR__ . '/../src/Controllers/AdminNotificationsController.php';

header('Content-Type: application/json; charset=utf-8');

Logger::debug($_SERVER['REQUEST_METHOD'] . ' ' . $_SERVER['REQUEST_URI']);

$router = new Router();

// Агенты (токен в заголовке, не сессия)
$router->get('/occurrences', array('OccurrencesController', 'index'));
$router->post('/occurrences/{id}/ack', array('AckController', 'store'));

// Админ-панель (сессия, см. AdminAuth)
$router->post('/admin/login', array('AdminAuthController', 'login'));
$router->post('/admin/logout', array('AdminAuthController', 'logout'));
$router->get('/admin/me', array('AdminAuthController', 'me'));
$router->get('/admin/pcs', array('AdminPcsController', 'index'));
$router->get('/admin/stores', array('AdminMetaController', 'stores'));
$router->get('/admin/device-types', array('AdminMetaController', 'deviceTypes'));
$router->get('/admin/host-groups', array('AdminMetaController', 'hostGroups'));
$router->get('/admin/notifications', array('AdminNotificationsController', 'index'));
$router->post('/admin/notifications', array('AdminNotificationsController', 'store'));

try {
    $router->dispatch($_SERVER['REQUEST_METHOD'], $_SERVER['REQUEST_URI']);
} catch (Exception $e) {
    // Ловим тут же, не даём PHP напечатать сырой стектрейс с путями сервера наружу.
    Logger::error($e->getMessage());
    http_response_code(500);
    echo json_encode(array('error' => 'internal_error'));
}
