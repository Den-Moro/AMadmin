// Страница «Хосты». Порядок работы:
//   1. requireAdminAuth — кто мы и что нам можно (администратор видит ключи и действия).
//   2. loadFilters — справочники для выпадающих списков (магазины, типы, группы).
//   3. loadPcs — список с сервера по серверным фильтрам (магазин/тип/группа/статус/поиск),
//      затем клиентские: версия агента, сортировка, страницы. Кнопка «Обновить» и
//      таймер раз в 30 с вызывают то же самое.
//   4. Массовые действия работают по отмеченным строкам (id хранятся в selected).
(async function () {
    const me = await requireAdminAuth();
    const canEdit = me.role === 'administrator' || me.role === 'superadmin';
    const $ = Ui.$, esc = Ui.escapeHtml;

    const PAGE_SIZE = 50;
    let stores = [], deviceTypes = [], groups = [];
    let pcs = [];                 // то, что вернул сервер по текущим фильтрам
    let page = 0;
    const selected = new Set();   // id отмеченных ПК
    let lastRefresh = null;

    if (canEdit) $('adminActions').hidden = false;

    // ---- Справочники --------------------------------------------------------------------

    function fillSelect(select, items, labelFn, emptyLabel) {
        select.innerHTML = emptyLabel ? '<option value="">' + emptyLabel + '</option>' : '';
        items.forEach(function (item) {
            const opt = document.createElement('option');
            opt.value = item.id;
            opt.textContent = labelFn(item);
            select.appendChild(opt);
        });
    }
    const storeLabel = function (s) { return s.name + (s.is_pilot ? ' (пилот)' : ''); };
    const nameLabel = function (x) { return x.name; };

    async function loadFilters() {
        stores = await Api.get('/admin/stores');
        deviceTypes = await Api.get('/admin/device-types');
        groups = await Api.get('/admin/host-groups');
        fillSelect($('storeFilter'), stores, storeLabel, 'Все магазины');
        fillSelect($('deviceTypeFilter'), deviceTypes, nameLabel, 'Все типы');
        fillSelect($('groupFilter'), groups, nameLabel, 'Все группы');
        fillSelect($('pcStoreId'), stores, storeLabel);
        fillSelect($('bulkStoreId'), stores, storeLabel);
        fillSelect($('pcDeviceTypeId'), deviceTypes, nameLabel);
        fillSelect($('bulkDeviceTypeId'), deviceTypes, nameLabel);

        // Фильтры из адресной строки (ссылки с дашборда: ?state=silent, ?store_id=3).
        const q = new URLSearchParams(window.location.search);
        ['store_id', 'device_type_id', 'group_id', 'state', 'search'].forEach(function (k) {
            const el = { store_id: 'storeFilter', device_type_id: 'deviceTypeFilter', group_id: 'groupFilter', state: 'stateFilter', search: 'search' }[k];
            if (q.get(k)) $(el).value = q.get(k);
        });
    }

    // ---- Список ------------------------------------------------------------------------

    function serverParams() {
        const p = new URLSearchParams();
        if ($('search').value) p.set('search', $('search').value);
        if ($('storeFilter').value) p.set('store_id', $('storeFilter').value);
        if ($('deviceTypeFilter').value) p.set('device_type_id', $('deviceTypeFilter').value);
        if ($('groupFilter').value) p.set('group_id', $('groupFilter').value);
        if ($('stateFilter').value) p.set('state', $('stateFilter').value);
        return p;
    }

    function visibleRows() {
        const v = $('versionFilter').value;
        let rows = pcs.filter(function (p) { return !v || (p.agent_version || '—') === v; });
        rows.sort(function (a, b) {
            return Ui.compareBy(a, b, sort, sort.key === 'online' ? { map: function (p) { return p.online ? 1 : 0; } } : null);
        });
        return rows;
    }

    function render() {
        const rows = visibleRows();
        const pages = Math.max(1, Math.ceil(rows.length / PAGE_SIZE));
        if (page >= pages) page = pages - 1;
        const slice = rows.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE);
        const tbody = document.querySelector('#pcsTable tbody');
        tbody.innerHTML = '';

        if (!slice.length) {
            tbody.innerHTML = '<tr><td colspan="10" class="empty">Ничего не найдено.' + (canEdit && !pcs.length ? ' Добавьте ПК кнопкой справа сверху.' : '') + '</td></tr>';
        }
        slice.forEach(function (pc) {
            const tr = document.createElement('tr');
            tr.dataset.id = pc.id;
            const name = pc.display_name || pc.hostname;
            tr.innerHTML =
                '<td class="check"><input type="checkbox" data-select' + (selected.has(pc.id) ? ' checked' : '') + '></td>' +
                '<td><span class="badge ' + (pc.online ? 'badge-online' : 'badge-offline') + '">' + (pc.online ? 'онлайн' : 'офлайн') + '</span></td>' +
                '<td><a class="host-link" href="/admin/hosts/host.html?id=' + pc.id + '">' + esc(name) + '</a>' +
                    (pc.display_name ? '<div class="muted">' + esc(pc.hostname) + '</div>' : '') +
                    (pc.username ? '<div class="muted">' + esc(pc.username) + '</div>' : '') + '</td>' +
                '<td>' + esc(pc.store_name) + '</td>' +
                '<td class="muted">' + (pc.last_ip ? '<span class="ip-copy" data-ip="' + esc(pc.last_ip) + '" title="Скопировать IP">' + esc(pc.last_ip) + '</span>' : '—') + '</td>' +
                '<td>' + esc(pc.device_type_name) + '</td>' +
                '<td class="muted">' + esc(pc.groups || '—') + '</td>' +
                '<td>' + esc(pc.agent_version || '—') + '</td>' +
                '<td class="muted" style="white-space:nowrap">' + (pc.last_seen ? esc(formatServerTime(pc.last_seen)) : 'никогда') + '</td>' +
                '<td><div class="actions" style="flex-wrap:nowrap">' +
                    (pc.agent_token ? '<button type="button" data-act="config">Конфиг</button>' : '') +
                    (canEdit ? '<button type="button" data-act="more" title="Ещё действия">⋯</button>' : '') +
                '</div></td>';
            tbody.appendChild(tr);
        });

        $('pageInfo').textContent = rows.length ? ('строки ' + (page * PAGE_SIZE + 1) + '–' + Math.min(rows.length, (page + 1) * PAGE_SIZE) + ' из ' + rows.length) : '';
        $('prevBtn').disabled = page === 0;
        $('nextBtn').disabled = page >= pages - 1;
        $('checkAll').checked = slice.length > 0 && slice.every(function (p) { return selected.has(p.id); });
        updateBulkBar();
    }

    async function loadPcs() {
        pcs = await Api.get('/admin/pcs?' + serverParams().toString());
        // Версии агента — из фактического списка, а не из справочника: их никто не заводит.
        const versions = [...new Set(pcs.map(function (p) { return p.agent_version || '—'; }))].sort();
        const cur = $('versionFilter').value;
        $('versionFilter').innerHTML = '<option value="">Любая версия агента</option>' +
            versions.map(function (v) { return '<option value="' + esc(v) + '">' + (v === '—' ? 'агент ещё не отчитался' : 'v' + esc(v)) + '</option>'; }).join('');
        $('versionFilter').value = cur;
        // Отметки на удалённых/отфильтрованных ПК не держим.
        const ids = new Set(pcs.map(function (p) { return p.id; }));
        selected.forEach(function (id) { if (!ids.has(id)) selected.delete(id); });
        lastRefresh = new Date();
        render();
        tickRefreshed();
    }

    function tickRefreshed() {
        if (!lastRefresh) return;
        const sec = Math.round((Date.now() - lastRefresh) / 1000);
        $('refreshed').textContent = 'обновлено ' + (sec < 5 ? 'только что' : sec + ' с назад');
    }
    setInterval(tickRefreshed, 5000);

    $('refreshBtn').addEventListener('click', async function () {
        $('refreshBtn').disabled = true;
        $('refreshBtn').textContent = '↻ Обновляю…';
        try { await loadPcs(); Ui.toast('Статусы обновлены', 'success'); }
        finally { $('refreshBtn').disabled = false; $('refreshBtn').textContent = '↻ Обновить'; }
    });

    // ---- Сортировка, страницы, фильтры -----------------------------------------------

    const sort = Ui.makeSortable(document.querySelector('#pcsTable'), { key: 'last_seen', dir: 'desc' }, render);
    $('prevBtn').addEventListener('click', function () { page--; render(); });
    $('nextBtn').addEventListener('click', function () { page++; render(); });

    let t;
    $('search').addEventListener('input', function () { clearTimeout(t); t = setTimeout(function () { page = 0; loadPcs(); }, 300); });
    ['storeFilter', 'deviceTypeFilter', 'groupFilter', 'stateFilter'].forEach(function (id) {
        $(id).addEventListener('change', function () { page = 0; loadPcs(); });
    });
    $('versionFilter').addEventListener('change', function () { page = 0; render(); });

    // ---- Отметки и массовые действия --------------------------------------------------

    function updateBulkBar() {
        $('bulkCount').textContent = selected.size;
        $('bulkBar').classList.toggle('show', selected.size > 0 && canEdit);
    }

    document.querySelector('#pcsTable tbody').addEventListener('change', function (e) {
        if (!e.target.matches('input[data-select]')) return;
        const id = parseInt(e.target.closest('tr').dataset.id, 10);
        if (e.target.checked) selected.add(id); else selected.delete(id);
        updateBulkBar();
    });
    $('checkAll').addEventListener('change', function () {
        document.querySelectorAll('#pcsTable tbody tr[data-id]').forEach(function (tr) {
            const id = parseInt(tr.dataset.id, 10);
            tr.querySelector('input[data-select]').checked = $('checkAll').checked;
            if ($('checkAll').checked) selected.add(id); else selected.delete(id);
        });
        updateBulkBar();
    });

    $('bulkBar').addEventListener('click', async function (e) {
        const btn = e.target.closest('button[data-bulk]');
        if (!btn) return;
        const ids = [...selected];
        if (btn.dataset.bulk === 'clear') { selected.clear(); render(); return; }
        if (btn.dataset.bulk === 'export') {
            window.location.href = '/admin/pcs/configs.zip?ids=' + ids.join(',') + '&server_url=' + encodeURIComponent(window.location.origin);
            return;
        }
        if (btn.dataset.bulk === 'group') {
            if (!groups.length) { Ui.toast('Сначала создайте группу на странице «Группы»', 'error'); return; }
            const picked = await Ui.modal({
                title: 'Добавить ' + ids.length + ' ПК в группу',
                body: '<label>Группа<select id="bulkGroup">' + groups.map(function (g) { return '<option value="' + g.id + '">' + esc(g.name) + '</option>'; }).join('') + '</select></label>',
                buttons: [{ label: 'Отмена', value: null }, { label: 'Добавить', value: 'submit', kind: 'primary' }],
                onSubmit: async function (root) {
                    const gid = root.querySelector('#bulkGroup').value;
                    await Api.post('/admin/host-groups/' + gid + '/members', { pc_ids: ids });
                    return gid;
                },
            });
            if (picked) { Ui.toast('Добавлено в группу: ' + ids.length, 'success'); selected.clear(); await loadPcs(); }
            return;
        }
        if (btn.dataset.bulk === 'delete') {
            if (!await Ui.confirm('Удалить ' + ids.length + ' ПК вместе с историей? Агенты на них перестанут приниматься сервером.', { danger: true, okLabel: 'Удалить ' + ids.length })) return;
            let ok = 0;
            for (const id of ids) {
                try { await Api.request('DELETE', '/admin/pcs/' + id); ok++; } catch (err) { /* считаем ниже */ }
            }
            Ui.toast('Удалено: ' + ok + (ok < ids.length ? ', не удалось: ' + (ids.length - ok) : ''), ok < ids.length ? 'error' : 'success');
            selected.clear();
            await loadPcs();
        }
    });

    // ---- Действия в строке (конфиг / изменить / ключ / удалить) ------------------------

    function buildConfigText(token) {
        return JSON.stringify({
            server_url: window.location.origin, agent_token: token, poll_interval_seconds: 30, log_level: 'debug',
            proxy_url: '', proxy_username: '', proxy_password: '', download_limit_kbps: 0,
        }, null, 4);
    }

    function showConfig(pc, token) {
        Ui.modal({
            title: 'config.json для ' + (pc.display_name || pc.hostname),
            body: '<p>Положите этот файл рядом с агентами на кассе (<code>C:\\AMadmin\\config.json</code>). Ключ внутри — как пароль.</p>' +
                '<textarea class="config" readonly>' + esc(buildConfigText(token)) + '</textarea>',
            buttons: [{ label: 'Скачать', value: 'download' }, { label: 'Скопировать', value: 'copy', kind: 'primary' }],
        }).then(function (v) {
            if (v === 'copy') navigator.clipboard.writeText(buildConfigText(token)).then(function () { Ui.toast('Скопировано', 'success'); });
            if (v === 'download') {
                const a = document.createElement('a');
                a.href = 'data:application/json;charset=utf-8,' + encodeURIComponent(buildConfigText(token));
                a.download = 'config.json';
                a.click();
            }
        });
    }

    function editPc(pc) {
        const opts = function (items, cur, labelFn) {
            return items.map(function (i) { return '<option value="' + i.id + '"' + (i.id == cur ? ' selected' : '') + '>' + esc(labelFn(i)) + '</option>'; }).join('');
        };
        return Ui.modal({
            title: 'ПК ' + pc.hostname,
            body: '<label>Понятное имя<span class="hint">Пусто — будет показываться hostname.</span><input type="text" id="edName" value="' + esc(pc.display_name || '') + '"></label>' +
                '<div class="row"><label>Магазин<select id="edStore">' + opts(stores, pc.store_id, storeLabel) + '</select></label>' +
                '<label>Тип устройства<select id="edType">' + opts(deviceTypes, pc.device_type_id, nameLabel) + '</select></label></div>' +
                '<p class="error modal-error"></p>',
            buttons: [{ label: 'Отмена', value: null }, { label: 'Сохранить', value: 'submit', kind: 'primary' }],
            onSubmit: async function (root) {
                await Api.request('PUT', '/admin/pcs/' + pc.id, {
                    display_name: root.querySelector('#edName').value, store_id: root.querySelector('#edStore').value, device_type_id: root.querySelector('#edType').value,
                });
            },
        }).then(function (v) { if (v) { Ui.toast('Сохранено', 'success'); loadPcs(); } });
    }

    document.querySelector('#pcsTable tbody').addEventListener('click', async function (e) {
        const ip = e.target.closest('.ip-copy');
        if (ip) { navigator.clipboard.writeText(ip.dataset.ip).then(function () { Ui.toast('IP скопирован: ' + ip.dataset.ip, 'success'); }); return; }

        const btn = e.target.closest('button[data-act]');
        if (!btn) return;
        const pc = pcs.find(function (p) { return String(p.id) === btn.closest('tr').dataset.id; });
        let act = btn.dataset.act;
        if (act === 'more') {
            act = await Ui.menu(btn, [
                { label: 'Открыть профиль', value: 'open' },
                { label: 'Изменить…', value: 'edit' },
                { label: 'Выпустить новый ключ', value: 'token' },
                { label: 'Удалить', value: 'delete', danger: true },
            ]);
            if (!act) return;
        }
        if (act === 'open') window.location.href = '/admin/hosts/host.html?id=' + pc.id;
        if (act === 'config') showConfig(pc, pc.agent_token);
        if (act === 'edit') editPc(pc);
        if (act === 'token') {
            if (!await Ui.confirm('Выпустить новый ключ для ' + pc.hostname + '? Старый перестанет работать сразу.', { danger: true, okLabel: 'Выпустить' })) return;
            try { const r = await Api.post('/admin/pcs/' + pc.id + '/token'); await loadPcs(); showConfig(pc, r.agent_token); }
            catch (err) { Ui.toast('Не удалось: ' + Ui.reason(err), 'error'); }
        }
        if (act === 'delete') {
            if (!await Ui.confirm('Удалить ' + pc.hostname + ' вместе с историей?', { danger: true, okLabel: 'Удалить' })) return;
            try { await Api.request('DELETE', '/admin/pcs/' + pc.id); Ui.toast('ПК удалён', 'success'); await loadPcs(); }
            catch (err) { Ui.toast('Не удалось: ' + Ui.reason(err), 'error'); }
        }
    });

    // ---- Добавление и выгрузка -----------------------------------------------------------

    $('addPcBtn').addEventListener('click', function () { $('addPanel').hidden = !$('addPanel').hidden; if (!$('addPanel').hidden) $('pcHostname').focus(); });
    document.querySelectorAll('[data-close-add]').forEach(function (b) { b.addEventListener('click', function () { $('addPanel').hidden = true; }); });
    document.querySelectorAll('#addPanel .tabs button').forEach(function (b) {
        b.addEventListener('click', function () {
            document.querySelectorAll('#addPanel .tabs button').forEach(function (x) { x.classList.toggle('active', x === b); });
            document.querySelectorAll('#addPanel .tab-panel').forEach(function (p) { p.hidden = p.dataset.panel !== b.dataset.tab; });
        });
    });

    $('createPcForm').addEventListener('submit', async function (e) {
        e.preventDefault();
        try {
            const hostname = $('pcHostname').value;
            const r = await Api.post('/admin/pcs', { store_id: $('pcStoreId').value, device_type_id: $('pcDeviceTypeId').value, hostname: hostname, display_name: $('pcDisplayName').value });
            $('createPcForm').reset();
            $('addPanel').hidden = true;
            Ui.toast('ПК ' + hostname + ' создан', 'success');
            await loadPcs();
            showConfig({ hostname: hostname }, r.agent_token);
        } catch (err) { Ui.toast('Не удалось создать: ' + Ui.reason(err, { store_id_device_type_id_hostname_required: 'заполните все поля' }), 'error'); }
    });

    $('bulkPcForm').addEventListener('submit', async function (e) {
        e.preventDefault();
        try {
            const r = await Api.post('/admin/pcs/bulk', { store_id: $('bulkStoreId').value, device_type_id: $('bulkDeviceTypeId').value, hostnames: $('bulkHostnames').value });
            Ui.toast('Создано: ' + r.created.length + (r.skipped.length ? ', пропущено: ' + r.skipped.join(', ') : ''), 'success');
            $('bulkPcForm').reset();
            $('addPanel').hidden = true;
            await loadPcs();
        } catch (err) { Ui.toast('Не удалось: ' + Ui.reason(err, { hostnames_required: 'список пуст' }), 'error'); }
    });

    $('exportConfigsBtn').addEventListener('click', function () {
        const p = serverParams();
        p.set('server_url', window.location.origin);
        window.location.href = '/admin/pcs/configs.zip?' + p.toString();
    });

    await loadFilters();
    await loadPcs();
    setInterval(function () { if (!document.hidden) loadPcs(); }, 30000);
})();
