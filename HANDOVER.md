# AMadmin — передача проекта в новую сессию

Этот файл — стартовая точка. Открывая новую сессию: прочитать его, затем при
необходимости [AGENTS.md](AGENTS.md) (ТЗ) и [README.md](README.md) (статус).
Дата среза: 24.09.2026, последний коммит `ada93fb`.

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
├── docker/          nginx.conf (Docker-образ: nginx + PHP-FPM, см. Dockerfile)
└── data/, logs/     БД amadmin.sqlite, files/ (раскатка), sessions/; app.log

client/
├── Core/            AgentConfig (Load/Save/Parse/Validate), ApiClient, Logger
└── Modules/
    ├── Notifications/  AMadmin.UiAgent (WPF: StatusWindow, SettingsWindow, трей)
    └── Management/     AMadmin.ManagementAgent (служба) + Executors/ по типу команды

deploy/
├── server/  install-server.ps1|.cmd (Docker/Native), install-server.sh
└── client/  build-client, install-client, uninstall-client, deploy-clients (+ .cmd),
            gpo/AMadmin-Startup.cmd

docs/
├── INSTALL.md(.html)       установка
├── ADMIN.md(.html)         эксплуатация
└── INSTRUCTIONS.md(.html)  для кассира

Документы: AGENTS.md (ТЗ, корень), README.md (статус, корень), docs/INSTALL.md,
docs/ADMIN.md, docs/INSTRUCTIONS.md. У ADMIN/INSTALL/INSTRUCTIONS есть .html-версии —
это не автогенерация (генератора в репозитории нет), править оба файла руками.
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
четырёх типов, ограничение скорости и асинхронная загрузка файлов, окно «Настройки» в
трее (путь установки, правка config.json, импорт конфига файлом) — UiAgent применяет
изменения сразу, ManagementAgent (служба) требует перезапуска администратором.

Docker-образ сервера — nginx + PHP-FPM (был Apache): `server/docker/nginx.conf`
воспроизводит логику `.htaccess` (DirectorySlash-стиль роутинга) и добавляет
`fastcgi_param HTTP_AUTHORIZATION`, который PHP-FPM (в отличие от старого mod_php)
не пробрасывает сам.

**Сквозной тест (24.09.2026)**:
- Docker: сборка, вход, `/admin/stores` без токена → 401 (не редирект), заголовок
  Authorization доходит до PHP через fastcgi, `router.php`/чужие `.php` отдают 403.
- Native на хосте (порт 8001, не мешает Docker на 8000): чистая установка → все
  12 миграций → суперадмин → задача планировщика → панель и Дашборд работают.
- Windows 10 Pro (стенд `AM10-Server`/`AM10-Client`, см. §7): установка сервера в
  режиме Native из архива с GitHub → установка клиента → оба агента на связи с
  сервером по сети → команда с панели дошла и выполнилась на кассе, кириллица в
  выводе целая → задача `AMadmin Server` сама поднялась после перезагрузки сервера
  (Windows Update).

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

Панель: `http://localhost:8000/admin/login` (корень сайта туда же редиректит; старые `/admin/*.html`-ссылки 301 на чистые пути).
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
| Native-установка: «Сервер не ответил», задачи `AMadmin Server` нет | путь проекта с пробелом (`Downloads\AMadmin-master (1)\...`) ломает разбор `schtasks /TR "..." "..."`, код возврата не проверялся | `install-server.ps1` регистрирует задачу через `Register-ScheduledTask`/`New-ScheduledTaskAction` (программа и аргументы раздельно, без ручной сборки строки) |
| Native-установка «успешна», но панель не работает | `bin/migrate.php` падал (БД от старой схемы без новых миграций) молча — вывод и код возврата не проверялись | `install-server.ps1` печатает вывод migrate.php/seed.php/create-admin.php и останавливается на ненулевом коде возврата |

Инструменты: в Bash-инструменте ломаются обратные слэши — пути Windows и JSON писать
через Write или .py-скрипт; `.ps1` сохранять с BOM, иначе PowerShell 5.1 не разберёт
кириллицу.

## 7. Тестовый стенд (если ещё нужен)

VirtualBox, пара `AM10-Server` (192.168.56.103) / `AM10-Client`, обе Windows 10 Pro
22H2 (Windows 11/10 Enterprise Evaluation ISO у Microsoft больше не скачать —
Windows 10 вне поддержки с осени 2025, поэтому образ взят из собственного архива
`D:\All_Application\...\Win_10\Win10_22H2_Russian_x64v1.iso`). Вход `admin` /
`Passw0rd!`. Панель на сервере: `admin` / `Win10Test123!`. Файлы стенда —
`E:\ClaudeCode\VMs` (`create-vms.ps1` — теперь параметризован: `-Prefix`, `-OsType`,
`-Firmware bios|efi`, `-ImageIndex`, `-ProductKey`). Прежняя пара `AM-Server`/`AM-Client`
(Win11) была снесена в процессе диагностики зависшего Windows Update — не восстанавливал,
раз всё равно нужен был новый Win10-стенд.

**Грабли конкретно этого стенда** (не про сам продукт — про VirtualBox/среду):
- Windows 10 ISO с несколькими SKU в одном install.wim виснет в unattended-установке
  на диалоге «Не удаётся прочитать параметр ProductKey», если не передать
  `--key=<generic KMS client key>` — `create-vms.ps1` поддерживает `-ProductKey`.
- EFI-прошивка (`--firmware efi`, по умолчанию у скрипта — годится для Win11)
  на этом ISO виснет на «No bootable option or device was found» — для Windows 10
  используйте `-Firmware bios` (Windows 10 не требует UEFI/TPM).
- Через NAT этой VirtualBox у крупных файлов (PHP zip с windows.php.net, VC++
  Redistributable с aka.ms) скачивание зависает на 0 байт и не таймаутится — GitHub
  при этом работает нормально. Обходной путь: скачать/взять из кэша на хосте и
  `guestcontrol copyto` внутрь гостя (PHP — из `%LOCALAPPDATA%\Microsoft\WinGet\Packages`,
  VC++ — из `C:\ProgramData\Package Cache\...\VC_redist.x64.exe`), либо один раз
  установить VC++ руками — тогда `install-server.ps1` увидит ключ реестра и не будет
  скачивать сам.
- `VBoxManage guestcontrol run` даёт **отфильтрованный** (не-admin) токен даже для
  локального администратора — `Start-Process -Verb RunAs` внутри такой сессии
  показывает настоящий UAC-диалог на Secure Desktop, который `screenshotpng` не
  рисует (выглядит как обычный рабочий стол), но клавиатурный ввод туда всё равно
  доходит: `VBoxManage controlvm <vm> keyboardputscancode 38 15 95 b8` (Alt+Y) его
  принимает. Так же можно поднять/перезапустить службы, реестр HKLM и т.п. изнутри —
  без этого трюка Native-режим и install-client.cmd на этом стенде не запустить.
- После нескольких `poweroff`/`reset` гостевой exec-сервис VBoxService иногда виснет
  («guest execution service is not ready») даже при полностью загруженном рабочем
  столе — лечится мягким `VBoxManage controlvm <vm> reset` (не `poweroff` —
  принудительное выключение посреди установки один раз спровоцировало долгий
  «ремонт после грязного выключения» при следующей загрузке).
- Windows 10 сама применяет накопленные обновления и перезагружается без
  предупреждения — если сервер вдруг перестал отвечать, сначала проверьте
  скриншотом «Подготовка Windows», а не считайте стенд сломанным.

Важно: VirtualBox и Hyper-V конфликтуют. Hyper-V сейчас снят — из-за этого **Docker
Desktop не работает**; для Docker-режима Hyper-V надо вернуть, для ВМ — держать снятым.
(Docker тем не менее оказался доступен в начале этой сессии — см. дату/окружение
при следующей проверке, могло измениться.)

## 8. Репозиторий

`github.com/Den-Moro/AMadmin`, ветка `master`. Правило: коммит → сразу `git push`.
