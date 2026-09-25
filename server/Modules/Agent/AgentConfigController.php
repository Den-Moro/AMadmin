<?php

// Раздел настроек, которые нужны самому агенту, а не только панели — пока только
// пароль защиты клиента и версия, которая считается актуальной. Отдельный эндпоинт,
// не поле в /occurrences или /commands: опрашивается ManagementAgent-ом и/или
// UiAgent-ом заметно реже (агент сам решает как часто), чем сами команды/оповещения.
class AgentConfigController
{
    // GET /agent/config
    public static function index()
    {
        $pc = Auth::authenticatePc();
        if (!$pc) {
            Logger::warning('GET /agent/config: неверный или отсутствующий agent_token');
            http_response_code(401);
            echo json_encode(array('error' => 'invalid_token'));
            return;
        }

        echo json_encode(array(
            'client_lock_enabled'       => Settings::bool('client_lock_enabled', false),
            'client_lock_password_hash' => Settings::get('client_lock_password_hash', ''),
            'current_agent_version'     => Settings::get('current_agent_version', ''),
        ));
    }
}
