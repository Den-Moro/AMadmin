<?php

// Любая PHP-ошибка/предупреждение — в лог, а не в тело ответа: иначе одна Deprecated-
// строка ломает JSON у клиента и заодно показывает пути на сервере.
ini_set('display_errors', '0');
error_reporting(E_ALL);


// Всё, что пишется в базу, храним в UTC: SQLite CURRENT_TIMESTAMP всегда UTC, и если бы
// PHP писал время в местной зоне, часть колонок разъехалась бы с другой частью. Местное
// время появляется только там, где его видит человек: в панели (переводится в браузере)
// и в тихих часах (переводятся по настройке timezone).
date_default_timezone_set('UTC');

require __DIR__ . '/../Core/Config.php';
require __DIR__ . '/../Core/Db.php';
require __DIR__ . '/../Core/Settings.php';

// Кука сессии панели: недоступна из JS (HttpOnly), не уходит с чужих сайтов (SameSite),
// по HTTPS — только по HTTPS. Это защита сессии администратора, через которого
// выполняется код на всех кассах.
session_set_cookie_params(array(
    'httponly' => true,
    'samesite' => 'Lax',
    'secure'   => !empty($_SERVER['HTTPS']) && $_SERVER['HTTPS'] !== 'off',
    'path'     => '/',
    'lifetime' => max(1, Settings::int('session_lifetime_hours', 12)) * 3600,
));
// Файлы сессий — рядом с базой, а не в системном /tmp: тогда сессии администраторов
// переживают перезапуск/пересборку контейнера и переезд PHP на другую версию.
$sessionDir = __DIR__ . '/../data/sessions';
if (!is_dir($sessionDir)) {
    @mkdir($sessionDir, 0700, true);
}
if (is_writable($sessionDir)) {
    ini_set('session.save_path', $sessionDir);
}
// Время жизни сессии — из настроек панели (вкладка «Сервер»).
$sessionLifetime = max(1, Settings::int('session_lifetime_hours', 12)) * 3600;
ini_set('session.gc_maxlifetime', $sessionLifetime);
session_start();
require __DIR__ . '/../Core/Auth.php';
require __DIR__ . '/../Core/AdminAuth.php';
require __DIR__ . '/../Core/Logger.php';
set_error_handler(function ($severity, $message, $file, $line) {
    Logger::warning("PHP: {$message} в {$file}:{$line}");
    return true;
});
require __DIR__ . '/../Core/TargetMatcher.php';
require __DIR__ . '/../Core/NtpClient.php';
require __DIR__ . '/../Core/ServerMode.php';
require __DIR__ . '/../Core/ServerMetrics.php';
require __DIR__ . '/../Core/PeVersion.php';
require __DIR__ . '/../Core/NetworkSiteMatcher.php';
require __DIR__ . '/../Core/VersionCompare.php';
require __DIR__ . '/../Core/Csv.php';
require __DIR__ . '/../Core/HostVariables.php';
require __DIR__ . '/../Core/SmartGroups.php';
require __DIR__ . '/../Core/Recurrence.php';
require __DIR__ . '/../Core/Housekeeping.php';
require __DIR__ . '/../Core/Router.php';
require __DIR__ . '/../Core/PageRouter.php';
require __DIR__ . '/../Modules/Agent/AgentConfigController.php';
require __DIR__ . '/../Modules/Notifications/OccurrencesController.php';
require __DIR__ . '/../Modules/Notifications/AckController.php';
require __DIR__ . '/../Modules/Notifications/AdminNotificationsController.php';
require __DIR__ . '/../Modules/Notifications/AdminTemplatesController.php';
require __DIR__ . '/../Modules/Auth/AdminAuthController.php';
require __DIR__ . '/../Modules/Auth/AdminUsersController.php';
require __DIR__ . '/../Modules/Dashboard/AdminPcsController.php';
require __DIR__ . '/../Modules/Dashboard/AdminServerMetricsController.php';
require __DIR__ . '/../Modules/Dashboard/AdminStatsController.php';
require __DIR__ . '/../Modules/Logs/AdminLogsController.php';
require __DIR__ . '/../Modules/Meta/AdminMetaController.php';
require __DIR__ . '/../Modules/Groups/AdminHostGroupsController.php';
require __DIR__ . '/../Modules/Wiki/AdminWikiController.php';
require __DIR__ . '/../Modules/Media/MediaController.php';
require __DIR__ . '/../Modules/Dashboard/AdminAnnouncementsController.php';
require __DIR__ . '/../Modules/Commands/CommandsController.php';
require __DIR__ . '/../Modules/Commands/AdminCommandsController.php';
require __DIR__ . '/../Modules/Commands/FileStorage.php';
require __DIR__ . '/../Modules/Commands/FilesController.php';
require __DIR__ . '/../Modules/Commands/AdminFilesController.php';
require __DIR__ . '/../Modules/Commands/AdminDeployDestinationsController.php';
require __DIR__ . '/../Modules/Updates/AdminReleasesController.php';
require __DIR__ . '/../Modules/Stores/AdminStoresController.php';
require __DIR__ . '/../Modules/Settings/AdminSettingsController.php';
require __DIR__ . '/../Modules/Variables/AdminVariablesController.php';

header('Content-Type: application/json; charset=utf-8');

// Опрос страницы «Логи» сам в лог не пишем — иначе каждый открытый просмотр добавлял бы
// по строке каждые две секунды, и живой хвост состоял бы из самого себя.
if (strpos($_SERVER['REQUEST_URI'], '/admin/logs') !== 0) {
    Logger::debug($_SERVER['REQUEST_METHOD'] . ' ' . $_SERVER['REQUEST_URI']);
}

$router = new Router();

// Корень сайта — сразу на вход в панель: человек, набравший просто адрес сервера,
// не должен видеть {"error":"not_found"}.
$router->get('/', array('AdminAuthController', 'root'));

// Страницы панели (server/Views/admin/...) по чистым путям + 301 со старых .html-ссылок.
PageRouter::register($router);

// Агенты (токен в заголовке, не сессия)
$router->get('/agent/config', array('AgentConfigController', 'index'));
$router->get('/admin/agent-config/status', array('AgentConfigController', 'adminStatus'));
$router->get('/occurrences', array('OccurrencesController', 'index'));
$router->get('/occurrences/history', array('OccurrencesController', 'history'));
$router->get('/media/{id}', array('MediaController', 'agentShow'));
$router->post('/occurrences/{id}/ack', array('AckController', 'store'));
$router->get('/commands', array('CommandsController', 'index'));
$router->post('/commands/{id}/claim', array('CommandsController', 'claim'));
$router->post('/commands/{id}/result', array('CommandsController', 'result'));
$router->get('/files/{id}', array('FilesController', 'download'));

// Админ-панель (сессия, см. AdminAuth)
$router->post('/admin/login', array('AdminAuthController', 'login'));
$router->post('/admin/logout', array('AdminAuthController', 'logout'));
$router->get('/admin/me', array('AdminAuthController', 'me'));
$router->post('/admin/me/password', array('AdminUsersController', 'changeOwnPassword'));
$router->get('/admin/users', array('AdminUsersController', 'index'));
$router->post('/admin/users', array('AdminUsersController', 'store'));
$router->put('/admin/users/{id}', array('AdminUsersController', 'update'));
$router->post('/admin/users/{id}/unlock', array('AdminUsersController', 'unlock'));
$router->delete('/admin/users/{id}', array('AdminUsersController', 'destroy'));
$router->get('/admin/stats', array('AdminStatsController', 'index'));
$router->get('/admin/server-metrics', array('AdminServerMetricsController', 'index'));
$router->get('/admin/logs', array('AdminLogsController', 'index'));
$router->get('/admin/logs/download', array('AdminLogsController', 'download'));
$router->get('/admin/pcs', array('AdminPcsController', 'index'));
$router->post('/admin/pcs', array('AdminPcsController', 'store'));
$router->post('/admin/pcs/bulk', array('AdminPcsController', 'bulkStore'));
$router->post('/admin/pcs/move', array('AdminStoresController', 'movePcs'));
$router->post('/admin/pcs/import', array('AdminPcsController', 'import'));
$router->get('/admin/pcs/import/template', array('AdminPcsController', 'importTemplate'));
$router->get('/admin/pcs/configs.zip', array('AdminPcsController', 'exportConfigs'));
$router->get('/admin/pcs/{id}', array('AdminPcsController', 'show'));
$router->put('/admin/pcs/{id}', array('AdminPcsController', 'update'));
$router->delete('/admin/pcs/{id}', array('AdminPcsController', 'destroy'));
$router->post('/admin/pcs/{id}/token', array('AdminPcsController', 'regenerateToken'));
$router->get('/admin/stores', array('AdminStoresController', 'index'));
$router->get('/admin/stores/auto-assign', array('AdminStoresController', 'autoAssignPreview'));
$router->post('/admin/stores/auto-assign', array('AdminStoresController', 'autoAssign'));
$router->get('/admin/stores/{id}', array('AdminStoresController', 'show'));
$router->get('/admin/stores/{id}/suggestions', array('AdminStoresController', 'suggestions'));
$router->post('/admin/stores', array('AdminMetaController', 'storeStore'));
$router->put('/admin/stores/{id}', array('AdminMetaController', 'updateStore'));
$router->delete('/admin/stores/{id}', array('AdminMetaController', 'destroyStore'));
$router->get('/admin/device-types', array('AdminMetaController', 'deviceTypes'));
$router->post('/admin/device-types', array('AdminMetaController', 'storeDeviceType'));
$router->put('/admin/device-types/{id}', array('AdminMetaController', 'updateDeviceType'));
$router->delete('/admin/device-types/{id}', array('AdminMetaController', 'destroyDeviceType'));
$router->get('/admin/notifications', array('AdminNotificationsController', 'index'));
$router->get('/admin/message-templates', array('AdminTemplatesController', 'index'));
$router->post('/admin/media', array('MediaController', 'store'));
$router->get('/admin/media/{id}', array('MediaController', 'adminShow'));
$router->get('/admin/announcements', array('AdminAnnouncementsController', 'index'));
$router->post('/admin/announcements', array('AdminAnnouncementsController', 'store'));
$router->put('/admin/announcements/{id}', array('AdminAnnouncementsController', 'update'));
$router->delete('/admin/announcements/{id}', array('AdminAnnouncementsController', 'destroy'));
$router->get('/admin/wiki', array('AdminWikiController', 'index'));
$router->get('/admin/wiki/search', array('AdminWikiController', 'search'));
$router->get('/admin/wiki/articles/{id}', array('AdminWikiController', 'show'));
$router->post('/admin/wiki/articles', array('AdminWikiController', 'storeArticle'));
$router->put('/admin/wiki/articles/{id}', array('AdminWikiController', 'updateArticle'));
$router->delete('/admin/wiki/articles/{id}', array('AdminWikiController', 'destroyArticle'));
$router->post('/admin/wiki/sections', array('AdminWikiController', 'storeSection'));
$router->put('/admin/wiki/sections/{id}', array('AdminWikiController', 'updateSection'));
$router->delete('/admin/wiki/sections/{id}', array('AdminWikiController', 'destroySection'));
$router->post('/admin/message-templates', array('AdminTemplatesController', 'store'));
$router->put('/admin/message-templates/{id}', array('AdminTemplatesController', 'update'));
$router->delete('/admin/message-templates/{id}', array('AdminTemplatesController', 'destroy'));
$router->post('/admin/notifications', array('AdminNotificationsController', 'store'));
$router->get('/admin/notifications/stats.csv', array('AdminNotificationsController', 'statsCsv'));
$router->get('/admin/notifications/{id}/acks', array('AdminNotificationsController', 'acks'));
$router->post('/admin/notifications/{id}/stop', array('AdminNotificationsController', 'stopRepeat'));
$router->delete('/admin/notifications/{id}', array('AdminNotificationsController', 'destroy'));

$router->get('/admin/host-groups', array('AdminHostGroupsController', 'index'));
$router->post('/admin/host-groups', array('AdminHostGroupsController', 'store'));
$router->post('/admin/host-groups/preview', array('AdminHostGroupsController', 'preview'));
$router->post('/admin/host-groups/{id}/refresh', array('AdminHostGroupsController', 'refresh'));
$router->put('/admin/host-groups/{id}', array('AdminHostGroupsController', 'update'));
$router->delete('/admin/host-groups/{id}', array('AdminHostGroupsController', 'destroy'));
$router->get('/admin/host-groups/{id}/members', array('AdminHostGroupsController', 'members'));
$router->post('/admin/host-groups/{id}/members', array('AdminHostGroupsController', 'addMember'));
$router->delete('/admin/host-groups/{id}/members/{pcId}', array('AdminHostGroupsController', 'removeMember'));



$router->get('/admin/commands', array('AdminCommandsController', 'index'));
$router->post('/admin/commands', array('AdminCommandsController', 'store'));
$router->post('/admin/commands/batch', array('AdminCommandsController', 'storeBatch'));
$router->get('/admin/commands/{id}/results', array('AdminCommandsController', 'results'));
$router->get('/admin/commands/{id}/results.csv', array('AdminCommandsController', 'resultsCsv'));
$router->get('/admin/files', array('AdminFilesController', 'index'));
$router->post('/admin/files', array('AdminFilesController', 'store'));
$router->get('/admin/files/recent-folders', array('AdminFilesController', 'recentFolders'));
$router->delete('/admin/files/{id}', array('AdminFilesController', 'destroy'));
$router->get('/admin/deploy-destinations', array('AdminDeployDestinationsController', 'index'));
$router->post('/admin/deploy-destinations', array('AdminDeployDestinationsController', 'store'));
$router->put('/admin/deploy-destinations/{id}', array('AdminDeployDestinationsController', 'update'));
$router->delete('/admin/deploy-destinations/{id}', array('AdminDeployDestinationsController', 'destroy'));
$router->get('/admin/agent-releases', array('AdminReleasesController', 'index'));
$router->post('/admin/agent-releases', array('AdminReleasesController', 'store'));
$router->get('/admin/agent-releases/import', array('AdminReleasesController', 'importPreview'));
$router->post('/admin/agent-releases/import', array('AdminReleasesController', 'import'));
$router->put('/admin/agent-releases/{id}', array('AdminReleasesController', 'update'));
$router->delete('/admin/agent-releases/{id}', array('AdminReleasesController', 'destroy'));
$router->post('/admin/agent-releases/{id}/deploy', array('AdminReleasesController', 'deploy'));

// Переменные хоста (бета, только superadmin).
$router->get('/admin/variables', array('AdminVariablesController', 'index'));
$router->get('/admin/variables/effective', array('AdminVariablesController', 'effective'));
$router->post('/admin/variables', array('AdminVariablesController', 'store'));
$router->put('/admin/variables/{id}', array('AdminVariablesController', 'update'));
$router->delete('/admin/variables/{id}', array('AdminVariablesController', 'destroy'));

$router->get('/admin/settings', array('AdminSettingsController', 'index'));
$router->put('/admin/settings', array('AdminSettingsController', 'update'));

// Фоновые задачи раз в минуту (смарт-группы, повторы оповещений) — см. Housekeeping.
Housekeeping::tick();

try {
    // У части страниц чистый путь совпадает с путём JSON-эндпоинта того же раздела
    // (например, GET /admin/stores — и страница «Магазины», и список магазинов,
    // который эта страница сама же запрашивает через fetch). PageRouter отличает
    // навигацию браузера от fetch/агента по Accept и отдаёт страницу первым; для
    // остального (в т.ч. для того же пути без text/html в Accept) — обычный роутер.
    if (!PageRouter::maybeServe($_SERVER['REQUEST_URI'])) {
        $router->dispatch($_SERVER['REQUEST_METHOD'], $_SERVER['REQUEST_URI']);
    }
} catch (Exception $e) {
    // Ловим тут же, не даём PHP напечатать сырой стектрейс с путями сервера наружу.
    Logger::error($e->getMessage());
    http_response_code(500);
    echo json_encode(array('error' => 'internal_error'));
}
