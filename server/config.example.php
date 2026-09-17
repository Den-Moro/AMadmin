<?php
// Скопируйте этот файл в config.php рядом.
// config.php в .gitignore — файл БД (SQLite) не должен попадать в git.

return array(
    'db' => array(
        'path' => __DIR__ . '/data/amadmin.sqlite',
    ),
    // debug|info|warning|error. Пока приложение в бете — держим debug: понизить до info
    // имеет смысл только после стабилизации на проде, не раньше.
    'log_level' => 'debug',
);
