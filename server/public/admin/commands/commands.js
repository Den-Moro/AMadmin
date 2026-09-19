(async function () {
    await requireAdminAuth();


    function escapeHtml(s) {
        const div = document.createElement('div');
        div.textContent = s == null ? '' : String(s);
        return div.innerHTML;
    }

    function $(id) {
        return document.getElementById(id);
    }

    // ---- Переключение полей по типу команды -------------------------------------

    const typeEl = $('type');

    function showTypeFields() {
        document.querySelectorAll('.type-fields').forEach(function (block) {
            block.style.display = block.getAttribute('data-type') === typeEl.value ? '' : 'none';
        });
    }

    typeEl.addEventListener('change', showTypeFields);
    showTypeFields();

    // ---- Таргет -------------------------------------------------------------------

    const targetTypeEl = $('targetType');
    const targetIdWrap = $('targetIdWrap');
    const targetIdEl = $('targetId');
    const optionsCache = {};

    function optionLabel(item) {
        return item.name || item.display_name || item.hostname;
    }

    async function loadTargetOptions(type) {
        if (type === 'all') {
            targetIdWrap.style.display = 'none';
            return;
        }

        targetIdWrap.style.display = '';
        targetIdEl.innerHTML = '<option value="">Загрузка…</option>';

        if (!optionsCache[type]) {
            const endpoints = {
                store: '/admin/stores',
                group: '/admin/host-groups',
                device_type: '/admin/device-types',
                pc: '/admin/pcs',
            };
            optionsCache[type] = await Api.get(endpoints[type]);
        }

        targetIdEl.innerHTML = '';
        optionsCache[type].forEach(function (item) {
            const opt = document.createElement('option');
            opt.value = item.id;
            opt.textContent = optionLabel(item);
            targetIdEl.appendChild(opt);
        });
    }

    targetTypeEl.addEventListener('change', function () {
        loadTargetOptions(targetTypeEl.value);
    });

    // Простое "точно на N хостов?" перед массовой отправкой (см. AGENTS.md,
    // "Безопасность и аудит") — считаем N через уже существующие эндпоинты, отдельного
    // серверного эндпоинта для подсчёта не заводим.
    async function estimateTargetCount(type, id) {
        if (type === 'all') {
            return (await Api.get('/admin/pcs')).length;
        }
        if (type === 'store') {
            return (await Api.get('/admin/pcs?store_id=' + id)).length;
        }
        if (type === 'device_type') {
            return (await Api.get('/admin/pcs?device_type_id=' + id)).length;
        }
        if (type === 'group') {
            return (await Api.get('/admin/host-groups/' + id + '/members')).length;
        }
        if (type === 'pc') {
            return 1;
        }
        return 0;
    }

    // ---- Сбор payload по типу -------------------------------------------------------

    function collectPayload(type) {
        if (type === 'service_control') {
            return { service_name: $('serviceName').value, action: $('serviceAction').value };
        }
        if (type === 'process_action') {
            return {
                action: $('processAction').value,
                process_name: $('processName').value,
                pid: $('processPid').value ? parseInt($('processPid').value, 10) : null,
            };
        }
        if (type === 'script_run') {
            return {
                engine: $('scriptEngine').value,
                script: $('scriptText').value,
                path: $('scriptPath').value,
                args: $('scriptArgs').value,
                timeout_seconds: $('scriptTimeout').value ? parseInt($('scriptTimeout').value, 10) : null,
            };
        }
        if (type === 'file_deploy') {
            return { file_id: $('deployFileId').value, target_path: $('deployTargetPath').value };
        }
        return {};
    }

    // Коды ошибок сервера — человеческим языком, чтобы не гадать по «invalid_action».
    const ERRORS = {
        unsupported_type: 'неизвестный тип команды',
        invalid_action: 'неверное действие',
        service_name_required: 'укажите имя службы',
        protected_service: 'эта служба в защищённом списке (см. Настройки)',
        protected_process: 'этот процесс в защищённом списке (см. Настройки)',
        process_name_or_pid_required: 'укажите имя процесса или PID',
        pid_requires_single_pc_target: 'завершать по PID можно только на одном конкретном ПК',
        invalid_engine: 'неверный тип скрипта',
        script_or_path_required: 'введите текст скрипта или путь к файлу',
        script_and_path_are_exclusive: 'либо текст скрипта, либо путь — не оба сразу',
        file_id_required: 'выберите файл (сначала загрузите его ниже)',
        file_not_found: 'файл не найден — возможно, его удалили',
        target_path_must_be_absolute_windows_path: 'путь на ПК должен быть полным, например C:\\Папка\\файл.txt',
        invalid_target_type: 'неверный тип цели',
        target_id_required: 'выберите, кому именно',
        insufficient_role: 'нужна роль administrator',
    };

    $('createForm').addEventListener('submit', async function (e) {
        e.preventDefault();
        const errorEl = $('error');
        const successEl = $('success');
        errorEl.textContent = '';
        successEl.textContent = '';

        const type = typeEl.value;
        const targetType = targetTypeEl.value;
        const targetId = targetType === 'all' ? null : targetIdEl.value;

        const count = await estimateTargetCount(targetType, targetId);
        const scary = type === 'script_run' || type === 'file_deploy' ||
            (type === 'process_action' && $('processAction').value === 'kill') ||
            (type === 'service_control' && $('serviceAction').value !== 'list');
        if (scary && !confirm('Отправить команду на ' + count + ' хост(ов)? Отменить после отправки нельзя.')) {
            return;
        }

        const body = {
            type: type,
            payload: collectPayload(type),
            target: { type: targetType, id: targetId },
        };

        try {
            await Api.post('/admin/commands', body);
            successEl.textContent = 'Команда отправлена. Результаты появятся по мере опроса касс.';
            $('createForm').reset();
            showTypeFields();
            targetIdWrap.style.display = 'none';
            await loadCommands();
        } catch (err) {
            const code = (err.data && err.data.error) || err.message;
            errorEl.textContent = 'Не удалось создать команду: ' + (ERRORS[code] || code) + '.';
        }
    });

    // ---- Файлы для раскатки ---------------------------------------------------------

    function formatSize(bytes) {
        if (bytes < 1024) return bytes + ' Б';
        if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' КБ';
        return (bytes / 1024 / 1024).toFixed(1) + ' МБ';
    }

    async function loadFiles() {
        const files = await Api.get('/admin/files');

        const select = $('deployFileId');
        select.innerHTML = files.length ? '' : '<option value="">— файлов пока нет —</option>';
        files.forEach(function (f) {
            const opt = document.createElement('option');
            opt.value = f.id;
            opt.textContent = f.original_name + ' (' + formatSize(f.size) + ')';
            select.appendChild(opt);
        });

        const tbody = document.querySelector('#filesTable tbody');
        tbody.innerHTML = '';
        if (!files.length) {
            tbody.innerHTML = '<tr><td colspan="6" class="muted">Пока ничего не загружено.</td></tr>';
        }
        files.forEach(function (f) {
            const tr = document.createElement('tr');
            tr.innerHTML =
                '<td>' + escapeHtml(f.original_name) + '</td>' +
                '<td>' + formatSize(f.size) + '</td>' +
                '<td><code title="' + escapeHtml(f.sha256) + '">' + escapeHtml(f.sha256.slice(0, 12)) + '…</code></td>' +
                '<td>' + escapeHtml(formatServerTime(f.created_at)) + '</td>' +
                '<td>' + escapeHtml(f.uploaded_by_username || '—') + '</td>' +
                '<td><button type="button" data-delete-file="' + f.id + '">Удалить</button></td>';
            tbody.appendChild(tr);
        });
    }

    // Загрузка — multipart, не JSON: браузер сам ставит boundary в Content-Type,
    // поэтому обычная обёртка Api тут не подходит.
    $('uploadForm').addEventListener('submit', async function (e) {
        e.preventDefault();
        const errorEl = $('uploadError');
        const successEl = $('uploadSuccess');
        errorEl.textContent = '';
        successEl.textContent = '';

        const input = $('uploadFile');
        if (!input.files.length) return;

        const form = new FormData();
        form.append('file', input.files[0]);

        try {
            const response = await fetch('/admin/files', { method: 'POST', body: form });
            const data = await response.json().catch(function () { return {}; });
            if (!response.ok) {
                const code = data.error || ('http_' + response.status);
                if (code === 'file_required_or_too_large') {
                    throw new Error('файл больше лимита сервера (' + data.upload_max_filesize + ')');
                }
                throw new Error(ERRORS[code] || code);
            }
            successEl.textContent = 'Файл загружен: ' + input.files[0].name + '.';
            $('uploadForm').reset();
            await loadFiles();
        } catch (err) {
            errorEl.textContent = 'Не удалось загрузить: ' + err.message + '.';
        }
    });

    document.querySelector('#filesTable').addEventListener('click', async function (e) {
        const id = e.target.getAttribute('data-delete-file');
        if (!id) return;
        if (!confirm('Удалить файл с сервера? Незавершённые команды с ним завершатся ошибкой.')) return;

        try {
            await Api.request('DELETE', '/admin/files/' + id);
            await loadFiles();
        } catch (err) {
            alert('Не удалось удалить файл: ' + ((err.data && err.data.error) || err.message));
        }
    });

    // ---- Список команд и результаты ---------------------------------------------------

    function describeTarget(c) {
        const names = { all: 'Всем', store: 'Магазин', group: 'Группа', device_type: 'Тип устройства', pc: 'ПК' };
        const label = names[c.target_type] || c.target_type;
        return c.target_id ? label + ' #' + c.target_id : label;
    }

    function describeCommand(c) {
        let p;
        try {
            p = JSON.parse(c.payload);
        } catch (e) {
            return c.type;
        }

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
            return (p.engine === 'cmd' ? 'CMD' : 'PowerShell') + ': ' + what;
        }
        if (c.type === 'file_deploy') {
            return 'файл «' + p.original_name + '» → ' + p.target_path;
        }
        return c.type;
    }

    async function loadCommands() {
        const rows = await Api.get('/admin/commands');
        const tbody = document.querySelector('#commandsTable tbody');
        tbody.innerHTML = '';
        rows.forEach(function (c) {
            const tr = document.createElement('tr');
            tr.innerHTML =
                '<td>' + escapeHtml(formatServerTime(c.created_at)) + '</td>' +
                '<td>' + escapeHtml(describeCommand(c)) + '</td>' +
                '<td>' + escapeHtml(describeTarget(c)) + '</td>' +
                '<td>' + escapeHtml(c.created_by_username || '—') + '</td>' +
                '<td>' + c.in_progress_count + '</td>' +
                '<td>' + c.success_count + '</td>' +
                '<td>' + c.failed_count + '</td>' +
                '<td><button type="button" data-open="' + c.id + '">Результаты</button></td>';
            tbody.appendChild(tr);
        });
    }

    document.querySelector('#commandsTable').addEventListener('click', async function (e) {
        const id = e.target.getAttribute('data-open');
        if (!id) return;

        const results = await Api.get('/admin/commands/' + id + '/results');
        $('detail').style.display = '';
        $('detailTitle').textContent = 'Результаты команды #' + id;

        const tbody = document.querySelector('#resultsTable tbody');
        tbody.innerHTML = '';
        if (results.length === 0) {
            tbody.innerHTML = '<tr><td colspan="6" class="muted">Пока ни один ПК не опросил сервер с момента отправки.</td></tr>';
            return;
        }
        results.forEach(function (r) {
            const tr = document.createElement('tr');
            // Вывод — в <pre>: списки служб/процессов и вывод скриптов многострочные.
            tr.innerHTML =
                '<td>' + escapeHtml(r.store_name) + '</td>' +
                '<td>' + escapeHtml(r.display_name || r.hostname) + '</td>' +
                '<td>' + escapeHtml(r.status) + '</td>' +
                '<td><pre class="output">' + escapeHtml(r.output || '—') + '</pre></td>' +
                '<td>' + escapeHtml(formatServerTime(r.claimed_at)) + '</td>' +
                '<td>' + escapeHtml(formatServerTime(r.executed_at)) + '</td>';
            tbody.appendChild(tr);
        });
        $('detail').scrollIntoView({ behavior: 'smooth' });
    });

    await loadFiles();
    await loadCommands();
})();
