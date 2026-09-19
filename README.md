# AMadmin — оповещения и удалённое администрирование для магазинов

Клиент-серверное приложение для парка кассовых ПК (цель — 3000+ машин). Сервер (PHP +
SQLite) с веб-панелью; на каждой кассе два маленьких агента на C# (.NET Framework 4.8 —
единственный .NET, работающий на Windows 7): один показывает оповещения кассиру, второй
выполняет команды администратора (службы, процессы, скрипты, файлы). Полное ТЗ — в
[AGENTS.md](AGENTS.md). Инструкции для людей: [INSTALL.md](INSTALL.md) (установка в один
запуск), [ADMIN.md](ADMIN.md) (администратору) и [INSTRUCTIONS.md](INSTRUCTIONS.md)
(сотруднику магазина); у всех есть готовые HTML-версии рядом.

## Статус

- [x] Сервер: схема БД на SQLite, миграции накатываются идемпотентно (`bin/migrate.php`),
  логирование с уровнями (по умолчанию `debug`, пока бета), Docker-сборка для тестов
- [x] Оповещения: `GET /occurrences` → окно на кассе → `ack`; таргетинг всем/магазину/
  группе/типу устройства/ПК; тихие часы в часовом поясе магазина; мануалы
- [x] Админ-панель (своя визуальная система, без CSS-фреймворков): логин с блокировкой
  после неудачных попыток, роли (operator/administrator/superadmin), управление
  учётками из панели, дашборд ПК, оповещения, группы, мануалы, команды, настройки —
  у каждого поля подсказка
- [x] Заведение ПК из панели: по одному или списком сразу на весь магазин, готовый
  `config.json` с ключом для каждого, выгрузка всех конфигов одним архивом
- [x] Настройки поведения касс из панели (принудительный режим, защита от случайного
  касания на сенсорных кассах, тихие часы, брендинг) — кассы подхватывают при следующем опросе
- [x] UI-агент на C#/WPF: принудительное окно поверх всего, защита от случайного тапа,
  подтверждение закрытия в два шага, иконка в трее со статусом соединения
- [x] Удалённое администрирование — все четыре стандартных типа команд, с сервера до
  исполнения на кассе:
  службы (запуск/остановка/перезапуск/список), процессы (завершить/список), скрипты
  (PowerShell/CMD, текст или путь, таймаут), файлы (загрузка на сервер, доставка со
  сравнением по SHA-256, резервная копия старого файла, ограничение скорости скачивания)
- [x] Агент управления на C# — настоящая служба Windows (`AMadminAgent`), с защитой от
  повторного выполнения команды после сбоя и защищёнными списками служб/процессов
- [x] Развёртывание в один запуск: `deploy/server/install-server.ps1` (Docker: Apache +
  PHP, или без Docker), `deploy/client/build-client.ps1` → `install-client.ps1` /
  `deploy-clients.ps1` (массово по SMB + WinRM/schtasks)
- [x] Справочники (магазины, типы устройств), редактирование/удаление ПК и перевыпуск
  ключа, отзыв оповещений и подтверждения по кассам, настройки сервера из панели
- [ ] Самообновление агентов без повторной раскатки
- [ ] Просмотр серверного лога прямо из панели
- [ ] Повторяющиеся оповещения и догон пропущенных
- [ ] Нагрузочная проверка SQLite на 3000+ опрашивающих касс
- [ ] CRUD магазинов/типов устройств, история по ПК, экспорт статистики, 2FA, CSRF

Подробнее об ограничениях — в [ADMIN.md](ADMIN.md#7-известные-ограничения-осознанный-бэклог).

## Требования к развёртыванию (кратко — подробности в ADMIN.md)

**Сервер:** либо Docker (Docker Desktop/Engine — и больше ничего), либо PHP 8.x с
расширениями `pdo_sqlite` и `zip` + веб-сервер (Apache с `mod_rewrite` или IIS) для прода;
встроенный `php -S` — только для разработки. Отдельная СУБД не нужна (SQLite — файл).
Для раскатки файлов поднять `upload_max_filesize`/`post_max_size` в `php.ini`.

**Клиент:** Windows 7 или новее, .NET Framework 4.8 (на Windows 10/11 уже есть; на
Windows 7 ставится через Windows Update или отдельным установщиком Microsoft), сетевой
доступ до сервера по HTTP/HTTPS (через прокси — поддерживается). UI-агент — в сессии
пользователя; агент управления — служба от SYSTEM.

## Быстрый старт

Один запуск на всё — см. [INSTALL.md](INSTALL.md). Коротко:

```powershell
.\deploy\server\install-server.ps1          # сервер (Docker: Apache + PHP 8.3), спросит пароль admin
.\deploy\client\build-client.ps1            # комплект агентов в dist\client
.\deploy\client\deploy-clients.ps1 -ConfigsDir <архив конфигов из панели>   # на все кассы
```

Вручную то же самое: `docker compose up -d --build`, затем
`docker compose exec server php bin/create-admin.php admin <пароль> superadmin`
(`php bin/seed.php` — тестовые данные). Панель: `http://localhost:8000/admin/login.html`.

### Без Docker

1. `cp server/config.example.php server/config.php`
2. `php server/bin/migrate.php` (нужен PHP с `pdo_sqlite`; для выгрузки конфигов
   архивом и файлов для раскатки — ещё и `zip`)
3. `php server/bin/create-admin.php admin <пароль> [operator|administrator|superadmin]`
4. Для разработки: `php -S localhost:8000 -t server/public server/public/router.php`
   (`router.php` обязателен — без него встроенный сервер отдаёт `admin/index.html` вместо
   API; на Apache/IIS его роль играет `.htaccess`/правила перезаписи).

## Клиент вручную (без скриптов)

Нужен .NET SDK 8 только для сборки; на кассах — .NET Framework 4.8.

```bash
cd client
dotnet build Modules/Notifications/AMadmin.UiAgent.csproj -c Release
dotnet build Modules/Management/AMadmin.ManagementAgent.csproj -c Release
```

`config.json` из панели — рядом с `.exe` (один на ПК, каждое поле подписано).
`AMadmin.ManagementAgent.exe --install` (администратор) ставит службу; `--console` —
отладка в окне. `AMadmin.UiAgent.exe` — в сессии пользователя.

## Структура

Оба проекта разложены одинаково по смыслу: `Core/` — общая инфраструктура, `Modules/<Фича>/`
— всё остальное, по функциональности, а не по техническому слою:

```
server/
├── Core/              (Db, Auth, AdminAuth, Logger, Router, TargetMatcher)
├── Modules/
│   ├── Notifications/  (оповещения: agent-facing occurrences/ack + admin CRUD)
│   ├── Commands/       (команды, файлы для раскатки: agent-facing + admin)
│   ├── Dashboard/      (ПК: список, создание, массовое создание, выгрузка конфигов)
│   ├── Settings/, Groups/, Manuals/, Auth/, Meta/
├── public/admin/       (веб-панель: html/js по одной папке на модуль)
└── migrations/, bin/, data/ (БД + files/), logs/

client/
├── Core/               (AgentConfig, ApiClient, Logger — общее для обоих агентов)
├── Modules/
│   ├── Notifications/   (AMadmin.UiAgent: WPF-окно оповещения, трей, статус)
│   └── Management/      (AMadmin.ManagementAgent: служба Windows + Executors/ по типу команды)
└── config.example.json  (с комментариями к каждому полю)

deploy/
├── server/   (install-server.ps1 / .sh — сервер одним запуском)
└── client/   (build-client.ps1, install-client.ps1, deploy-clients.ps1, uninstall-client.ps1)
```

`server/migrations/` намеренно НЕ разложены по модулям — история схемы БД единая
хронологическая лента.

## Логи

- Сервер: `server/logs/app.log` (в Docker — `docker compose exec server tail -f logs/app.log`)
- Клиент: `ui-agent.log` и `management-agent.log` рядом с `.exe` — у каждого процесса свой,
  с ротацией по размеру
- Минимальный уровень — `log_level` в `config.php`/`config.json`
  (`debug`/`info`/`warning`/`error`), по умолчанию `debug`, пока приложение в бете.
