#!/bin/sh
set -e

# Том с данными монтируется от root, а Apache работает от www-data — отдаём ему
# базу, файлы для раскатки, сессии и логи, иначе первая же запись упадёт.
mkdir -p /app/data /app/logs
chown -R www-data:www-data /app/data /app/logs

# bin/migrate.php сам отслеживает, какие миграции уже применены (таблица
# schema_migrations) — безопасно запускать на каждом старте контейнера, и на пустом
# томе, и на уже существующей БД с новыми миграциями поверх старых. dev-seed.sql сюда
# осознанно не входит — тестовые данные накатываются отдельно (docker compose exec ...).
su -s /bin/sh www-data -c 'php /app/bin/migrate.php'

exec "$@"
