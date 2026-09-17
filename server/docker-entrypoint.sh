#!/bin/sh
set -e

DB_PATH="/app/data/amadmin.sqlite"

# Свежий контейнер/том — накатываем схему сами, чтобы не гонять миграции руками
# при каждом docker compose up. dev-seed.sql сюда осознанно не входит — тестовые
# данные накатываются отдельно (docker compose exec ...), не автоматически.
if [ ! -f "$DB_PATH" ]; then
    echo "amadmin.sqlite не найден — накатываю миграции..."
    for f in /app/migrations/*.sql; do
        echo "  -> $f"
        php -r "(new PDO('sqlite:$DB_PATH'))->exec(file_get_contents('$f'));"
    done
fi

exec "$@"
