# AMadmin — оповещения и удалённое администрирование для магазинов

Клиент-серверное приложение: сервер (PHP + SQLite) рассылает оповещения на ПК магазинов,
клиент (PowerShell + WPF) их показывает и подтверждает получение (ack). Полное ТЗ — в
[AGENTS.md](AGENTS.md) (там же — обоснование перехода с изначально согласованного MySQL
на SQLite). Инструкции для людей, а не для разработки — [ADMIN.md](ADMIN.md) (для
администратора) и [INSTRUCTIONS.md](INSTRUCTIONS.md) (для сотрудника магазина), у обеих
есть готовые HTML-версии рядом.

## Статус

- [x] Схема БД (`server/migrations/`) — реально накатана и проверена на SQLite
- [x] `GET /occurrences`, `POST /occurrences/{id}/ack` — проверены вручную
- [x] PowerShell-клиент (MVP: опрос, WPF-окно, ack — без трея/мануалов/брендинга)
- [x] Админ-панель: логин с блокировкой после неудачных попыток, дашборд ПК
  (онлайн/офлайн, поиск, фильтры), создание оповещения с таргетингом (всем/магазину/
  группе/ПК/типу устройства), библиотека мануалов, группы хостов (CRUD + участники) —
  всё проверено в браузере
- [x] Уровни логирования (Debug/Info/Warning/Error, настраиваемый минимальный уровень,
  по умолчанию Debug — см. `log_level` в конфигах) — касается сервера и клиента
- [x] Docker-сетап для тестирования (`docker-compose.yml`, `server/Dockerfile`)
- [ ] Повторяющиеся оповещения (генерация occurrence по расписанию) и догон пропущенных
- [ ] CRUD для магазинов/типов устройств, экспорт статистики, история по ПК, пилотный
  режим в UI, шаблоны сообщений, просмотр логов из панели
- [ ] Саморегистрация ПК (сейчас `agent_token` создаётся вручную), сборка `.exe`, массовая
  раскатка клиента
- [ ] Удалённое администрирование (весь раздел, отдельным этапом)

Подробный список ограничений — в [ADMIN.md](ADMIN.md#5-известные-ограничения-осознанный-бэклог).

## Быстрый старт (сервер, через Docker — так тестируется в этом проекте)

```bash
docker compose up -d --build
docker compose exec server php -r "(new PDO('sqlite:/app/data/amadmin.sqlite'))->exec(file_get_contents('/app/dev-seed.sql'));"
docker compose exec server php bin/create-admin.php admin <пароль>
```

Сервер: `http://localhost:8000`, админ-панель: `http://localhost:8000/admin/login.html`.
Миграции из `server/migrations/` накатываются автоматически при первом старте на чистом
томе (см. `server/docker-entrypoint.sh`).

### Без Docker (тоже работает, но в проекте тестируется через Docker)

1. Накатить схемы и сидировать тестовые данные (нужен PHP с `pdo_sqlite`):
   ```
   php -r "$p=new PDO('sqlite:server/data/amadmin.sqlite'); $p->exec(file_get_contents('server/migrations/001_init.sql')); $p->exec(file_get_contents('server/migrations/002_admin_lockout.sql'));"
   php -r "(new PDO('sqlite:server/data/amadmin.sqlite'))->exec(file_get_contents('server/dev-seed.sql'));"
   ```
2. `cp server/config.example.php server/config.php`
3. `php server/bin/create-admin.php admin <пароль>`
4. Запуск обязательно с `router.php` — без него встроенный dev-сервер PHP для путей вида
   `/admin/login` сам отдаёт `admin/index.html` вместо API (на Apache/IIS так не будет,
   там роль `router.php` играет `.htaccess`):
   ```
   php -S localhost:8000 -t server/public server/public/router.php
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
- `docker-compose.yml`, `server/Dockerfile` — тестовое окружение (не деплой — тот
  ручной, на Windows-хосте, см. AGENTS.md)

## Логи

- Сервер: `server/logs/app.log` (в Docker — `docker compose exec server tail -f logs/app.log`)
- Клиент: `client/ui-agent.log`
- Минимальный уровень — `log_level` в `config.php`/`config.json`
  (`debug`/`info`/`warning`/`error`), по умолчанию `debug`, пока приложение в бете.
