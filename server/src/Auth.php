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
