(async function () {
    await requireAdminAuth();

    document.getElementById('logoutBtn').addEventListener('click', async function () {
        await Api.post('/admin/logout');
        window.location.href = '/admin/login.html';
    });

    function escapeHtml(s) {
        const div = document.createElement('div');
        div.textContent = s == null ? '' : String(s);
        return div.innerHTML;
    }

    const targetTypeEl = document.getElementById('targetType');
    const targetIdWrap = document.getElementById('targetIdWrap');
    const targetIdEl = document.getElementById('targetId');
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

    document.getElementById('createForm').addEventListener('submit', async function (e) {
        e.preventDefault();
        const errorEl = document.getElementById('error');
        const successEl = document.getElementById('success');
        errorEl.textContent = '';
        successEl.textContent = '';

        const targetType = targetTypeEl.value;
        const targetId = targetType === 'all' ? null : targetIdEl.value;

        const count = await estimateTargetCount(targetType, targetId);
        if (!confirm('Отправить команду на ' + count + ' хост(ов)?')) {
            return;
        }

        const body = {
            type: 'service_control',
            payload: {
                service_name: document.getElementById('serviceName').value,
                action: document.getElementById('action').value,
            },
            target: { type: targetType, id: targetId },
        };

        try {
            await Api.post('/admin/commands', body);
            successEl.textContent = 'Команда отправлена.';
            document.getElementById('createForm').reset();
            targetIdWrap.style.display = 'none';
            await loadCommands();
        } catch (err) {
            const reason = (err.data && err.data.error) || err.message;
            errorEl.textContent = 'Не удалось создать команду (' + reason + ').';
        }
    });

    function describeTarget(c) {
        const names = { all: 'Всем', store: 'Магазин', group: 'Группа', device_type: 'Тип устройства', pc: 'ПК' };
        const label = names[c.target_type] || c.target_type;
        return c.target_id ? label + ' #' + c.target_id : label;
    }

    function describeCommand(c) {
        try {
            const p = JSON.parse(c.payload);
            const actions = { start: 'запустить', stop: 'остановить', restart: 'перезапустить' };
            return (actions[p.action] || p.action) + ' службу «' + p.service_name + '»';
        } catch (e) {
            return c.type;
        }
    }

    async function loadCommands() {
        const rows = await Api.get('/admin/commands');
        const tbody = document.querySelector('#commandsTable tbody');
        tbody.innerHTML = '';
        rows.forEach(function (c) {
            const tr = document.createElement('tr');
            tr.innerHTML =
                '<td>' + escapeHtml(c.created_at) + '</td>' +
                '<td>' + escapeHtml(describeCommand(c)) + '</td>' +
                '<td>' + escapeHtml(describeTarget(c)) + '</td>' +
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
        document.getElementById('detail').style.display = '';
        document.getElementById('detailTitle').textContent = 'Результаты команды #' + id;

        const tbody = document.querySelector('#resultsTable tbody');
        tbody.innerHTML = '';
        if (results.length === 0) {
            tbody.innerHTML = '<tr><td colspan="6" class="muted">Пока ни один ПК не опросил сервер с момента отправки.</td></tr>';
            return;
        }
        results.forEach(function (r) {
            const tr = document.createElement('tr');
            tr.innerHTML =
                '<td>' + escapeHtml(r.store_name) + '</td>' +
                '<td>' + escapeHtml(r.display_name || r.hostname) + '</td>' +
                '<td>' + escapeHtml(r.status) + '</td>' +
                '<td>' + escapeHtml(r.output || '—') + '</td>' +
                '<td>' + escapeHtml(r.claimed_at) + '</td>' +
                '<td>' + escapeHtml(r.executed_at || '—') + '</td>';
            tbody.appendChild(tr);
        });
    });

    await loadCommands();
})();
