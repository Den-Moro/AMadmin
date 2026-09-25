<?php

// Отдаёт HTML-страницы панели (server/Views/admin/...) по «чистым» путям без .html,
// и 301-редиректит старые /admin/....html ссылки/закладки на них — с сохранением
// query-строки (?id=, ?state= и т.д.). Сами .html-шаблоны специально лежат вне
// server/public/ — иначе nginx/.htaccess/router.php отдавали бы их напрямую как
// статику, и до этого класса запрос вообще бы не доходил.
//
// Важный нюанс: у части страниц чистый путь совпадает с путём JSON-эндпоинта списка
// того же раздела (например, GET /admin/stores — это одновременно страница «Справочники»
// и API-список магазинов, который дёргает сама эта страница через fetch). Различаем их
// по заголовку Accept: настоящая навигация браузера (адресная строка, клик по ссылке,
// 301-редирект) всегда шлёт Accept с text/html; fetch() из api.js — нет (по умолчанию
// */*). Поэтому maybeServe() отдаёт страницу только когда Accept просит html, а иначе
// пропускает запрос дальше, в обычный Router, к JSON-обработчику.
class PageRouter
{
    // Чистый путь -> файл вида относительно server/Views/admin/. Старый .html-путь
    // не хранится отдельно — он всегда "/admin/" + файл вида, поэтому не может
    // разъехаться с реальным расположением файла.
    private static $pages = array(
        '/admin' => 'index.html',
        '/admin/login' => 'login.html',
        '/admin/hosts' => 'hosts/hosts.html',
        '/admin/hosts/host' => 'hosts/host.html',
        '/admin/notifications' => 'notifications/notifications.html',
        '/admin/groups' => 'groups/groups.html',
        '/admin/manuals' => 'manuals/manuals.html',
        '/admin/commands' => 'commands/commands.html',
        '/admin/stores' => 'stores/stores.html',
        '/admin/logs' => 'logs/logs.html',
        '/admin/settings' => 'settings/settings.html',
        '/admin/users' => 'users/users.html',
        '/admin/updates' => 'updates/updates.html',
    );

    // Регистрирует в $router только 301-редиректы со старых .html-путей — они не
    // пересекаются с JSON API (тот никогда не отдаёт .html), так что тут коллизий нет
    // и обычный Router им подходит. Сами чистые пути через $router НЕ регистрируются —
    // см. maybeServe().
    public static function register(Router $router)
    {
        foreach (self::$pages as $cleanPath => $viewFile) {
            $oldPath = '/admin/' . $viewFile;
            if ($oldPath === $cleanPath) {
                continue;
            }
            $router->get($oldPath, function () use ($cleanPath) {
                PageRouter::redirectToClean($cleanPath);
            });
        }
    }

    // Вызывать до $router->dispatch(). true — страница уже отдана, дальше ничего
    // делать не нужно. false — не наша страница (или это не браузер, а fetch/агент) —
    // запрос идёт в обычный роутер как обычно.
    public static function maybeServe($requestUri)
    {
        if ($_SERVER['REQUEST_METHOD'] !== 'GET' || !self::wantsHtml()) {
            return false;
        }

        $path = parse_url($requestUri, PHP_URL_PATH);
        $path = rtrim($path, '/') ?: '/';

        if (!isset(self::$pages[$path])) {
            return false;
        }

        self::render(self::$pages[$path]);
        return true;
    }

    private static function wantsHtml()
    {
        $accept = isset($_SERVER['HTTP_ACCEPT']) ? $_SERVER['HTTP_ACCEPT'] : '';
        return strpos($accept, 'text/html') !== false;
    }

    private static function render($viewFile)
    {
        header('Content-Type: text/html; charset=utf-8');
        readfile(__DIR__ . '/../Views/admin/' . $viewFile);
    }

    private static function redirectToClean($cleanPath)
    {
        $qs = (isset($_SERVER['QUERY_STRING']) && $_SERVER['QUERY_STRING'] !== '') ? '?' . $_SERVER['QUERY_STRING'] : '';
        header('Location: ' . $cleanPath . $qs, true, 301);
    }
}
