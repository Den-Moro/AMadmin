<?php
// Печатает число учёток панели. Нужен установщикам (deploy/server/*): по нулю они
// понимают, что это первый запуск и пора создать суперадмина.
require __DIR__ . '/../Core/Config.php';
require __DIR__ . '/../Core/Db.php';

echo (int) Db::get()->query('SELECT COUNT(*) FROM admin_users')->fetchColumn(), PHP_EOL;
