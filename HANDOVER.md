# AMadmin — передача проекта в новую сессию

Этот файл — стартовая точка. Открывая новую сессию: прочитать его, затем при
необходимости [AGENTS.md](AGENTS.md) (ТЗ) и [README.md](README.md) (статус).
Дата среза: 23.09.2026, последний коммит `a531150`.

## 1. Что это

Клиент-серверная система для парка кассовых ПК розничной сети (цель — 3000+ машин).

- **Сервер**: PHP 8.3 + SQLite + веб-панель. Без фреймворков: свой роутер, сессии,
  миграции. Папка `server/`.
- **Клиент**: два агента на C# / .NET Framework 4.8 (единственный .NET, работающий на
  Windows 7 — жёсткое требование). Папка `client/`.
  - `AMadmin.UiAgent` — окно оповещений в сессии кассира, значок в трее;
  - `AMadmin.ManagementAgent` — служба `AMadminAgent` от SYSTEM, выполняет команды.
- **Раскатка**: скрипты в `deploy/` (сервер, клиент, GPO).

Всё общение — исходящий опрос агентом (`GET /occurrences`, `GET /commands`), входящих
подключений к кассам нет. Авторизация агента — `Authorization: Bearer <agent_token>`,
токен уникален на ПК.

## 2. Где что лежит

```
server/
├── Core/            Config, Db, Settings, Auth (агенты), AdminAuth (панель), Logger, Router, TargetMatcher
├── Modules/<Фича>/  Auth, Dashboard (ПК+статистика), Notifications, Commands, Groups,
│                    Manuals, Meta (справочники), Settings, Logs
├── public/
│   ├── index.php    единственная точка входа: подключения + маршруты
│   ├── .htaccess    DirectorySlash Off + rewrite всего несуществующего в index.php
│   └── admin/       панель: shared/{admin.css,ui.js,nav.js,api.js} + папка на раздел
├── migrations/      001…012, хронологические, накатываются bin/migrate.php
├── bin/             migrate.php, create-admin.php, count-admins.php, seed.php
└── data/, logs/     БД amadmin.sqlite, files/ (раскатка), sessions/; app.log

client/
├── Core/            AgentConfig, ApiClient, Logger
└── Modules/
    ├── Notifications/  AMadmin.UiAgent (WPF-окно, трей, статус)
    └── Management/     AMadmin.ManagementAgent (служба) + Executors/ по типу команды

deploy/
├── server/  install-server.ps1|.cmd (Docker/Native), install-server.sh
└── client/  build-client, install-client, uninstall-client, deploy-clients (+ .cmd),
            gpo/AMadmin-Startup.cmd

Документы: AGENTS.md (ТЗ), README.md (статус), INSTALL.md (установка),
ADMIN.md (эксплуатация), INSTRUCTIONS.md (для кассира). У ADMIN/INSTALL/INSTRUCTIONS
есть .html-версии — они генерируются из .md, править .md и пересобирать.
```

## 3. Готово и проверено

Сервер: миграции, роли (operator / administrator / superadmin), блокировка после
5 неудачных входов, сессии в `data/sessions`.

Панель (тёмная тема по умолчанию, светлая по кнопке):
- **Дашборд** — сводка: парк, активность за сутки, магазины, версии агентов, события,
  «требуют внимания»;
- **Хосты** — фильтры (магазин/тип/группа/статус/версия), сортировка, страницы,
  массовые действия, профиль хоста с историей;
- **Оповещения** (+ подтверждения по кассам, отзыв), **Группы**, **Мануалы**,
- **Команды** — 4 типа: службы, процессы, скрипты, файлы (с хешем и фоновой загрузкой);
- **Справочники**, **Логи** (живой хвост app.log), **Настройки** (3 вкладки; вкладка
  «Сервер» — только superadmin), **Пользователи**.

Клиент: оповещения с защитой от случайного закрытия на сенсорных кассах, команды всех
четырёх типов, ограничение скорости и асинхронная загрузка файлов.

**Сквозной тест на двух чистых Windows 11 в VirtualBox (21.09.2026)**: установка
сервера в режиме Native из архива с GitHub → установка клиента → окно оповещения
на кассе → команда с сервера выполнена на кассе, кириллица в выводе целая.

## 4. Не сделано (осознанный бэклог)

1. **GPO не проверен вживую** — нет домена. Скрипт `deploy/client/gpo/AMadmin-Startup.cmd`
   вызывает тот же `install-client.ps1 -ConfigsDir -OnlyIfChanged`, который отработал на стенде.
2. `deploy-clients.ps1` (массовая раскатка по SMB+WinRM) — только синтаксис.
3. Подпись `.exe` сертификатом — обязательна перед продом (SmartScreen/антивирусы).
4. CSRF-токены на POST панели, 2FA.
5. Самообновление агентов без повторной раскатки.
6. Нагрузочная проверка SQLite на 3000 касс (WAL включён, но не измерено).
7. Повторяющиеся оповещения и «догон» пропущенных.
8. HTTPS: агент проверяет сертификат по-настоящему — самоподписанный не пройдёт,
   нужен корпоративный CA на кассах.

## 5. Как поднять и проверить

```powershell
deploy\server\install-server.cmd                 # Docker (нужен запущенный Docker Desktop)
deploy\server\install-server.cmd -Mode Native    # без Docker; сам поставит PHP
deploy\client\build-client.cmd                   # комплект агентов в dist\client
```

Панель: `http://localhost:8000/admin/login.html` (корень сайта туда же редиректит).
Тестовые учётки локальной Docker-базы: `admin` / `Admin123!` (superadmin),
`operator1` / `Operator123!`. Пароли — только для локального стенда.

Правило проекта: **тестировать сервер в Docker**, не `php -S` на хосте.
Сборка клиента требует .NET SDK 8; на кассах нужен только .NET Framework 4.8.

## 6. Грабли, на которые уже наступили (не повторять)

| Симптом | Причина | Решение в коде |
|---|---|---|
| Все агенты 401 на Apache | mod_php не отдаёт заголовок `Authorization` | `.htaccess` пробрасывает + `Auth::getBearerToken()` читает `getallheaders()` |
| `/admin/stores` отвечает 301 вместо JSON | имя API совпадает с папкой панели | `DirectorySlash Off`, роутер срезает хвостовой `/` |
| `.ps1` «is not digitally signed» | метка «скачано из интернета» на файлах из zip | `.cmd`-обёртки с `-ExecutionPolicy Bypass` + `Unblock-File` |
| `'rshell.exe' is not recognized` | кириллица в `.cmd` после `chcp 65001` | все `.cmd` — только ASCII |
| «PHP установлен, но не найден» | winget пишет PATH в реестр; источник msstore падает | `--source winget`, `Find-Php`, запасной zip с windows.php.net |
| php.ini не найден | winget кладёт в PATH только ссылку | раскрываем ссылку до папки пакета |
| Окно оповещений не стартовало сразу | запуск через explorer из повышенного процесса на Win11 | `schtasks /Run` созданной задачи |
| Команды «всем» валились на давно выключенную кассу | не было срока жизни | `command_ttl_hours` (по умолчанию 24 ч) |
| Кракозябры в выводе скриптов | консоль Windows в OEM-кодировке | читаем stdout/stderr в OEM; `.ps1` — UTF-8 **с BOM**, `.cmd` — OEM/ASCII |

Инструменты: в Bash-инструменте ломаются обратные слэши — пути Windows и JSON писать
через Write или .py-скрипт; `.ps1` сохранять с BOM, иначе PowerShell 5.1 не разберёт
кириллицу.

## 7. Тестовый стенд (если ещё нужен)

VirtualBox: `AM-Server` (192.168.56.102) и `AM-Client`, обе Windows 11 Enterprise
Evaluation, вход `admin` / `Passw0rd!`, панель в ВМ `admin` / `VmAdmin123!`.
Файлы стенда — `E:\ClaudeCode\VMs` (там же ISO 5.4 ГБ и `create-vms.ps1`).
Если стенд не нужен: `VBoxManage unregistervm AM-Server --delete` (и `AM-Client`),
удалить `E:\ClaudeCode\VMs`.

Важно: VirtualBox и Hyper-V конфликтуют. Hyper-V сейчас снят — из-за этого **Docker
Desktop не работает**; для Docker-режима Hyper-V надо вернуть, для ВМ — держать снятым.

## 8. Репозиторий

`github.com/Den-Moro/AMadmin`, ветка `master`. Правило: коммит → сразу `git push`.
