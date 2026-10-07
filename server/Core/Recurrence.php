<?php

// Повторяющиеся оповещения (ТЗ: «напоминания вроде плановой сверки или регламентных
// работ») — см. миграцию 028.
//
// Правило — JSON в notifications.repeat_rule:
//   { "every": "day",      "time": "09:00" }            каждый день
//   { "every": "weekdays", "time": "09:00" }            по будням (пн–пт)
//   { "every": "week",     "time": "09:00", "days": [1, 4] }   по дням недели (1 — пн … 7 — вс)
//   { "every": "hours",    "hours": 4 }                 каждые N часов от первого показа
// Время — в часовом поясе магазинов (настройка timezone), как и тихие часы.
//
// Каждый повтор — отдельный показ (notification_occurrences) со своими подтверждениями.
// Очередной показ создаёт фоновая задача (Housekeeping) в течение минуты после его
// времени. Если сервер был выключен, создаётся только последний пропущенный показ — а
// касса и так получает лишь последний наступивший показ оповещения
// (OccurrencesController), так что «вчерашнее» напоминание не придёт вдогонку.
class Recurrence
{
    const EVERY = array('day', 'weekdays', 'week', 'hours');

    // array('rule' => …, 'recurrence' => daily|weekly|custom, 'interval_minutes' => int|null)
    // или array('error' => код).
    public static function validate($rule)
    {
        if (!is_array($rule) || !isset($rule['every']) || !in_array($rule['every'], self::EVERY, true)) {
            return array('error' => 'invalid_repeat');
        }
        $every = $rule['every'];
        if ($every === 'hours') {
            $hours = isset($rule['hours']) ? (int) $rule['hours'] : 0;
            if ($hours < 1 || $hours > 168) {
                return array('error' => 'invalid_repeat_hours');
            }
            return array('rule' => array('every' => 'hours', 'hours' => $hours), 'recurrence' => 'custom', 'interval_minutes' => $hours * 60);
        }

        $time = isset($rule['time']) ? (string) $rule['time'] : '';
        if (!preg_match('/^([01]\d|2[0-3]):[0-5]\d$/', $time)) {
            return array('error' => 'invalid_repeat_time');
        }
        $out = array('every' => $every, 'time' => $time);
        if ($every === 'week') {
            $days = array();
            foreach (isset($rule['days']) && is_array($rule['days']) ? $rule['days'] : array() as $d) {
                $d = (int) $d;
                if ($d >= 1 && $d <= 7) {
                    $days[$d] = $d;
                }
            }
            if (!$days) {
                return array('error' => 'invalid_repeat_days');
            }
            sort($days);
            $out['days'] = array_values($days);
        }
        return array('rule' => $out, 'recurrence' => $every === 'week' ? 'weekly' : 'daily', 'interval_minutes' => null);
    }

    private static function tz()
    {
        try {
            return new DateTimeZone((string) Settings::get('timezone', 'Europe/Moscow'));
        } catch (Exception $e) {
            return new DateTimeZone('UTC');
        }
    }

    // Ближайший показ строго позже $afterUtc ('Y-m-d H:i:s', UTC). null — правило битое.
    public static function next(array $rule, $afterUtc)
    {
        $utc = new DateTimeZone('UTC');
        $after = new DateTime($afterUtc, $utc);
        if ($rule['every'] === 'hours') {
            $after->modify('+' . (int) $rule['hours'] . ' hours');
            return $after->format('Y-m-d H:i:s');
        }

        list($hh, $mm) = array_map('intval', explode(':', $rule['time']));
        $local = clone $after;
        $local->setTimezone(self::tz());
        for ($i = 0; $i <= 8; $i++) {
            $candidate = clone $local;
            $candidate->modify('+' . $i . ' day');
            $candidate->setTime($hh, $mm, 0);
            if ($candidate <= $after) {
                continue;
            }
            $dow = (int) $candidate->format('N');
            if ($rule['every'] === 'weekdays' && $dow > 5) {
                continue;
            }
            if ($rule['every'] === 'week' && !in_array($dow, $rule['days'], true)) {
                continue;
            }
            $candidate->setTimezone($utc);
            return $candidate->format('Y-m-d H:i:s');
        }
        return null;
    }

    // Первый показ не раньше $startUtc: «каждые N часов» — сразу в $startUtc, остальные —
    // в ближайшее подходящее время (например, «каждый день в 09:00», созданное в 14:00, —
    // завтра в 09:00).
    public static function first(array $rule, $startUtc)
    {
        if ($rule['every'] === 'hours') {
            return $startUtc;
        }
        $d = new DateTime($startUtc, new DateTimeZone('UTC'));
        $d->modify('-1 second');
        return self::next($rule, $d->format('Y-m-d H:i:s'));
    }

    // Фоновая задача: создать наступившие показы повторяющихся оповещений.
    public static function generateDue()
    {
        $db = Db::get();
        $now = gmdate('Y-m-d H:i:s');
        $rows = $db->query("
            SELECT n.id, n.repeat_rule, n.repeat_until,
                   (SELECT MAX(o.fire_at) FROM notification_occurrences o WHERE o.notification_id = n.id) AS last_fire
            FROM notifications n
            WHERE n.recurrence <> 'once' AND n.repeat_rule IS NOT NULL AND n.repeat_stopped_at IS NULL
        ")->fetchAll();

        $insert = $db->prepare('INSERT INTO notification_occurrences (notification_id, fire_at) VALUES (:id, :fire_at)');
        $created = 0;
        foreach ($rows as $n) {
            $rule = json_decode((string) $n['repeat_rule'], true);
            if (!is_array($rule) || $n['last_fire'] === null || $n['last_fire'] > $now) {
                continue; // первый показ ещё впереди
            }
            // Последний подходящий момент между прошлым показом и «сейчас».
            $slot = null;
            $cursor = $n['last_fire'];
            for ($i = 0; $i < 5000; $i++) {
                $next = self::next($rule, $cursor);
                if ($next === null || $next > $now || ($n['repeat_until'] && $next > $n['repeat_until'])) {
                    break;
                }
                $slot = $next;
                $cursor = $next;
            }
            if ($slot !== null) {
                $insert->execute(array('id' => $n['id'], 'fire_at' => $slot));
                $created++;
                Logger::info("Повторяющееся оповещение id={$n['id']}: новый показ {$slot} UTC");
            }
        }
        return $created;
    }

    // Когда будет следующий показ (для истории в панели). null — повторы закончились.
    public static function upcoming(array $row)
    {
        if ($row['repeat_stopped_at'] || !$row['repeat_rule']) {
            return null;
        }
        $rule = json_decode((string) $row['repeat_rule'], true);
        if (!is_array($rule)) {
            return null;
        }
        $now = gmdate('Y-m-d H:i:s');
        $last = $row['last_fire'];
        if ($last !== null && $last > $now) {
            return $last; // запланированный первый показ
        }
        // От прошлого показа шагаем вперёд, пока не окажемся в будущем: у «каждые N
        // часов» сетка привязана к первому показу, а не к текущему моменту.
        $next = $cursor = $last !== null ? $last : $now;
        for ($i = 0; $i < 5000 && $next !== null && $next <= $now; $i++) {
            $next = self::next($rule, $cursor);
            $cursor = $next;
        }
        if ($next === null || $next <= $now || ($row['repeat_until'] && $next > $row['repeat_until'])) {
            return null;
        }
        return $next;
    }
}
