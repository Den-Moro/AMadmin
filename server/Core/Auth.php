<?php

class Auth
{
    // Токен агент передаёт заголовком "Authorization: Bearer <token>", а не в query string —
    // иначе он оседает в логах веб-сервера/прокси, через которые проходит запрос.
    public static function getBearerToken()
    {
        // Apache (mod_php) и IIS/FastCGI не кладут Authorization в $_SERVER по умолчанию —
        // берём его отовсюду, где он может оказаться. Без этого все агенты получали бы 401
        // на проде, хотя на php -S всё работало.
        $header = '';
        foreach (array('HTTP_AUTHORIZATION', 'REDIRECT_HTTP_AUTHORIZATION') as $key) {
            if (!empty($_SERVER[$key])) {
                $header = $_SERVER[$key];
                break;
            }
        }
        if ($header === '' && function_exists('getallheaders')) {
            foreach (getallheaders() as $name => $value) {
                if (strcasecmp($name, 'Authorization') === 0) {
                    $header = $value;
                    break;
                }
            }
        }
        if (preg_match('/^Bearer\s+(.+)$/i', $header, $matches)) {
            return trim($matches[1]);
        }

        return null;
    }

    // Heartbeat: отметить, что ПК только что выходил на связь, и запомнить, что на нём
    // стоит (заголовки X-Agent-*). Вызывается из обоих агентских опросов. Имя
    // пользователя берём только от UI-агента ($withUsername): агент управления работает
    // от SYSTEM и иначе затирал бы имя кассира на дашборде словом "SYSTEM".
    // Версию каждый агент пишет в своё поле (миграция 020): в одном общем она менялась бы
    // на каждом опросе, пока окно оповещений не перезапустится после обновления.
    public static function heartbeat($pc, $withUsername)
    {
        $ip = isset($_SERVER['REMOTE_ADDR']) ? $_SERVER['REMOTE_ADDR'] : null;
        $versionColumn = $withUsername ? 'ui_agent_version' : 'agent_version';

        $stmt = Db::get()->prepare("
            UPDATE pcs SET
                last_seen = CURRENT_TIMESTAMP,
                {$versionColumn} = COALESCE(:version, {$versionColumn}),
                hostname = COALESCE(:hostname, hostname),
                username = COALESCE(:username, username),
                last_ip = COALESCE(:ip, last_ip),
                ui_config_rev = COALESCE(:config_rev, ui_config_rev)
            WHERE id = :id
        ");
        $stmt->execute(array(
            'id'       => $pc['id'],
            // Какие настройки агента окно оповещений уже применило (см. AgentConfigController).
            'config_rev' => $withUsername && isset($_SERVER['HTTP_X_AGENT_CONFIG_REV']) ? substr((string) $_SERVER['HTTP_X_AGENT_CONFIG_REV'], 0, 40) : null,
            'version'  => isset($_SERVER['HTTP_X_AGENT_VERSION']) ? $_SERVER['HTTP_X_AGENT_VERSION'] : null,
            'hostname' => isset($_SERVER['HTTP_X_AGENT_HOSTNAME']) ? $_SERVER['HTTP_X_AGENT_HOSTNAME'] : null,
            'username' => $withUsername && isset($_SERVER['HTTP_X_AGENT_USERNAME']) ? $_SERVER['HTTP_X_AGENT_USERNAME'] : null,
            'ip'       => $ip,
        ));
    }

    // Возвращает строку pcs, которой принадлежит токен, или null, если токен отсутствует/не найден.
    public static function authenticatePc()
    {
        $token = self::getBearerToken();
        if ($token === null || $token === '') {
            return null;
        }

        $stmt = Db::get()->prepare('SELECT * FROM pcs WHERE agent_token = :token');
        $stmt->execute(array('token' => $token));
        $pc = $stmt->fetch();

        return $pc ? $pc : null;
    }
}
