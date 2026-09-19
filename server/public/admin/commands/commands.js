(async function () {
    const me = await requireAdminAuth();
    const canEdit = me.role === 'administrator' || me.role === 'superadmin';
    const $ = Ui.$, esc = Ui.escapeHtml;

    if (canEdit) {
        $('adminActions').hidden = false;
        document.querySelectorAll('[data-admin]').forEach(function (el) { el.hidden = false; });
    }

    // ---- Вкладки и форма --------------------------------------------------------------

    document.querySelectorAll('.tabs button').forEach(function (b) {
        b.addEventListener('click', function () {
            document.querySelectorAll('.tabs button').forEach(function (x) { x.classList.toggle('active', x === b); });
            document.querySelectorAll('.tab-panel').forEach(function (p) { p.hidden = p.dataset.panel !== b.dataset.tab; });
        });
    });

    const typeEl = $('type');
    function showTypeFields() {
        document.querySelectorAll('.type-fields').forEach(function (block) {
            block.style.display = block.getAttribute('data-type') === typeEl.value ? '' : 'none';
        });
    }
    typeEl.addEventListener('change', showTypeFields);
    showTypeFields();

    $('newBtn').addEventListener('click', function () {
        $('createForm').hidden = !$('createForm').hidden;
        if (!$('createForm').hidden) $('createForm').scrollIntoView({ behavior: 'smooth', block: 'start' });
    });
    $('cancelNewBtn').addEventListener('click', function () { $('createForm').hidden = true; });

    // ---- Таргет -----------------------------------------------------------------------

    const targetTypeEl = $('targetType');
    const targetIdWrap = $('targetIdWrap');
    const targetIdEl = $('targetId');
    const optionsCache = {};

    async function loadTargetOptions(type, selectedId) {
        if (type === 'all') { targetIdWrap.style.display = 'none'; return; }
        targetIdWrap.style.display = '';
        targetIdEl.innerHTML = '<option value="">Загрузка…</option>';
        if (!optionsCache[type]) {
            const endpoints = { store: '/admin/stores', group: '/admin/host-groups', device_type: '/admin/device-types', pc: '/admin/pcs' };
            optionsCache[type] = await Api.get(endpoints[type]);
        }
        targetIdEl.innerHTML = '';
        optionsCache[type].forEach(function (item) {
            const opt = document.createElement('option');
            opt.value = item.id;
            opt.textContent = item.name || item.display_name || item.hostname;
            targetIdEl.appendChild(opt);
        });
        if (selectedId) targetIdEl.value = selectedId;
    }
    targetTypeEl.addEventListener('change', function () { loadTargetOptions(targetTypeEl.value); });

    // «Точно на N хостов?» — считаем через существующие эндпоинты.
    async function estimateTargetCount(type, id) {
        if (type === 'all') return (await Api.get('/admin/pcs')).length;
        if (type === 'store') return (await Api.get('/admin/pcs?store_id=' + id)).length;
        if (type === 'device_type') return (await Api.get('/admin/pcs?device_type_id=' + id)).length;
        if (type === 'group') return (await Api.get('/admin/host-groups/' + id + '/members')).length;
        return 1;
    }

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
        if (type === 'file_deploy') return { file_id: $('deployFileId').value, target_path: $('deployTargetPath').value };
        return {};
    }

    // Заполнить форму из существующей команды — «Повторить».
    async function prefill(c) {
        let p = {};
        try { p = JSON.parse(c.payload); } catch (e) { /* — */ }
        $('createForm').hidden = false;
        typeEl.value = c.type;
        showTypeFields();
        if (c.type === 'service_control') { $('serviceAction').value = p.action || 'restart'; $('serviceName').value = p.service_name || ''; }
        if (c.type === 'process_action') { $('processAction').value = p.action || 'kill'; $('processName').value = p.process_name || ''; $('processPid').value = p.pid || ''; }
        if (c.type === 'script_run') {
            $('scriptEngine').value = p.engine || 'powershell'; $('scriptText').value = p.script || '';
            $('scriptPath').value = p.path || ''; $('scriptArgs').value = p.args || ''; $('scriptTimeout').value = p.timeout_seconds || '';
        }
        if (c.type === 'file_deploy') { $('deployFileId').value = p.file_id || ''; $('deployTargetPath').value = p.target_path || ''; }
        targetTypeEl.value = c.target_type;
        await loadTargetOptions(c.target_type, c.target_id);
        $('createForm').scrollIntoView({ behavior: 'smooth', block: 'start' });
        Ui.toast('Форма заполнена из команды #' + c.id + ' — проверьте и отправьте', 'info');
    }

    const ERRORS = {
        unsupported_type: 'неизвестный тип команды', invalid_action: 'неверное действие',
        service_name_required: 'укажите имя службы', protected_service: 'эта служба в защищённом списке (см. Настройки)',
        protected_process: 'этот процесс в защищённом списке (см. Настройки)', process_name_or_pid_required: 'укажите имя процесса или PID',
        pid_requires_single_pc_target: 'завершать по PID можно только на одном конкретном ПК', invalid_engine: 'неверный тип скрипта',
        script_or_path_required: 'введите текст скрипта или путь к файлу', script_and_path_are_exclusive: 'либо текст скрипта, либо путь — не оба сразу',
        file_id_required: 'выберите файл (сначала загрузите его)', file_not_found: 'файл не найден — возможно, его удалили',
        target_path_must_be_absolute_windows_path: 'путь на ПК должен быть полным, например C:\\Папка\\файл.txt',
        invalid_target_type: 'неверный тип цели', target_id_required: 'выберите, кому именно', insufficient_role: 'нужна роль администратора',
    };

    $('createForm').addEventListener('submit', async function (e) {
        e.preventDefault();
        const type = typeEl.value;
        const targetType = targetTypeEl.value;
        const targetId = targetType === 'all' ? null : targetIdEl.value;

        const count = await estimateTargetCount(targetType, targetId);
        const scary = type === 'script_run' || type === 'file_deploy' ||
            (type === 'process_action' && $('processAction').value === 'kill') ||
            (type === 'service_control' && $('serviceAction').value !== 'list');
        if (scary && !await Ui.confirm('Отправить команду на ' + count + ' хост(ов)? Отменить после отправки нельзя.', { okLabel: 'Отправить', danger: count > 1 })) return;

        try {
            await Api.post('/admin/commands', { type: type, payload: collectPayload(type), target: { type: targetType, id: targetId } });
            Ui.toast('Команда отправлена. Результаты появятся по мере опроса касс.', 'success');
            $('createForm').reset();
            $('createForm').hidden = true;
            showTypeFields();
            targetIdWrap.style.display = 'none';
            await loadCommands();
        } catch (err) {
            Ui.toast('Не удалось создать команду: ' + Ui.reason(err, ERRORS), 'error');
        }
    });

    // ---- Файлы ------------------------------------------------------------------------

    let files = [];

    async function loadFiles() {
        files = await Api.get('/admin/files');
        const select = $('deployFileId');
        select.innerHTML = files.length ? '' : '<option value="">— файлов пока нет —</option>';
        files.forEach(function (f) {
            const opt = document.createElement('option');
            opt.value = f.id;
            opt.textContent = f.original_name + ' (' + Ui.formatSize(f.size) + ')';
            select.appendChild(opt);
        });

        const tbody = document.querySelector('#filesTable tbody');
        tbody.innerHTML = '';
        if (!files.length) {
            tbody.innerHTML = '<tr><td colspan="6" class="empty">Пока ничего не загружено.</td></tr>';
            return;
        }
        files.forEach(function (f) {
            const tr = document.createElement('tr');
            tr.innerHTML =
                '<td><b>' + esc(f.original_name) + '</b></td>' +
                '<td class="num">' + Ui.formatSize(f.size) + '</td>' +
                '<td><code title="' + esc(f.sha256) + '">' + esc(f.sha256.slice(0, 12)) + '…</code></td>' +
                '<td class="muted">' + esc(formatServerTime(f.created_at)) + '</td>' +
                '<td>' + esc(f.uploaded_by_username || '—') + '</td>' +
                '<td><div class="actions">' + (canEdit ? '<button type="button" data-delete-file="' + f.id + '">Удалить</button>' : '') + '</div></td>';
            tbody.appendChild(tr);
        });
    }

    // Загрузка — multipart, не JSON: браузер сам ставит boundary, обёртка Api не подходит.
    $('uploadForm').addEventListener('submit', async function (e) {
        e.preventDefault();
        const input = $('uploadFile');
        if (!input.files.length) return;
        const form = new FormData();
        form.append('file', input.files[0]);
        const btn = $('uploadForm').querySelector('button[type=submit]');
        btn.disabled = true;
        btn.textContent = 'Загружается…';
        try {
            const response = await fetch('/admin/files', { method: 'POST', body: form });
            const data = await response.json().catch(function () { return {}; });
            if (!response.ok) {
                const code = data.error || ('http_' + response.status);
                throw new Error(code === 'file_required_or_too_large' ? 'файл больше лимита сервера (' + data.upload_max_filesize + ')' : (ERRORS[code] || code));
            }
            Ui.toast('Файл загружен: ' + input.files[0].name, 'success');
            $('uploadForm').reset();
            await loadFiles();
        } catch (err) {
            Ui.toast('Не удалось загрузить: ' + err.message, 'error');
        } finally {
            btn.disabled = false;
            btn.textContent = 'Загрузить';
        }
    });

    document.querySelector('#filesTable').addEventListener('click', async function (e) {
        const id = e.target.getAttribute('data-delete-file');
        if (!id) return;
        const f = files.find(function (x) { return String(x.id) === id; });
        if (!await Ui.confirm('Удалить «' + f.original_name + '» с сервера? Незавершённые команды с этим файлом завершатся ошибкой.', { danger: true, okLabel: 'Удалить' })) return;
        try { await Api.request('DELETE', '/admin/files/' + id); Ui.toast('Файл удалён', 'success'); await loadFiles(); }
        catch (err) { Ui.toast('Не удалось: ' + Ui.reason(err), 'error'); }
    });

    // ---- Список команд ------------------------------------------------------------------

    let commands = [];
    const targetNames = { all: 'Всем', store: 'Магазин', group: 'Группа', device_type: 'Тип', pc: 'ПК' };
    const typeNames = { service_control: 'Служба', process_action: 'Процесс', script_run: 'Скрипт', file_deploy: 'Файл' };

    function describeTarget(c) {
        const label = targetNames[c.target_type] || c.target_type;
        return c.target_id ? label + ' #' + c.target_id : label;
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
        const parts = [];
        if (c.success_count) parts.push('<span class="badge badge-success">' + c.success_count + ' ок</span>');
        if (c.failed_count) parts.push('<span class="badge badge-failed">' + c.failed_count + ' ошибка</span>');
        if (c.in_progress_count) parts.push('<span class="badge badge-in_progress">' + c.in_progress_count + ' в работе</span>');
        return parts.length ? parts.join(' ') : '<span class="muted">ещё никто не забрал</span>';
    }

    async function loadCommands() {
        commands = await Api.get('/admin/commands');
        const q = $('search').value.toLowerCase();
        const tf = $('typeFilter').value;
        const tbody = document.querySelector('#commandsTable tbody');
        const open = new Set([...tbody.querySelectorAll('tr.open')].map(function (tr) { return tr.dataset.id; }));
        tbody.innerHTML = '';
        const visible = commands.filter(function (c) {
            return (!tf || c.type === tf) && (!q || describeCommand(c).toLowerCase().indexOf(q) >= 0);
        });
        if (!visible.length) {
            tbody.innerHTML = '<tr><td colspan="6" class="empty">Команд пока не было.</td></tr>';
            return;
        }
        for (const c of visible) {
            const tr = document.createElement('tr');
            tr.className = 'clickable';
            tr.dataset.id = c.id;
            tr.innerHTML =
                '<td class="muted" style="white-space:nowrap">' + esc(formatServerTime(c.created_at)) + '</td>' +
                '<td><span class="badge badge-neutral">' + (typeNames[c.type] || c.type) + '</span> ' + esc(describeCommand(c)) + '</td>' +
                '<td>' + esc(describeTarget(c)) + '</td>' +
                '<td>' + esc(c.created_by_username || '—') + '</td>' +
                '<td>' + resultsCell(c) + '</td>' +
                '<td><div class="actions">' + (canEdit ? '<button type="button" data-act="repeat" title="Заполнить форму этой командой">Повторить</button>' : '') + '</div></td>';
            tbody.appendChild(tr);
            if (open.has(String(c.id))) await showResults(tr, c);
        }
    }

    async function showResults(tr, c) {
        const results = await Api.get('/admin/commands/' + c.id + '/results');
        let html;
        if (!results.length) {
            html = '<p class="muted">Пока ни одна касса не опросила сервер с момента отправки.</p>';
        } else {
            html = '<table><thead><tr><th>Магазин</th><th>Хост</th><th>Статус</th><th>Результат</th><th>Выполнено</th></tr></thead><tbody>' +
                results.map(function (r) {
                    return '<tr><td>' + esc(r.store_name) + '</td><td>' + esc(r.display_name || r.hostname) + '</td>' +
                        '<td><span class="badge badge-' + esc(r.status) + '">' + esc(r.status) + '</span></td>' +
                        '<td style="max-width:520px">' + (r.output ? '<pre class="output">' + esc(r.output) + '</pre>' : '<span class="muted">—</span>') + '</td>' +
                        '<td class="muted" style="white-space:nowrap">' + esc(formatServerTime(r.executed_at)) + '</td></tr>';
                }).join('') + '</tbody></table>';
        }
        Ui.toggleDetail(tr, html, 6);
    }

    document.querySelector('#commandsTable').addEventListener('click', async function (e) {
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

    await loadFiles();
    await loadCommands();
    setInterval(function () { if (!document.hidden) loadCommands(); }, 15000);
})();
