<?php
// Накатывает все ещё не применённые миграции из server/migrations/, в порядке имени
// файла. Безопасно запускать повторно (уже применённые пропускаются) — в отличие от
// прежнего подхода "применять все миграции только если файла БД ещё не было", который
// не подхватывал новые миграции на уже существующей БД (пришлось накатывать 003 руками).
// Запуск: php server/bin/migrate.php

require __DIR__ . '/../src/Config.php';
require __DIR__ . '/../src/Db.php';

$db = Db::get();
$db->exec('CREATE TABLE IF NOT EXISTS schema_migrations (filename TEXT PRIMARY KEY, applied_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP)');

$applied = $db->query('SELECT filename FROM schema_migrations')->fetchAll(PDO::FETCH_COLUMN);

$files = glob(__DIR__ . '/../migrations/*.sql');
sort($files);

$appliedNow = 0;

foreach ($files as $file) {
    $name = basename($file);
    if (in_array($name, $applied, true)) {
        continue;
    }

    echo "Применяю {$name}...\n";
    $db->exec(file_get_contents($file));

    $stmt = $db->prepare('INSERT INTO schema_migrations (filename) VALUES (:name)');
    $stmt->execute(array('name' => $name));

    $appliedNow++;
}

echo $appliedNow > 0 ? "Готово, применено новых миграций: {$appliedNow}.\n" : "Всё уже актуально, новых миграций нет.\n";
