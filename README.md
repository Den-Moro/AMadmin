# AMadmin — оповещения и удалённое администрирование для магазинов

Клиент-серверное приложение: сервер (PHP + SQLite) рассылает оповещения на ПК магазинов,
клиент (PowerShell + WPF) их показывает и подтверждает получение (ack). Полное ТЗ — в
[AGENTS.md](AGENTS.md) (там же — обоснование перехода с изначально согласованного MySQL
на SQLite).

## Статус

- [x] Схема БД (`server/migrations/`) — реально накатана и проверена на SQLite
- [x] `GET /occurrences`, `POST /occurrences/{id}/ack` — проверены вручную (curl/Invoke-RestMethod)
- [x] PowerShell-клиент (MVP: опрос, WPF-окно, ack — без трея/мануалов/брендинга)
- [x] Админ-панель (MVP): логин с блокировкой после неудачных попыток, дашборд ПК
  (онлайн/офлайн, поиск, фильтры), создание оповещения с таргетингом (всем/магазину/
  группе/ПК/типу устройства) — проверено вручную в браузере
- [ ] Админ-панель: CRUD-справочники (магазины/группы/типы устройств/мануалы/шаблоны),
  таблица подтверждений по ПК, экспорт статистики, пилотный режим, просмотр логов
- [ ] Удалённое администрирование

## Быстрый старт (сервер)

1. Создать БД и накатить схемы (нужен PHP с расширением `pdo_sqlite`, БД — обычный файл,
   отдельный сервер БД не нужен):
   ```
   php -r "$p=new PDO('sqlite:server/data/amadmin.sqlite'); $p->exec(file_get_contents('server/migrations/001_init.sql')); $p->exec(file_get_contents('server/migrations/002_admin_lockout.sql'));"
   php -r "(new PDO('sqlite:server/data/amadmin.sqlite'))->exec(file_get_contents('server/dev-seed.sql'));"
   ```
2. Скопировать конфиг (путь к файлу БД уже настроен на `server/data/amadmin.sqlite`):
   ```
   cp server/config.example.php server/config.php
   ```
3. Создать логин для админ-панели (публичной регистрации нет и не будет):
   ```
   php server/bin/create-admin.php admin <пароль>
   ```
4. Локальный запуск для разработки (не для прода). Обязательно с `router.php` — без
   него встроенный dev-сервер PHP для путей вида `/admin/login` сам отдаёт
   `admin/index.html` вместо API (на Apache/IIS так не будет, там роль router.php играет
   `.htaccess`):
   ```
   php -S localhost:8000 -t server/public server/public/router.php
   ```
5. Проверка агента (токен из `dev-seed.sql`):
   ```
   curl -H "Authorization: Bearer <agent_token>" http://localhost:8000/occurrences
   ```
6. Админ-панель: `http://localhost:8000/admin/login.html`

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

## Известные ограничения (осознанный бэклог, не забыто)

- Нет CSRF-защиты на POST-запросах админ-панели (сессия + same-origin fetch снижают
  риск, но не убирают его полностью).
- Двухфакторная аутентификация для админ-панели — в бэклоге (см. AGENTS.md).
- Таблица подтверждений по каждому ПК на странице оповещения ещё не сделана — сейчас
  только агрегированные счётчики (показов/подтверждений).
