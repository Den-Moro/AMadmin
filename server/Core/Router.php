<?php

// Самописный роутер вместо фреймворка: сопоставляет метод+путь с обработчиком.
// Поддерживает плейсхолдеры вида {id} в пути.
class Router
{
    private $routes = array();

    public function get($pattern, $handler)
    {
        $this->routes[] = array('method' => 'GET', 'pattern' => $pattern, 'handler' => $handler);
    }

    public function post($pattern, $handler)
    {
        $this->routes[] = array('method' => 'POST', 'pattern' => $pattern, 'handler' => $handler);
    }

    public function put($pattern, $handler)
    {
        $this->routes[] = array('method' => 'PUT', 'pattern' => $pattern, 'handler' => $handler);
    }

    public function delete($pattern, $handler)
    {
        $this->routes[] = array('method' => 'DELETE', 'pattern' => $pattern, 'handler' => $handler);
    }

    public function dispatch($method, $uri)
    {
        $path = parse_url($uri, PHP_URL_PATH);
        // /admin/stores/ и /admin/stores — один маршрут: браузер мог запомнить редирект
        // со слэшем от веб-сервера (301 кэшируется навсегда), а прокси любят добавлять его сами.
        $path = rtrim($path, '/') ?: '/';

        foreach ($this->routes as $route) {
            if ($route['method'] !== $method) {
                continue;
            }

            $regex = preg_replace('#\{[a-zA-Z_]+\}#', '([^/]+)', $route['pattern']);
            $regex = '#^' . $regex . '$#';

            if (preg_match($regex, $path, $matches)) {
                array_shift($matches);
                call_user_func_array($route['handler'], $matches);
                return;
            }
        }

        http_response_code(404);
        echo json_encode(array('error' => 'not_found'));
    }
}
