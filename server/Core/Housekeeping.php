<?php

// Фоновые задачи без планировщика: отдельного cron/службы на сервере нет, поэтому раз в
// минуту задачу выполняет первый пришедший запрос — агенты опрашивают сервер каждые
// 30 секунд, так что «первый запрос» случается постоянно. Пока срок не подошёл, это один
// лёгкий SELECT. Две параллельные копии одну задачу не выполнят: право на запуск
// получает тот, чей UPDATE сработал (атомарно в SQLite).
//
// Задачи (таблица housekeeping, миграция 028):
//   smart_groups — пересчитать состав смарт-групп (SmartGroups::refresh);
//   recurrence   — создать наступившие показы повторяющихся оповещений (Recurrence).
class Housekeeping
{
    const INTERVAL_SECONDS = 60;

    public static function tick()
    {
        try {
            $db = Db::get();
            $jobs = $db->query('SELECT job, last_run FROM housekeeping')->fetchAll(PDO::FETCH_KEY_PAIR);
        } catch (Exception $e) {
            return; // база ещё без миграции 028 — нечего делать
        }

        $threshold = gmdate('Y-m-d H:i:s', time() - self::INTERVAL_SECONDS);
        foreach ($jobs as $job => $lastRun) {
            if ($lastRun > $threshold) {
                continue;
            }
            try {
                $claim = $db->prepare('UPDATE housekeeping SET last_run = :now WHERE job = :job AND last_run <= :threshold');
                $claim->execute(array('now' => gmdate('Y-m-d H:i:s'), 'job' => $job, 'threshold' => $threshold));
                if ($claim->rowCount() !== 1) {
                    continue; // успел другой запрос
                }
                self::run($job);
            } catch (Exception $e) {
                // Фоновая задача никогда не роняет сам запрос (кассе или панели).
                Logger::error("Фоновая задача {$job}: " . $e->getMessage());
            }
        }
    }

    public static function run($job)
    {
        switch ($job) {
            case 'smart_groups':
                return SmartGroups::refresh();
            case 'recurrence':
                return Recurrence::generateDue();
        }
        return null;
    }
}
