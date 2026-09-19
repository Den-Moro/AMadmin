<?php

class Auth
{
    // Токен агент передаёт заголовком "Authorization: Bearer <token>", а не в query string —
    // иначе он оседает в логах веб-сервера/прокси, через которые проходит запрос.
    public static function getBearerToken()
    {
        $header = isset($_SERVER['HTTP_AUTHORIZATION']) ? $_SERVER['HTTP_AUTHORIZATION'] : '';
        if (preg_match('/^Bearer\s+(.+)$/i', $header, $matches)) {
            return trim($matches[1]);
        }

        return null;
    }

    // Heartbeat: отметить, что ПК только что выходил на связь, и запомнить, что на нём
    // стоит (заголовки X-Agent-*). Вызывается из обоих агентских опросов. Имя
    // пользователя берём только от UI-агента ($withUsername): агент управления работает
    // от SYSTEM и иначе затирал бы имя кассира на дашборде словом "SYSTEM".
    public static function heartbeat($pc, $withUsername)
    {
        $stmt = Db::get()->prepare('
            UPDATE pcs SET
                last_seen = CURRENT_TIMESTAMP,
                agent_version = COALESCE(:version, agent_version),
                hostname = COALESCE(:hostname, hostname),
                username = COALESCE(:username, username)
            WHERE id = :id
        ');
        $stmt->execute(array(
            'id'       => $pc['id'],
            'version'  => isset($_SERVER['HTTP_X_AGENT_VERSION']) ? $_SERVER['HTTP_X_AGENT_VERSION'] : null,
            'hostname' => isset($_SERVER['HTTP_X_AGENT_HOSTNAME']) ? $_SERVER['HTTP_X_AGENT_HOSTNAME'] : null,
            'username' => $withUsername && isset($_SERVER['HTTP_X_AGENT_USERNAME']) ? $_SERVER['HTTP_X_AGENT_USERNAME'] : null,
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
