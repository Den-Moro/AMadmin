# AMadmin — оповещения и удалённое администрирование для магазинов

Клиент-серверное приложение: сервер (PHP + SQLite) рассылает оповещения на ПК магазинов,
клиент (PowerShell + WPF) их показывает и подтверждает получение (ack). Полное ТЗ — в
[AGENTS.md](AGENTS.md) (там же — обоснование перехода с изначально согласованного MySQL
на SQLite).

## Статус

- [x] Схема БД (`server/migrations/001_init.sql`) — реально накатана и проверена на SQLite
- [x] `GET /occurrences`, `POST /occurrences/{id}/ack` — проверены вручную (curl/Invoke-RestMethod)
- [x] PowerShell-клиент (MVP: опрос, WPF-окно, ack — без трея/мануалов/брендинга)
- [ ] Админ-панель
- [ ] Удалённое администрирование

## Быстрый старт (сервер)

1. Создать БД и накатить схему (нужен PHP с расширением `pdo_sqlite`, БД — обычный файл,
   отдельный сервер БД не нужен):
   ```
   php -r "(new PDO('sqlite:server/data/amadmin.sqlite'))->exec(file_get_contents('server/migrations/001_init.sql'));"
   php -r "(new PDO('sqlite:server/data/amadmin.sqlite'))->exec(file_get_contents('server/dev-seed.sql'));"
   ```
2. Скопировать конфиг (путь к файлу БД уже настроен на `server/data/amadmin.sqlite`):
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

## Быстрый старт (клиент)

1. Скопировать конфиг и указать адрес сервера и токен тестового ПК из `dev-seed.sql`:
   ```
   cp client/config.example.json client/config.json
   ```
2. Запустить (в обычной сессии пользователя, не от имени администратора/SYSTEM):
   ```
   powershell -File client/UiAgent/UiAgent.ps1
   ```

## Структура

- `server/` — PHP API (`public/`, `src/`) + админ-панель (`public/admin/`), данные в
  `server/data/*.sqlite` (не в git)
- `client/` — PowerShell + WPF агент
