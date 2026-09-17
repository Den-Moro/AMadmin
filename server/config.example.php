<?php
// Скопируйте этот файл в config.php рядом.
// config.php в .gitignore — файл БД (SQLite) не должен попадать в git.

return array(
    'db' => array(
        'path' => __DIR__ . '/data/amadmin.sqlite',
    ),
);
