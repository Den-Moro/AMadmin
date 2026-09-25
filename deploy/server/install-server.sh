#!/bin/sh
# Сервер AMadmin на Linux-хосте одним запуском (нужен Docker с compose-плагином).
#   ./deploy/server/install-server.sh [порт] [логин]
set -e
PORT="${1:-8000}"
ADMIN="${2:-admin}"
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$ROOT"

command -v docker >/dev/null 2>&1 || { echo "Нет docker. Установите: https://docs.docker.com/engine/install/"; exit 1; }

echo "== Сборка и запуск (порт $PORT)"
AMADMIN_PORT="$PORT" docker compose --progress quiet up -d --build

echo "== Ожидание сервера"
for i in $(seq 1 60); do
    if curl -fs -H "Accept: text/html" "http://localhost:$PORT/admin/login" >/dev/null 2>&1; then break; fi
    sleep 2
done

COUNT=$(docker compose exec -T server php bin/count-admins.php | tr -d "\r")
if [ "$COUNT" = "0" ]; then
    echo "== Первый суперадмин '$ADMIN'"
    while :; do
        printf "Пароль (не короче 8 символов): "; stty -echo; read -r P1; stty echo; echo
        printf "Ещё раз: "; stty -echo; read -r P2; stty echo; echo
        [ "${#P1}" -ge 8 ] || { echo "Короче 8 символов."; continue; }
        [ "$P1" = "$P2" ] || { echo "Не совпадают."; continue; }
        break
    done
    docker compose exec -T server php bin/create-admin.php "$ADMIN" "$P1" superadmin
else
    echo "Учётки уже есть ($COUNT) — пропускаю."
fi

IP=$(hostname -I 2>/dev/null | awk '{print $1}')
echo
echo "Сервер работает."
echo "  Панель:                http://localhost:$PORT/admin/login"
[ -n "$IP" ] && echo "  Для касс (server_url): http://$IP:$PORT"
echo "  Логин:                 $ADMIN (суперадмин)"
