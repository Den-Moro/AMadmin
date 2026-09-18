<?php

class OccurrencesController
{
    // GET /occurrences
    // Возвращает для текущего ПК (определяется по Bearer-токену) список показов
    // оповещений, которые уже наступили (fire_at <= NOW()) и на которые от этого ПК
    // ещё нет ack. Таргетинг — см. TargetMatcher.
    public static function index()
    {
        $pc = Auth::authenticatePc();
        if (!$pc) {
            Logger::warning('GET /occurrences: неверный или отсутствующий agent_token');
            http_response_code(401);
            echo json_encode(array('error' => 'invalid_token'));
            return;
        }

        // Одновременно и heartbeat: last_seen обновляется на каждом опросе. Агент шлёт
        // свою версию, hostname и текущего пользователя заголовками — сохраняем их, так
        // дашборд знает, что реально стоит на кассе (старый PowerShell-агент заголовков
        // не шлёт — тогда поля просто не трогаем).
        $update = Db::get()->prepare('
            UPDATE pcs SET
                last_seen = CURRENT_TIMESTAMP,
                agent_version = COALESCE(:version, agent_version),
                hostname = COALESCE(:hostname, hostname),
                username = COALESCE(:username, username)
            WHERE id = :id
        ');
        $update->execute(array(
            'id'       => $pc['id'],
            'version'  => isset($_SERVER['HTTP_X_AGENT_VERSION']) ? $_SERVER['HTTP_X_AGENT_VERSION'] : null,
            'hostname' => isset($_SERVER['HTTP_X_AGENT_HOSTNAME']) ? $_SERVER['HTTP_X_AGENT_HOSTNAME'] : null,
            'username' => isset($_SERVER['HTTP_X_AGENT_USERNAME']) ? $_SERVER['HTTP_X_AGENT_USERNAME'] : null,
        ));

        $sql = "
            SELECT DISTINCT
                o.id AS occurrence_id,
                n.text,
                n.priority,
                n.manual_url,
                n.size,
                o.fire_at
            FROM notification_occurrences o
            JOIN notifications n ON n.id = o.notification_id
            JOIN notification_targets t ON t.notification_id = n.id
            " . TargetMatcher::JOIN . "
            LEFT JOIN notification_acks a ON a.occurrence_id = o.id AND a.pc_id = :ack_pc_id
            WHERE o.fire_at <= CURRENT_TIMESTAMP
              AND a.id IS NULL
              AND " . TargetMatcher::CONDITION . "
            ORDER BY (n.priority = 'important') DESC, o.fire_at ASC
        ";
        // (n.priority = 'important') DESC — в MySQL булево выражение даёт 0/1,
        // так важные оповещения оказываются раньше неважных без CASE.

        $params = TargetMatcher::params($pc);
        $params['ack_pc_id'] = $pc['id'];

        $stmt = Db::get()->prepare($sql);
        $stmt->execute($params);
        $rows = $stmt->fetchAll();

        // Настройки из панели прикладываем к каждому оповещению: так агенту не нужен
        // отдельный запрос за ними, и настройки реально влияют на показ, а не лежат
        // в базе мёртвым грузом.
        $settings = array();
        foreach (Db::get()->query('SELECT key, value FROM settings') as $row) {
            $settings[$row['key']] = $row['value'];
        }

        $quietNow = self::isQuietHours($settings);

        $result = array();
        foreach ($rows as $row) {
            $important = $row['priority'] === 'important';

            // Тихие часы глушат только неважные — важные проходят всегда, так требует ТЗ.
            if (!$important && $quietNow) {
                continue;
            }

            // Важное — всегда принудительный режим, независимо от настройки.
            // Неважное — по настройке force_mode_default (strict = тоже принудительно).
            $row['force_mode'] = $important ? 'strict' : $settings['force_mode_default'];

            $importantDelay = (int) self::setting($settings, 'close_delay_seconds_important', '0');
            $row['close_delay_seconds'] = $important && $importantDelay > 0
                ? $importantDelay
                : (int) $settings['close_delay_seconds'];

            $row['confirm_close_required'] = self::setting($settings, 'confirm_close_required', '1') === '1';
            $row['accidental_tap_guard_ms'] = (int) self::setting($settings, 'accidental_tap_guard_ms', '600');
            $row['play_sound'] = $important && self::setting($settings, 'sound_on_important', '1') === '1';
            $row['soft_corner'] = self::setting($settings, 'soft_corner', 'bottom-right');
            $row['brand_name'] = $settings['brand_name'];
            $row['brand_contact'] = $settings['brand_contact'];

            $result[] = $row;
        }

        // Не заваливаем кассира десятком окон разом — остальные придут следующим опросом.
        $maxWindows = (int) self::setting($settings, 'max_windows_per_poll', '3');
        if ($maxWindows > 0 && count($result) > $maxWindows) {
            $result = array_slice($result, 0, $maxWindows);
        }

        $rows = $result;

        Logger::debug('GET /occurrences: pc_id=' . $pc['id'] . ' отдано=' . count($rows));

        echo json_encode($rows);
    }

    private static function setting($settings, $key, $default)
    {
        return isset($settings[$key]) && $settings[$key] !== '' ? $settings[$key] : $default;
    }

    // Тихие часы могут переходить через полночь (например, 22:00–08:00) — тогда интервал
    // "снаружи" обычного сравнения, поэтому условие другое.
    //
    // Время сравниваем в часовом поясе магазинов (настройка timezone), а не в UTC, в
    // котором живёт сервер: администратор вводит "с 22:00" имея в виду своё местное
    // время. Без этого перевода тихие часы срабатывали не в то время суток — поймано
    // на тесте, сервер в Docker шёл по UTC при местном времени UTC+3.
    private static function isQuietHours($settings)
    {
        if (self::setting($settings, 'quiet_hours_enabled', '0') !== '1') {
            return false;
        }

        $from = self::setting($settings, 'quiet_hours_from', '22:00');
        $to = self::setting($settings, 'quiet_hours_to', '08:00');

        try {
            $tz = new DateTimeZone(self::setting($settings, 'timezone', 'Europe/Moscow'));
        } catch (Exception $e) {
            Logger::warning('Неизвестный часовой пояс в настройках, использую UTC: ' . $e->getMessage());
            $tz = new DateTimeZone('UTC');
        }

        $now = (new DateTime('now', $tz))->format('H:i');

        return $from <= $to
            ? ($now >= $from && $now < $to)
            : ($now >= $from || $now < $to);
    }
}
