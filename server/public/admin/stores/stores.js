(async function () {
    const me = await requireAdminAuth();
    const canEdit = me.role === 'administrator' || me.role === 'superadmin';
    const $ = Ui.$, esc = Ui.escapeHtml;

    if (canEdit) document.querySelectorAll('[data-admin]').forEach(function (b) { b.hidden = false; });

    // Вкладки
    document.querySelectorAll('.tabs button').forEach(function (b) {
        b.addEventListener('click', function () {
            document.querySelectorAll('.tabs button').forEach(function (x) { x.classList.toggle('active', x === b); });
            document.querySelectorAll('.tab-panel').forEach(function (p) { p.hidden = p.dataset.panel !== b.dataset.tab; });
        });
    });

    let stores = [];

    // ---- Магазины ---------------------------------------------------------------------

    function storeForm(store) {
        return Ui.modal({
            title: store ? 'Магазин «' + store.name + '»' : 'Новый магазин',
            body:
                '<label>Название<input type="text" id="stName" value="' + esc(store ? store.name : '') + '" placeholder="например, Магазин №12 (Ленина, 5)"></label>' +
                '<label><input type="checkbox" id="stPilot"' + (store && store.is_pilot ? ' checked' : '') + '> Пилотный магазин' +
                '<span class="hint">Сюда можно отправлять новое раньше остальных, чтобы обкатать.</span></label>' +
                '<label>Свой бренд в оповещениях<input type="text" id="stBrandName" value="' + esc(store && store.brand_name || '') + '" placeholder="пусто — общий из Настроек"></label>' +
                '<label>Свой контакт в оповещениях<input type="text" id="stBrandContact" value="' + esc(store && store.brand_contact || '') + '" placeholder="пусто — общий из Настроек"></label>' +
                '<p class="error modal-error"></p>',
            buttons: [{ label: 'Отмена', value: null }, { label: store ? 'Сохранить' : 'Создать', value: 'submit', kind: 'primary' }],
            onSubmit: async function (root) {
                const body = {
                    name: root.querySelector('#stName').value.trim(), is_pilot: root.querySelector('#stPilot').checked ? 1 : 0,
                    brand_name: root.querySelector('#stBrandName').value.trim(), brand_contact: root.querySelector('#stBrandContact').value.trim(),
                };
                if (!body.name) { root.querySelector('.modal-error').textContent = 'Введите название.'; return false; }
                if (store) await Api.request('PUT', '/admin/stores/' + store.id, body);
                else await Api.post('/admin/stores', body);
            },
        }).then(function (v) { if (v) { Ui.toast('Сохранено', 'success'); loadStores(); } });
    }

    async function loadStores() {
        stores = await Api.get('/admin/stores');
        const q = $('storeSearch').value.toLowerCase();
        const tbody = document.querySelector('#storesTable tbody');
        tbody.innerHTML = '';
        const visible = stores.filter(function (s) { return !q || s.name.toLowerCase().indexOf(q) >= 0; });
        if (!visible.length) {
            tbody.innerHTML = '<tr><td colspan="4" class="empty">Магазинов пока нет' + (canEdit ? ' — добавьте первый.' : '.') + '</td></tr>';
            return;
        }
        visible.forEach(function (s) {
            const tr = document.createElement('tr');
            tr.dataset.id = s.id;
            tr.innerHTML =
                '<td><b>' + esc(s.name) + '</b></td>' +
                '<td>' + (s.is_pilot ? '<span class="badge badge-accent">пилот</span>' : '<span class="muted">—</span>') + '</td>' +
                '<td class="num">' + s.pc_count + '</td>' +
                '<td><div class="actions">' + (canEdit ?
                    '<button type="button" data-act="edit">Изменить</button>' +
                    '<button type="button" data-act="delete" class="danger"' + (s.pc_count > 0 ? ' disabled title="Сначала переведите ПК в другой магазин"' : '') + '>Удалить</button>' : '') +
                '</div></td>';
            tbody.appendChild(tr);
        });
    }

    document.querySelector('#storesTable').addEventListener('click', async function (e) {
        const btn = e.target.closest('button[data-act]');
        if (!btn) return;
        const s = stores.find(function (x) { return String(x.id) === btn.closest('tr').dataset.id; });
        if (btn.dataset.act === 'edit') storeForm(s);
        if (btn.dataset.act === 'delete') {
            if (!await Ui.confirm('Удалить магазин «' + s.name + '»?', { danger: true, okLabel: 'Удалить' })) return;
            try { await Api.request('DELETE', '/admin/stores/' + s.id); Ui.toast('Магазин удалён', 'success'); loadStores(); }
            catch (err) { Ui.toast('Не удалось: ' + Ui.reason(err), 'error'); }
        }
    });

    $('addStoreBtn').addEventListener('click', function () { storeForm(null); });
    $('storeSearch').addEventListener('input', loadStores);

    // ---- Типы устройств ---------------------------------------------------------------

    let types = [];

    function typeForm(t) {
        return Ui.prompt('Название типа', {
            title: t ? 'Тип устройства' : 'Новый тип устройства',
            value: t ? t.name : '',
            okLabel: t ? 'Сохранить' : 'Создать',
            validate: function (v) { return v.trim() ? null : 'Введите название.'; },
        }).then(async function (name) {
            if (name === null) return;
            try {
                if (t) await Api.request('PUT', '/admin/device-types/' + t.id, { name: name.trim() });
                else await Api.post('/admin/device-types', { name: name.trim() });
                Ui.toast('Сохранено', 'success');
                loadTypes();
            } catch (err) { Ui.toast('Не удалось: ' + Ui.reason(err), 'error'); }
        });
    }

    async function loadTypes() {
        types = await Api.get('/admin/device-types');
        const tbody = document.querySelector('#typesTable tbody');
        tbody.innerHTML = '';
        types.forEach(function (t) {
            const tr = document.createElement('tr');
            tr.dataset.id = t.id;
            tr.innerHTML =
                '<td><b>' + esc(t.name) + '</b></td>' +
                '<td class="num">' + t.pc_count + '</td>' +
                '<td><div class="actions">' + (canEdit ?
                    '<button type="button" data-act="edit">Переименовать</button>' +
                    '<button type="button" data-act="delete" class="danger"' + (t.pc_count > 0 ? ' disabled title="Сначала переведите ПК на другой тип"' : '') + '>Удалить</button>' : '') +
                '</div></td>';
            tbody.appendChild(tr);
        });
    }

    document.querySelector('#typesTable').addEventListener('click', async function (e) {
        const btn = e.target.closest('button[data-act]');
        if (!btn) return;
        const t = types.find(function (x) { return String(x.id) === btn.closest('tr').dataset.id; });
        if (btn.dataset.act === 'edit') typeForm(t);
        if (btn.dataset.act === 'delete') {
            if (!await Ui.confirm('Удалить тип «' + t.name + '»?', { danger: true, okLabel: 'Удалить' })) return;
            try { await Api.request('DELETE', '/admin/device-types/' + t.id); Ui.toast('Удалено', 'success'); loadTypes(); }
            catch (err) { Ui.toast('Не удалось: ' + Ui.reason(err), 'error'); }
        }
    });

    $('addTypeBtn').addEventListener('click', function () { typeForm(null); });

    await loadStores();
    await loadTypes();
    setInterval(function () { if (!document.hidden) { loadStores(); loadTypes(); } }, 30000);
})();
