# AMadmin — оповещения и удалённое администрирование для магазинов

Клиент-серверное приложение: сервер (PHP + MySQL) рассылает оповещения на ПК магазинов,
клиент (PowerShell + WPF) их показывает и подтверждает получение (ack). Полное ТЗ — в
[AGENTS.md](AGENTS.md).

## Статус

- [x] Схема БД (`server/migrations/001_init.sql`)
- [x] `GET /occurrences`, `POST /occurrences/{id}/ack`
- [ ] PowerShell-клиент
- [ ] Админ-панель
- [ ] Удалённое администрирование

## Быстрый старт (сервер)

1. Создать БД и накатить схему:
   ```
   mysql -u root -p amadmin < server/migrations/001_init.sql
   mysql -u root -p amadmin < server/dev-seed.sql   # тестовые данные, необязательно
   ```
2. Скопировать конфиг и вписать реальные креды БД:
   ```
   cp server/config.example.php server/config.php
   ```
3. Локальный запуск для разработки (не для прода):
   ```
   php -S localhost:8000 -t server/public
   ```
4. Проверка (токен из `dev-seed.sql`):
   ```
   curl -H "Authorization: Bearer <agent_token>" http://localhost:8000/occurrences
   ```

## Структура

- `server/` — PHP API (`public/`, `src/`) + админ-панель (`public/admin/`)
- `client/` — PowerShell + WPF агент
