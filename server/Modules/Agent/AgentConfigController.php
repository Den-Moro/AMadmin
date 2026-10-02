<?php

// Раздел настроек, которые нужны самому агенту, а не только панели — пока только
// пароль защиты клиента и версия, которая считается актуальной. Отдельный эндпоинт,
// не поле в /occurrences: тело /occurrences — список, его форму старые агенты не поймут.
//
// Доставка без задержки: в каждом ответе на /occurrences сервер присылает отпечаток
// текущих настроек (заголовок X-Agent-Config-Rev), агент перечитывает /agent/config,
// только если отпечаток изменился, и сообщает применённый в том же заголовке своих
// запросов — по нему панель показывает, на каких кассах настройка уже действует.
class AgentConfigController
{
    public static function payload()
    {
        return array(
            'client_lock_enabled'       => Settings::bool('client_lock_enabled', false),
            'client_lock_password_hash' => Settings::get('client_lock_password_hash', ''),
            'current_agent_version'     => Settings::get('current_agent_version', ''),
        );
    }

    public static function revision()
    {
        return substr(sha1(json_encode(self::payload())), 0, 12);
    }

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

        $payload = self::payload();
        $payload['revision'] = self::revision();

        // Окно оповещений применяет полученное сразу, в памяти — отмечаем сейчас, а не на
        // его следующем опросе (иначе панель показывала бы «ждёт» лишние полминуты). Если
        // не применило, следующий опрос пришлёт прежний отпечаток и heartbeat его вернёт.
        Db::get()->prepare('UPDATE pcs SET ui_config_rev = :rev WHERE id = :id')
            ->execute(array('rev' => $payload['revision'], 'id' => $pc['id']));

        Logger::debug('GET /agent/config: pc_id=' . $pc['id'] . ' revision=' . $payload['revision']);
        echo json_encode($payload);
    }

    // GET /admin/agent-config/status — на каких кассах текущие настройки агента уже
    // применены. Считаем по окну оповещений: именно оно спрашивает пароль.
    public static function adminStatus()
    {
        AdminAuth::requireLogin();

        $revision = self::revision();
        $window = Settings::int('online_window_seconds', AdminPcsController::ONLINE_WINDOW_SECONDS);
        $rows = Db::get()->query("
            SELECT p.id, p.hostname, p.display_name, p.last_seen, p.ui_config_rev, p.ui_agent_version,
                   s.name AS store_name,
                   (julianday('now') - julianday(p.last_seen)) * 86400.0 AS seconds_since_seen
            FROM pcs p
            JOIN stores s ON s.id = p.store_id
            ORDER BY s.name, p.hostname
        ")->fetchAll();

        $applied = 0;
        $pending = array();
        foreach ($rows as $row) {
            if ($row['ui_config_rev'] === $revision) {
                $applied++;
                continue;
            }
            $online = $row['last_seen'] !== null && $row['seconds_since_seen'] <= $window;
            if ($row['ui_agent_version'] === null) {
                $reason = 'no_ui';          // окно оповещений ни разу не выходило на связь
            } elseif ($row['ui_config_rev'] === null) {
                $reason = 'old_agent';      // версия агента не сообщает, что применила
            } else {
                $reason = $online ? 'waiting' : 'offline';
            }
            $pending[] = array(
                'id' => (int) $row['id'], 'hostname' => $row['hostname'], 'display_name' => $row['display_name'],
                'store_name' => $row['store_name'], 'last_seen' => $row['last_seen'], 'online' => $online, 'reason' => $reason,
            );
        }

        echo json_encode(array(
            'revision' => $revision,
            'total'    => count($rows),
            'applied'  => $applied,
            'pending'  => $pending,
        ));
    }
}
