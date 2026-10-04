(async function () {
    const me = await requireAdminAuth();
    const canEdit = me.role === 'administrator' || me.role === 'superadmin';
    const $ = Ui.$, esc = Ui.escapeHtml;

    $('newBtn').innerHTML = Ui.icon('plus') + 'Новая команда';
    $('closeNewBtn').innerHTML = Ui.icon('x');
    $('searchIcon').outerHTML = Ui.icon('search');
    $('refreshBtn').innerHTML = Ui.icon('refresh') + 'Обновить';

    if (canEdit) {
        $('adminActions').hidden = false;
        document.querySelectorAll('[data-admin]').forEach(function (el) { el.hidden = false; });
        Ui.settingsFieldsPanel({
            protected_services: 'text', protected_processes: 'text', script_timeout_seconds_default: 'text',
        }, 'cmdProtectionSaveBtn');
    }
    if (me.role === 'superadmin') {
        $('cmdServerCard').hidden = false;
        Ui.settingsFieldsPanel({ command_ttl_hours: 'text', command_output_max_kb: 'text' }, 'cmdServerSaveBtn');
    }

    // ---- Вкладки и форма --------------------------------------------------------------

    document.querySelectorAll('.tabs button').forEach(function (b) {
        b.addEventListener('click', function () {
            document.querySelectorAll('.tabs button').forEach(function (x) { x.classList.toggle('active', x === b); });
            document.querySelectorAll('.tab-panel').forEach(function (p) { p.hidden = p.dataset.panel !== b.dataset.tab; });
        });
    });

    const presetPc = new URLSearchParams(window.location.search).get('pc');
    const typeEl = $('type');
    function showTypeFields() {
        document.querySelectorAll('.type-fields').forEach(function (block) {
            block.style.display = block.getAttribute('data-type') === typeEl.value ? '' : 'none';
        });
        // Файлы раскатываются со страницы «Файлы» — здесь для этого типа только отсылка туда.
        const files = typeEl.value === 'file_deploy';
        $('targetBox').hidden = files;
        document.querySelector('#createForm .form-actions').hidden = files;
    }
    typeEl.addEventListener('change', showTypeFields);
    showTypeFields();

    function openForm() {
        $('createForm').hidden = false;
        $('createForm').scrollIntoView({ behavior: 'smooth', block: 'start' });
    }
    $('newBtn').addEventListener('click', function () {
        if ($('createForm').hidden) openForm(); else $('createForm').hidden = true;
    });
    $('cancelNewBtn').addEventListener('click', function () { $('createForm').hidden = true; });
    $('closeNewBtn').addEventListener('click', function () { $('createForm').hidden = true; });
    $('goFilesBtn').addEventListener('click', function () {
        window.location.href = '/admin/files' + (presetPc ? '?pc=' + encodeURIComponent(presetPc) : '');
    });

    // «Кому» — общий компонент со строкой «Попадёт на N касс»: масштаб команды виден ещё
    // до окна подтверждения.
    const target = Ui.targetPicker($('targetBox'));

    // Пришли из профиля хоста (?pc=ID): сразу открываем форму с этим ПК в качестве цели.
    if (presetPc && canEdit) {
        openForm();
        await target.set('pc', presetPc);
    }

    // ---- Частые команды: заполняют форму одним кликом ----------------------------------

    // Только то, что безопасно на работающей кассе и работает на Windows 7 (PowerShell 2.0:
    // поэтому Get-WmiObject, а не Get-CimInstance). Перезагрузки и прочее разрушительное
    // сюда намеренно не входит — такое пишется руками, осознанно.
    const PRESETS = [
        { label: 'Свободное место на дисках', tip: 'PowerShell: свободно и всего по каждому локальному диску, в ГБ',
          type: 'script_run', engine: 'powershell',
          script: "Get-WmiObject Win32_LogicalDisk -Filter 'DriveType=3' |\n    Select-Object DeviceID, @{n='Свободно, ГБ';e={[math]::Round($_.FreeSpace/1GB,1)}}, @{n='Всего, ГБ';e={[math]::Round($_.Size/1GB,1)}} |\n    Format-Table -AutoSize | Out-String" },
        { label: 'Сеть: ipconfig /all', tip: 'IP-адреса, шлюз, DNS и MAC каждой сетевой карты', type: 'script_run', engine: 'cmd', script: 'ipconfig /all' },
        { label: 'Кто вошёл в систему', tip: 'Пользователи, вошедшие на кассу, и время входа (query user)', type: 'script_run', engine: 'cmd', script: 'query user' },
        { label: 'Версия Windows и время работы', tip: 'Выпуск Windows, номер сборки и когда касса последний раз загружалась',
          type: 'script_run', engine: 'powershell',
          script: "$os = Get-WmiObject Win32_OperatingSystem\n'{0} (сборка {1})' -f $os.Caption, $os.BuildNumber\n'Загружена: ' + $os.ConvertToDateTime($os.LastBootUpTime)" },
        { label: 'Часы и синхронизация', tip: 'Источник времени и когда часы последний раз сверялись (w32tm /query /status)', type: 'script_run', engine: 'cmd', script: 'w32tm /query /status' },
        { label: 'Перезапустить печать', tip: 'Перезапустить службу диспетчера печати (Spooler) — помогает, когда «завис» принтер чеков или документов',
          type: 'service_control', action: 'restart', service: 'Spooler' },
        { label: 'Очистить очередь печати', tip: 'Остановить Spooler, удалить застрявшие задания печати и запустить снова',
          type: 'script_run', engine: 'powershell',
          script: "Stop-Service Spooler -Force\nRemove-Item \"$env:SystemRoot\\System32\\spool\\PRINTERS\\*\" -Force -ErrorAction SilentlyContinue\nStart-Service Spooler\n'Очередь печати очищена, Spooler: ' + (Get-Service Spooler).Status" },
        { label: 'Список процессов', tip: 'Все процессы с PID и памятью — посмотреть перед завершением', type: 'process_action', action: 'list' },
        { label: 'Список служб', tip: 'Все службы Windows с состоянием', type: 'service_control', action: 'list', service: '' },
    ];
    $('presets').innerHTML = PRESETS.map(function (p, i) {
        return '<button type="button" class="chip link" style="font-family:inherit" data-preset="' + i + '" title="' + esc(p.tip) + '">' + esc(p.label) + '</button>';
    }).join('');
    $('presets').addEventListener('click', function (e) {
        const b = e.target.closest('[data-preset]');
        if (!b) return;
        const p = PRESETS[+b.dataset.preset];
        $('createForm').querySelectorAll('.type-fields input, .type-fields textarea').forEach(function (el) { el.value = ''; });
        typeEl.value = p.type;
        if (p.type === 'script_run') { $('scriptEngine').value = p.engine; $('scriptText').value = p.script; }
        if (p.type === 'service_control') { $('serviceAction').value = p.action; $('serviceName').value = p.service || ''; }
        if (p.type === 'process_action') { $('processAction').value = p.action; }
        showTypeFields();
        Ui.toast('Форма заполнена: «' + p.label + '». Выберите, кому, и отправьте.', 'info');
    });

    function collectPayload(type) {
        if (type === 'service_control') return { service_name: $('serviceName').value, action: $('serviceAction').value };
        if (type === 'process_action') return {
            action: $('processAction').value, process_name: $('processName').value,
            pid: $('processPid').value ? parseInt($('processPid').value, 10) : null,
        };
        if (type === 'script_run') return {
            engine: $('scriptEngine').value, script: $('scriptText').value, path: $('scriptPath').value, args: $('scriptArgs').value,
            timeout_seconds: $('scriptTimeout').value ? parseInt($('scriptTimeout').value, 10) : null,
        };
        return {};
    }

    // Заполнить форму из существующей команды — «Повторить». Раскатку файла повторяет
    // мастер на странице «Файлы» (там папка, имя и цель подставятся сами).
    async function prefill(c) {
        if (c.type === 'file_deploy') { window.location.href = '/admin/files?repeat=' + c.id; return; }
        let p = {};
        try { p = JSON.parse(c.payload); } catch (e) { /* — */ }
        typeEl.value = c.type;
        showTypeFields();
        if (c.type === 'service_control') { $('serviceAction').value = p.action || 'restart'; $('serviceName').value = p.service_name || ''; }
        if (c.type === 'process_action') { $('processAction').value = p.action || 'kill'; $('processName').value = p.process_name || ''; $('processPid').value = p.pid || ''; }
        if (c.type === 'script_run') {
            $('scriptEngine').value = p.engine || 'powershell'; $('scriptText').value = p.script || '';
            $('scriptPath').value = p.path || ''; $('scriptArgs').value = p.args || ''; $('scriptTimeout').value = p.timeout_seconds || '';
        }
        openForm();
        await target.set(c.target_type, c.target_id);
        Ui.toast('Форма заполнена из команды #' + c.id + ' — проверьте и отправьте', 'info');
    }

    const ERRORS = {
        unsupported_type: 'неизвестный тип команды', invalid_action: 'неверное действие',
        service_name_required: 'укажите имя службы', protected_service: 'эта служба в защищённом списке (вкладка «Защита и лимиты»)',
        protected_process: 'этот процесс в защищённом списке (вкладка «Защита и лимиты»)', process_name_or_pid_required: 'укажите имя процесса или PID',
        pid_requires_single_pc_target: 'завершать по PID можно только на одном конкретном ПК', invalid_engine: 'неверный тип скрипта',
        script_or_path_required: 'введите текст скрипта или путь к файлу', script_and_path_are_exclusive: 'либо текст скрипта, либо путь — не оба сразу',
        invalid_target_type: 'неверный тип цели', target_id_required: 'выберите, кому именно', insufficient_role: 'нужна роль администратора',
    };

    $('createForm').addEventListener('submit', async function (e) {
        e.preventDefault();
        const type = typeEl.value;
        const t = target.value();
        if (t.type !== 'all' && !t.id) { Ui.toast('Выберите, кому именно', 'error'); return; }
        const count = target.stats().total;
        if (!count) { Ui.toast('Под выбранную цель сейчас не подходит ни одна касса', 'error'); return; }

        const scary = type === 'script_run' ||
            (type === 'process_action' && $('processAction').value === 'kill') ||
            (type === 'service_control' && $('serviceAction').value !== 'list');
        if (scary && !await Ui.confirm('Отправить команду на ' + count + ' ' + Ui.plural(count, 'кассу', 'кассы', 'касс') +
            ' (' + target.describe() + ')? Отменить после отправки нельзя.', { okLabel: 'Отправить', danger: count > 1 })) return;

        $('submitBtn').disabled = true;
        try {
            const created = await Api.post('/admin/commands', { type: type, payload: collectPayload(type), target: t });
            Ui.toast('Команда отправлена — ход выполнения раскрыт в списке и обновляется сам.', 'success');
            if (created && created.id) watch([created.id]);
            $('createForm').querySelectorAll('.type-fields input, .type-fields textarea').forEach(function (el) { el.value = ''; });
            $('createForm').hidden = true;
            await loadCommands();
        } catch (err) {
            Ui.toast('Не удалось создать команду: ' + Ui.reason(err, ERRORS), 'error');
        } finally {
            $('submitBtn').disabled = false;
        }
    });

    // ---- Список команд ------------------------------------------------------------------

    let commands = [];
    const targetNames = { all: 'Всем кассам', store: 'Магазин', group: 'Группа', device_type: 'Тип', pc: 'ПК' };
    const typeNames = { service_control: 'Служба', process_action: 'Процесс', script_run: 'Скрипт', file_deploy: 'Файл' };
    const typeIcons = { service_control: 'cog', process_action: 'cpu', script_run: 'terminal', file_deploy: 'folder' };

    function describeTarget(c) {
        if (c.target_type === 'all') return targetNames.all;
        return (targetNames[c.target_type] || c.target_type) + ' «' + (c.target_name || '#' + c.target_id) + '»';
    }

    function describeCommand(c) {
        let p;
        try { p = JSON.parse(c.payload); } catch (e) { return c.type; }
        if (c.type === 'service_control') {
            if (p.action === 'list') return 'список служб';
            const actions = { start: 'запустить', stop: 'остановить', restart: 'перезапустить' };
            return (actions[p.action] || p.action) + ' службу «' + p.service_name + '»';
        }
        if (c.type === 'process_action') {
            if (p.action === 'list') return 'список процессов';
            return 'завершить процесс ' + (p.process_name ? '«' + p.process_name + '»' : '') + (p.pid ? ' PID ' + p.pid : '');
        }
        if (c.type === 'script_run') {
            const what = p.script ? p.script.split(/\r?\n/)[0] : (p.path + (p.args ? ' ' + p.args : ''));
            return (p.engine === 'cmd' ? 'CMD: ' : 'PowerShell: ') + what;
        }
        if (c.type === 'file_deploy') return 'файл «' + p.original_name + '» → ' + p.target_path;
        return c.type;
    }

    function resultsCell(c) {
        const total = +c.target_count;
        if (!total) return '<span class="muted">нет касс под эту цель</span>';
        const parts = [];
        if (+c.success_count) parts.push('<span class="badge badge-success" title="Выполнили без ошибок">' + c.success_count + ' ок</span>');
        if (+c.failed_count) parts.push('<span class="badge badge-failed" title="Ошибка или таймаут — подробности в строке кассы (нажмите на команду)">' + c.failed_count + ' ошибка</span>');
        if (+c.in_progress_count) parts.push('<span class="badge badge-in_progress" title="Касса забрала команду и сейчас выполняет">' + c.in_progress_count + ' в работе</span>');
        const pending = +c.pending_count, online = +c.pending_online_count;
        if (pending && +c.expired) {
            parts.push('<span class="badge badge-neutral" title="Срок жизни команды истёк — эти кассы её уже не получат">' + pending + ' не получат</span>');
        } else if (pending) {
            parts.push('<span class="badge badge-neutral" title="Ещё не забрали команду. На связи — заберут на ближайшем опросе; остальные — когда выйдут на связь">ждут ' +
                pending + (online < pending ? ' (на связи ' + online + ')' : '') + '</span>');
        }
        return '<div style="display:flex;gap:4px;flex-wrap:wrap">' + parts.join('') + '</div>' + Ui.progressBar([
            { n: +c.success_count, kind: 'ok', label: 'ок' },
            { n: +c.failed_count, kind: 'bad', label: 'ошибка' },
            { n: +c.in_progress_count, kind: 'run', label: 'в работе' },
            { n: pending, kind: 'wait', label: 'ждут' },
        ], total);
    }

    // Команда «в процессе», пока кто-то её выполняет или её вот-вот заберёт касса на связи.
    function isActive(c) {
        return +c.in_progress_count > 0 || (+c.pending_online_count > 0 && !+c.expired);
    }

    const STATUS_LABELS = { pending: 'ждёт', in_progress: 'в работе', success: 'ок', failed: 'ошибка', timeout: 'таймаут' };
    const STATUS_TIPS = {
        pending: 'Касса ещё не забрала команду', in_progress: 'Касса забрала команду и выполняет её',
        success: 'Выполнено без ошибок', failed: 'Касса вернула ошибку — текст в колонке «Результат»',
        timeout: 'Не уложилось в отведённое время — процесс остановлен',
    };

    function pendingNote(r, c) {
        if (+c.expired) return '<span class="muted">не получит — срок жизни команды истёк</span>';
        if (r.online) return '<span class="muted">на связи — заберёт на ближайшем опросе</span>';
        return '<span class="muted">не на связи' + (r.last_seen ? ' с ' + esc(formatServerTime(r.last_seen)) : ' ни разу') + ' — заберёт, когда выйдет</span>';
    }

    async function loadCommands() {
        commands = await Api.get('/admin/commands');
        const q = $('search').value.toLowerCase();
        const tf = $('typeFilter').value;
        const tbody = document.querySelector('#commandsTable tbody');
        const open = new Set([...tbody.querySelectorAll('tr.open')].map(function (tr) { return tr.dataset.id; }));
        watched.forEach(function (id) { open.add(id); });
        const visible = commands.filter(function (c) {
            const hay = (describeCommand(c) + ' ' + describeTarget(c) + ' ' + (c.created_by_username || '')).toLowerCase();
            return (!tf || c.type === tf) && (!q || hay.indexOf(q) >= 0);
        }).sort(function (a, b) { return Ui.compareBy(a, b, sort); });

        // Детали раскрытых строк — до перерисовки и параллельно: при частом обновлении
        // во время наблюдения таблица не мигает пустой.
        const details = {};
        await Promise.all(visible.filter(function (c) { return open.has(String(c.id)); }).map(async function (c) {
            details[c.id] = await Api.get('/admin/commands/' + c.id + '/results');
        }));

        tbody.innerHTML = '';
        if (!visible.length) {
            tbody.innerHTML = '<tr><td colspan="6">' + (commands.length
                ? '<div class="empty">Ничего не найдено — измените поиск или фильтр.</div>'
                : Ui.emptyState({ icon: 'terminal', title: 'Команд пока не было',
                    text: canEdit ? 'Нажмите «Новая команда» — например, «Свободное место на дисках» из частых команд — и выберите кассы.' : 'Отправлять команды может администратор.' })) + '</td></tr>';
            return;
        }
        for (const c of visible) {
            const tr = document.createElement('tr');
            tr.className = 'clickable';
            tr.dataset.id = c.id;
            tr.innerHTML =
                '<td class="muted nowrap">' + esc(formatServerTime(c.created_at)) + '</td>' +
                '<td><span class="kind">' + Ui.icon(typeIcons[c.type] || 'terminal') + (typeNames[c.type] || c.type) + '</span> ' +
                    '<span style="word-break:break-word">' + esc(describeCommand(c)) + '</span>' +
                    (c.update_batch_id ? ' <span class="badge badge-info plain" title="Несколько файлов, отправленных одним действием (пакет ' + esc(c.update_batch_id) + ')">пакет</span>' : '') + '</td>' +
                '<td>' + esc(describeTarget(c)) + '</td>' +
                '<td>' + esc(c.created_by_username || '—') + '</td>' +
                '<td style="min-width:170px">' + resultsCell(c) + '</td>' +
                '<td><div class="actions">' + (canEdit ? '<button type="button" class="small" data-act="repeat" title="' +
                    (c.type === 'file_deploy' ? 'Открыть мастер раскатки с этим файлом, папкой и целью' : 'Заполнить форму этой командой — останется проверить и отправить') + '">Повторить</button>' : '') + '</div></td>';
            tbody.appendChild(tr);
            if (details[c.id]) Ui.toggleDetail(tr, resultsHtml(c, details[c.id]), 6);
        }
        finishWatchIfDone();
    }

    function resultsHtml(c, results) {
        if (!results.length) return '<p class="muted">Под эту цель сейчас не подходит ни одна касса.</p>';
        const done = +c.success_count + +c.failed_count;
        return '<p class="muted" style="margin:0 0 8px">Выполнено ' + done + ' из ' + results.length +
            (+c.failed_count ? ', с ошибкой ' + c.failed_count : '') +
            (+c.in_progress_count ? ', в работе ' + c.in_progress_count : '') +
            (+c.pending_count ? ', не забрали ' + c.pending_count : '') +
            (watched.has(String(c.id)) && isActive(c) ? ' · обновляется само' : '') + '</p>' +
            '<table><thead><tr><th>Магазин</th><th>Хост</th><th>Статус</th><th>Результат</th><th>Выполнено</th></tr></thead><tbody>' +
            results.map(function (r) {
                const badge = r.status === 'pending' ? 'neutral' : r.status;
                return '<tr><td>' + esc(r.store_name) + '</td>' +
                    '<td><a class="host-link" href="/admin/hosts/host?id=' + r.pc_id + '" title="Профиль хоста">' + esc(r.display_name || r.hostname) + '</a></td>' +
                    '<td><span class="badge badge-' + esc(badge) + '" title="' + esc(STATUS_TIPS[r.status] || '') + '">' + esc(STATUS_LABELS[r.status] || r.status) + '</span></td>' +
                    '<td style="max-width:520px">' + (r.status === 'pending' ? pendingNote(r, c)
                        : (r.output ? '<pre class="output">' + esc(r.output) + '</pre>' : '<span class="muted">—</span>')) + '</td>' +
                    '<td class="muted nowrap">' + (r.executed_at ? esc(formatServerTime(r.executed_at)) : '') + '</td></tr>';
            }).join('') + '</tbody></table>';
    }

    async function showResults(tr, c) {
        if (tr.classList.contains('open')) { Ui.toggleDetail(tr, '', 6); watched.delete(String(c.id)); return; }
        Ui.toggleDetail(tr, resultsHtml(c, await Api.get('/admin/commands/' + c.id + '/results')), 6);
    }

    // Наблюдение за только что отправленными командами: их строки раскрыты, список
    // обновляется каждые 3 с, пока кто-то выполняет или вот-вот заберёт (не дольше 10 мин),
    // в конце — итог тостом.
    let watched = new Set();
    let watchUntil = 0;

    function watch(ids) {
        ids.forEach(function (id) { watched.add(String(id)); });
        watchUntil = Date.now() + 10 * 60 * 1000;
    }

    function finishWatchIfDone() {
        if (!watched.size) return;
        const ours = commands.filter(function (c) { return watched.has(String(c.id)); });
        if (ours.some(isActive) && Date.now() < watchUntil) return;
        const sum = function (key) { return ours.reduce(function (s, c) { return s + +c[key]; }, 0); };
        const failed = sum('failed_count'), waiting = sum('pending_count');
        Ui.toast('Готово: ' + sum('success_count') + ' ок' + (failed ? ', ' + failed + ' с ошибкой' : '') +
            (waiting ? '. Не на связи, заберут позже: ' + waiting : ''), failed ? 'error' : 'success');
        watched = new Set();
    }

    document.querySelector('#commandsTable').addEventListener('click', async function (e) {
        if (e.target.closest('a')) return;
        const tr = e.target.closest('tr[data-id]');
        if (!tr) return;
        const c = commands.find(function (x) { return String(x.id) === tr.dataset.id; });
        const btn = e.target.closest('button[data-act]');
        if (btn && btn.dataset.act === 'repeat') { prefill(c); return; }
        showResults(tr, c);
    });

    $('search').addEventListener('input', loadCommands);
    $('typeFilter').addEventListener('change', loadCommands);
    $('refreshBtn').addEventListener('click', loadCommands);
    const sort = Ui.makeSortable(document.querySelector('#commandsTable'), { key: 'created_at', dir: 'desc' }, loadCommands);

    // ?watch=1,2,3 — пришли со страниц «Обновления»/«Файлы» смотреть, как раскатывается пакет.
    const watchParam = new URLSearchParams(location.search).get('watch');
    if (watchParam) watch(watchParam.split(',').filter(Boolean));

    await loadCommands();
    let lastFull = Date.now();
    setInterval(function () {
        if (document.hidden) return;
        if (watched.size || Date.now() - lastFull >= 15000) { lastFull = Date.now(); loadCommands(); }
    }, 3000);
})();
