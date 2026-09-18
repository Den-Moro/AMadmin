# AMadmin — оповещения и удалённое администрирование для магазинов

Клиент-серверное приложение: сервер (PHP + SQLite) рассылает оповещения на ПК магазинов,
клиент (PowerShell + WPF) их показывает и подтверждает получение (ack). Полное ТЗ — в
[AGENTS.md](AGENTS.md) (там же — обоснование перехода с изначально согласованного MySQL
на SQLite). Инструкции для людей, а не для разработки — [ADMIN.md](ADMIN.md) (для
администратора) и [INSTRUCTIONS.md](INSTRUCTIONS.md) (для сотрудника магазина), у обеих
есть готовые HTML-версии рядом.

## Статус

- [x] Схема БД (`server/migrations/`) — реально накатана и проверена на SQLite,
  накатывается идемпотентно через `server/bin/migrate.php` (таблица `schema_migrations`)
- [x] `GET /occurrences`, `POST /occurrences/{id}/ack` — проверены вручную
- [x] PowerShell UI-агент (MVP: опрос, WPF-окно, ack — без трея/мануалов/брендинга)
- [x] Админ-панель: логин с блокировкой после неудачных попыток, дашборд ПК
  (онлайн/офлайн, поиск, фильтры), создание оповещения с таргетингом (всем/магазину/
  группе/ПК/типу устройства), библиотека мануалов, группы хостов (CRUD + участники) —
  всё проверено в браузере
- [x] Уровни логирования (Debug/Info/Warning/Error, настраиваемый минимальный уровень,
  по умолчанию Debug — см. `log_level` в конфигах) — касается сервера и клиента
- [x] Docker-сетап для тестирования (`docker-compose.yml`, `server/Dockerfile`)
- [x] Удалённое администрирование — первая функция (управление службами): агент
  управления (`client/ManagementAgent`, отдельный процесс от UI-агента), протокол
  `GET /commands` → `claim` → `result` с идемпотентностью, блок-лист защищённых служб
  (проверяется и на сервере при создании команды, и в самом агенте перед выполнением —
  список провизорный, см. `AdminCommandsController.php`), страница `commands.html` со
  сводкой и подтверждением "на N хостов" — проверено на живой службе (Spooler)
- [ ] Удалённое администрирование — диспетчер задач, файлы с хешем, запуск скриптов (по
  очереди, см. AGENTS.md)
- [ ] Повторяющиеся оповещения (генерация occurrence по расписанию) и догон пропущенных
- [ ] CRUD для магазинов/типов устройств, экспорт статистики, история по ПК, пилотный
  режим в UI, шаблоны сообщений, просмотр логов из панели
- [ ] Саморегистрация ПК (сейчас `agent_token` создаётся вручную), сборка `.exe`, массовая
  раскатка клиента

Подробный список ограничений — в [ADMIN.md](ADMIN.md#5-известные-ограничения-осознанный-бэклог).

## Быстрый старт (сервер, через Docker — так тестируется в этом проекте)

```bash
docker compose up -d --build
docker compose exec server php -r "(new PDO('sqlite:/app/data/amadmin.sqlite'))->exec(file_get_contents('/app/dev-seed.sql'));"
docker compose exec server php bin/create-admin.php admin <пароль>
```

Сервер: `http://localhost:8000`, админ-панель: `http://localhost:8000/admin/login.html`.
Миграции накатываются автоматически при каждом старте контейнера (`bin/migrate.php`,
безопасно и на пустом томе, и на уже существующей БД — не применяет уже применённые
повторно).

### Без Docker (тоже работает, но в проекте тестируется через Docker)

1. `cp server/config.example.php server/config.php`
2. Накатить миграции и сидировать тестовые данные (нужен PHP с `pdo_sqlite`):
   ```
   php server/bin/migrate.php
   php -r "(new PDO('sqlite:server/data/amadmin.sqlite'))->exec(file_get_contents('server/dev-seed.sql'));"
   ```
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
2. UI-агент — оповещения, в обычной сессии пользователя (не администратора/SYSTEM):
   ```
   powershell -File client/UiAgent/UiAgent.ps1
   ```
3. Агент управления — команды, требует прав администратора/SYSTEM (без них любая команда
   на реальное изменение состояния службы корректно завершится `failed`, это не баг):
   ```
   powershell -File client/ManagementAgent/ManagementAgent.ps1
   ```

## Структура

- `server/` — PHP API (`public/`, `src/`) + админ-панель (`public/admin/`), данные в
  `server/data/*.sqlite` (не в git)
- `client/` — `UiAgent/` (оповещения, сессия пользователя) и `ManagementAgent/` (команды,
  SYSTEM), общий код в `Common/`
- `docker-compose.yml`, `server/Dockerfile` — тестовое окружение (не деплой — тот
  ручной, на Windows-хосте, см. AGENTS.md)

## Логи

- Сервер: `server/logs/app.log` (в Docker — `docker compose exec server tail -f logs/app.log`)
- Клиент: `client/ui-agent.log` (UI-агент), `client/management-agent.log` (агент
  управления) — раздельные файлы, у каждого процесса свой
- Минимальный уровень — `log_level` в `config.php`/`config.json`
  (`debug`/`info`/`warning`/`error`), по умолчанию `debug`, пока приложение в бете.
