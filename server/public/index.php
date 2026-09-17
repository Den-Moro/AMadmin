<?php

require __DIR__ . '/../src/Config.php';
require __DIR__ . '/../src/Db.php';
require __DIR__ . '/../src/Auth.php';
require __DIR__ . '/../src/Logger.php';
require __DIR__ . '/../src/TargetMatcher.php';
require __DIR__ . '/../src/Router.php';
require __DIR__ . '/../src/Controllers/OccurrencesController.php';
require __DIR__ . '/../src/Controllers/AckController.php';

header('Content-Type: application/json; charset=utf-8');

Logger::log($_SERVER['REQUEST_METHOD'] . ' ' . $_SERVER['REQUEST_URI']);

$router = new Router();
$router->get('/occurrences', array('OccurrencesController', 'index'));
$router->post('/occurrences/{id}/ack', array('AckController', 'store'));

try {
    $router->dispatch($_SERVER['REQUEST_METHOD'], $_SERVER['REQUEST_URI']);
} catch (Exception $e) {
    // Ловим тут же, не даём PHP напечатать сырой стектрейс с путями сервера наружу.
    Logger::log('ERROR: ' . $e->getMessage());
    http_response_code(500);
    echo json_encode(array('error' => 'internal_error'));
}
