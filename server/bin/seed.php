<?php
// Накатывает тестовые данные (dev-seed.sql): тестовый магазин, касса, оповещение.
// Только для демо и разработки, на проде не нужен.
require __DIR__ . '/../Core/Config.php';
require __DIR__ . '/../Core/Db.php';

Db::get()->exec(file_get_contents(__DIR__ . '/../dev-seed.sql'));
echo "Тестовые данные загружены.\n";
