(async function () {
    const me = await requireAdminAuth();
    const canEdit = me.role === 'administrator' || me.role === 'superadmin';

    const $ = Ui.$, esc = Ui.escapeHtml;
    const searchEl = $('search'), storeEl = $('storeFilter'), deviceTypeEl = $('deviceTypeFilter'), stateEl = $('stateFilter');
    const tbody = document.querySelector('#pcsTable tbody');

    let stores = [], deviceTypes = [], pcs = [];

    if (canEdit) $('adminActions').hidden = false;

    function debounce(fn, ms) {
        let t;
        return function () { clearTimeout(t); t = setTimeout(fn, ms); };
    }

    function fillSelect(select, items, labelFn, withEmpty) {
        select.innerHTML = withEmpty ? '<option value="">' + withEmpty + '</option>' : '';
        items.forEach(function (item) {
            const opt = document.createElement('option');
            opt.value = item.id;
            opt.textContent = labelFn(item);
            select.appendChild(opt);
        });
    }

    const storeLabel = function (s) { return s.name + (s.is_pilot ? ' (пилот)' : ''); };
    const typeLabel = function (d) { return d.name; };

    async function loadFilters() {
        stores = await Api.get('/admin/stores');
        deviceTypes = await Api.get('/admin/device-types');
        fillSelect(storeEl, stores, storeLabel, 'Все магазины');
        fillSelect(deviceTypeEl, deviceTypes, typeLabel, 'Все типы');
        fillSelect($('pcStoreId'), stores, storeLabel);
        fillSelect($('bulkStoreId'), stores, storeLabel);
        fillSelect($('pcDeviceTypeId'), deviceTypes, typeLabel);
        fillSelect($('bulkDeviceTypeId'), deviceTypes, typeLabel);
        $('statStores').textContent = stores.length;
    }

    // ---- Конфиг ПК ------------------------------------------------------------------

    // Готовый config.json — server_url берём из адреса, по которому открыта панель:
    // это и есть реально работающий адрес сервера с точки зрения сети магазина.
    function buildConfigText(token) {
        return JSON.stringify({
            server_url: window.location.origin,
            agent_token: token,
            poll_interval_seconds: 30,
            log_level: 'debug',
            proxy_url: '', proxy_username: '', proxy_password: '',
            download_limit_kbps: 0,
        }, null, 4);
    }

    function showConfig(pc, token) {
        Ui.modal({
            title: 'config.json для ' + (pc.display_name || pc.hostname),
            body: '<p>Положите этот файл рядом с агентами на кассе (<code>C:\\AMadmin\\config.json</code>). Ключ внутри — как пароль.</p>' +
                '<textarea class="config" id="cfgText" readonly>' + esc(buildConfigText(token)) + '</textarea>',
            buttons: [
                { label: 'Скачать', value: 'download' },
                { label: 'Скопировать', value: 'copy', kind: 'primary' },
            ],
        }).then(function (v) {
            if (v === 'copy') {
                navigator.clipboard.writeText(buildConfigText(token)).then(function () { Ui.toast('Скопировано в буфер обмена', 'success'); });
            }
            if (v === 'download') {
                const a = document.createElement('a');
                a.href = 'data:application/json;charset=utf-8,' + encodeURIComponent(buildConfigText(token));
                a.download = 'config.json';
                a.click();
            }
        });
    }

    // ---- Редактирование ПК ---------------------------------------------------------

    function editPc(pc) {
        const storeOpts = stores.map(function (s) {
            return '<option value="' + s.id + '"' + (s.id == pc.store_id ? ' selected' : '') + '>' + esc(storeLabel(s)) + '</option>';
        }).join('');
        const typeOpts = deviceTypes.map(function (d) {
            return '<option value="' + d.id + '"' + (d.id == pc.device_type_id ? ' selected' : '') + '>' + esc(d.name) + '</option>';
        }).join('');

        return Ui.modal({
            title: 'ПК ' + pc.hostname,
            body:
                '<label>Понятное имя<span class="hint">Пусто — будет показываться hostname.</span>' +
                '<input type="text" id="edName" value="' + esc(pc.display_name || '') + '"></label>' +
                '<div class="row"><label>Магазин<select id="edStore">' + storeOpts + '</select></label>' +
                '<label>Тип устройства<select id="edType">' + typeOpts + '</select></label></div>' +
                '<p class="muted">Hostname (' + esc(pc.hostname) + ') агент сообщает сам при каждом опросе — его руками не меняют.</p>' +
                '<p class="error modal-error"></p>',
            buttons: [{ label: 'Отмена', value: null }, { label: 'Сохранить', value: 'submit', kind: 'primary' }],
            onSubmit: async function (root) {
                await Api.request('PUT', '/admin/pcs/' + pc.id, {
                    display_name: root.querySelector('#edName').value,
                    store_id: root.querySelector('#edStore').value,
                    device_type_id: root.querySelector('#edType').value,
                });
            },
        }).then(function (v) {
            if (v) { Ui.toast('Сохранено', 'success'); loadPcs(); }
        });
    }

    async function regenerateToken(pc) {
        const ok = await Ui.confirm('Выпустить новый ключ для ' + pc.hostname + '? Старый перестанет работать сразу — на кассе нужно будет заменить config.json.', { danger: true, okLabel: 'Выпустить' });
        if (!ok) return;
        try {
            const r = await Api.post('/admin/pcs/' + pc.id + '/token');
            Ui.toast('Ключ перевыпущен', 'success');
            await loadPcs();
            showConfig(pc, r.agent_token);
        } catch (err) {
            Ui.toast('Не удалось: ' + Ui.reason(err), 'error');
        }
    }

    async function deletePc(pc) {
        const ok = await Ui.confirm('Удалить ' + pc.hostname + ' из системы вместе с историей подтверждений и результатов? Агент на кассе перестанет приниматься сервером.', { danger: true, okLabel: 'Удалить' });
        if (!ok) return;
        try {
            await Api.request('DELETE', '/admin/pcs/' + pc.id);
            Ui.toast('ПК удалён', 'success');
            await loadPcs();
        } catch (err) {
            Ui.toast('Не удалось: ' + Ui.reason(err), 'error');
        }
    }

    // ---- Список ---------------------------------------------------------------------

    function params() {
        const p = new URLSearchParams();
        if (searchEl.value) p.set('search', searchEl.value);
        if (storeEl.value) p.set('store_id', storeEl.value);
        if (deviceTypeEl.value) p.set('device_type_id', deviceTypeEl.value);
        return p;
    }

    async function loadPcs() {
        pcs = await Api.get('/admin/pcs?' + params().toString());

        const online = pcs.filter(function (p) { return p.online; }).length;
        $('statTotal').textContent = pcs.length;
        $('statOnline').textContent = online;
        $('statOffline').textContent = pcs.length - online;

        const visible = pcs.filter(function (p) {
            return !stateEl.value || (stateEl.value === 'online') === !!p.online;
        });

        tbody.innerHTML = '';
        if (!visible.length) {
            tbody.innerHTML = '<tr><td colspan="7" class="empty">Ничего не найдено. ' + (canEdit ? 'Добавьте ПК кнопкой справа сверху.' : '') + '</td></tr>';
            return;
        }

        visible.forEach(function (pc) {
            const host = pc.display_name
                ? '<b>' + esc(pc.display_name) + '</b><div class="muted">' + esc(pc.hostname) + (pc.username ? ' \\ ' + esc(pc.username) : '') + '</div>'
                : '<b>' + esc(pc.hostname) + '</b>' + (pc.username ? '<div class="muted">' + esc(pc.username) + '</div>' : '');

            const tr = document.createElement('tr');
            tr.dataset.id = pc.id;
            tr.innerHTML =
                '<td><span class="badge ' + (pc.online ? 'badge-online' : 'badge-offline') + '">' + (pc.online ? 'онлайн' : 'офлайн') + '</span></td>' +
                '<td>' + host + '</td>' +
                '<td>' + esc(pc.store_name) + '</td>' +
                '<td>' + esc(pc.device_type_name) + '</td>' +
                '<td>' + esc(pc.agent_version || '—') + '</td>' +
                '<td class="muted">' + (pc.last_seen ? esc(formatServerTime(pc.last_seen)) : 'никогда') + '</td>' +
                '<td><div class="actions" style="flex-wrap:nowrap">' +
                    (pc.agent_token ? '<button type="button" data-act="config">Конфиг</button>' : '') +
                    (canEdit ? '<button type="button" data-act="more" title="Ещё действия">⋯</button>' : '') +
                '</div></td>';
            tbody.appendChild(tr);
        });
    }

    tbody.addEventListener('click', async function (e) {
        const btn = e.target.closest('button[data-act]');
        if (!btn) return;
        const pc = pcs.find(function (p) { return String(p.id) === btn.closest('tr').dataset.id; });
        if (!pc) return;
        let act = btn.getAttribute('data-act');
        if (act === 'more') {
            act = await Ui.menu(btn, [
                { label: 'Изменить…', value: 'edit' },
                { label: 'Выпустить новый ключ', value: 'token' },
                { label: 'Удалить', value: 'delete', danger: true },
            ]);
            if (!act) return;
        }
        if (act === 'config') showConfig(pc, pc.agent_token);
        if (act === 'edit') editPc(pc);
        if (act === 'token') regenerateToken(pc);
        if (act === 'delete') deletePc(pc);
    });

    // ---- Добавление ------------------------------------------------------------------

    $('addPcBtn').addEventListener('click', function () {
        $('addPanel').hidden = !$('addPanel').hidden;
        if (!$('addPanel').hidden) $('pcHostname').focus();
    });
    document.querySelectorAll('[data-close-add]').forEach(function (b) {
        b.addEventListener('click', function () { $('addPanel').hidden = true; });
    });
    document.querySelectorAll('#addPanel .tabs button').forEach(function (b) {
        b.addEventListener('click', function () {
            document.querySelectorAll('#addPanel .tabs button').forEach(function (x) { x.classList.toggle('active', x === b); });
            document.querySelectorAll('#addPanel .tab-panel').forEach(function (p) { p.hidden = p.dataset.panel !== b.dataset.tab; });
        });
    });

    $('createPcForm').addEventListener('submit', async function (e) {
        e.preventDefault();
        try {
            const r = await Api.post('/admin/pcs', {
                store_id: $('pcStoreId').value, device_type_id: $('pcDeviceTypeId').value,
                hostname: $('pcHostname').value, display_name: $('pcDisplayName').value,
            });
            const hostname = $('pcHostname').value;
            $('createPcForm').reset();
            $('addPanel').hidden = true;
            Ui.toast('ПК ' + hostname + ' создан', 'success');
            await loadPcs();
            showConfig({ hostname: hostname }, r.agent_token);
        } catch (err) {
            Ui.toast('Не удалось создать ПК: ' + Ui.reason(err, { store_id_device_type_id_hostname_required: 'заполните все поля' }), 'error');
        }
    });

    $('bulkPcForm').addEventListener('submit', async function (e) {
        e.preventDefault();
        try {
            const r = await Api.post('/admin/pcs/bulk', {
                store_id: $('bulkStoreId').value, device_type_id: $('bulkDeviceTypeId').value, hostnames: $('bulkHostnames').value,
            });
            let text = 'Создано: ' + r.created.length;
            if (r.skipped.length) text += ', пропущено (уже были): ' + r.skipped.join(', ');
            Ui.toast(text, 'success');
            $('bulkPcForm').reset();
            $('addPanel').hidden = true;
            await loadPcs();
        } catch (err) {
            Ui.toast('Не удалось: ' + Ui.reason(err, { hostnames_required: 'список пуст' }), 'error');
        }
    });

    // Выгрузка архива — обычная ссылка на скачивание с теми же фильтрами, что в списке.
    $('exportConfigsBtn').addEventListener('click', function () {
        const p = params();
        p.set('server_url', window.location.origin);
        window.location.href = '/admin/pcs/configs.zip?' + p.toString();
    });

    searchEl.addEventListener('input', debounce(loadPcs, 300));
    storeEl.addEventListener('change', loadPcs);
    deviceTypeEl.addEventListener('change', loadPcs);
    stateEl.addEventListener('change', loadPcs);

    await loadFilters();
    await loadPcs();
    // Дашборд живёт открытым — обновляем статусы сами, без F5.
    setInterval(loadPcs, 30000);
})();
