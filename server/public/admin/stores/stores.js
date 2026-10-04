// Страница «Магазины»: карточки магазинов (цвет — доля касс на связи), клик — страница
// магазина; раскладка касс по подсетям магазинов; вкладка «Типы устройств».
(async function () {
    const me = await requireAdminAuth();
    const canEdit = me.role === 'administrator' || me.role === 'superadmin';
    const $ = Ui.$, esc = Ui.escapeHtml;

    $('addStoreBtn').innerHTML = Ui.icon('plus') + 'Магазин';
    $('autoAssignBtn').innerHTML = Ui.icon('target') + 'Разложить по подсетям…';
    $('searchIcon').outerHTML = Ui.icon('search');
    if (canEdit) document.querySelectorAll('[data-admin]').forEach(function (b) { b.hidden = false; });

    document.querySelectorAll('.tabs button').forEach(function (b) {
        b.addEventListener('click', function () {
            document.querySelectorAll('.tabs button').forEach(function (x) { x.classList.toggle('active', x === b); });
            document.querySelectorAll('.tab-panel').forEach(function (p) { p.hidden = p.dataset.panel !== b.dataset.tab; });
        });
    });

    // ---- Магазины -----------------------------------------------------------------------

    let stores = [];

    function ago(ts) {
        if (!ts) return null;
        const sec = Math.round((Date.now() - new Date(ts.replace(' ', 'T') + 'Z')) / 1000);
        if (sec < 90) return 'только что';
        if (sec < 5400) return Math.round(sec / 60) + ' мин назад';
        if (sec < 172800) return Math.round(sec / 3600) + ' ч назад';
        return Math.round(sec / 86400) + ' дн назад';
    }

    const STATUS_TIPS = {
        green: 'Все кассы магазина на связи', yellow: 'На связи только часть касс',
        red: 'Ни одна касса магазина не на связи', empty: 'В магазине пока нет касс',
    };

    function card(s) {
        const offline = s.pc_count - s.online_count - s.never_count;
        const last = ago(s.last_seen);
        return '<a class="store-card" href="/admin/stores/store?id=' + s.id + '" title="Открыть магазин: кассы, состояние, действия">' +
            '<div class="store-head"><i class="status-dot ' + s.status + '" title="' + esc(STATUS_TIPS[s.status]) + '"></i><b>' + esc(s.name) + '</b>' +
                (+s.is_pilot ? '<span class="badge badge-accent plain" title="Пилотный магазин: новое сюда раньше остальных">пилот</span>' : '') + '</div>' +
            (s.pc_count
                ? '<div class="store-num">' + s.online_count + ' <span>из ' + s.pc_count + ' ' + Ui.plural(s.pc_count, 'кассы', 'касс', 'касс') + ' на связи</span></div>' +
                  Ui.progressBar([
                      { n: s.online_count, kind: 'ok', label: 'на связи' },
                      { n: offline, kind: 'bad', label: 'не на связи' },
                      { n: s.never_count, kind: 'wait', label: 'ни разу не выходили' },
                  ], s.pc_count)
                : '<div class="store-num"><span>касс пока нет</span></div>') +
            '<div class="store-meta">' +
                (last ? '<span>последний опрос: ' + esc(last) + '</span>' : (s.pc_count ? '<span>кассы ещё ни разу не выходили на связь</span>' : '')) +
                (s.never_count && last ? '<span>ни разу не выходили: ' + s.never_count + '</span>' : '') +
                (s.subnets ? '<span class="mono" title="Подсети магазина">' + esc(s.subnets) + '</span>' : '') +
                (s.suggest_count ? '<span style="color:var(--warning)" title="Кассы из других магазинов, чей IP — из подсети этого">+' + s.suggest_count + ' ' +
                    Ui.plural(s.suggest_count, 'касса', 'кассы', 'касс') + ' похоже отсюда</span>' : '') +
            '</div></a>';
    }

    async function loadStores() {
        stores = await Api.get('/admin/stores');
        $('storesCount').textContent = stores.length;
        render();
        const misplaced = stores.reduce(function (n, s) { return n + s.suggest_count; }, 0);
        $('autoAssignBtn').hidden = !canEdit || !stores.some(function (s) { return s.subnets; });
        $('suggestNote').hidden = !misplaced;
        $('suggestNote').innerHTML = misplaced ? 'По подсетям ' + misplaced + ' ' + Ui.plural(misplaced, 'касса числится', 'кассы числятся', 'касс числятся') +
            ' не в своём магазине.' + (canEdit ? ' <button type="button" class="small primary" id="suggestBtn" style="margin-left:6px">Посмотреть и разложить</button>' : '') : '';
    }

    function render() {
        const q = $('storeSearch').value.trim().toLowerCase();
        const f = $('storeFilter').value;
        const rank = { red: 0, yellow: 1, green: 2, empty: 3 };
        const list = stores.filter(function (s) {
            if (q && s.name.toLowerCase().indexOf(q) < 0) return false;
            if (f === 'problem') return s.pc_count > 0 && s.online_count < s.pc_count;
            if (f === 'pilot') return +s.is_pilot;
            if (f === 'empty') return !s.pc_count;
            return true;
        }).sort(function (a, b) {
            if ($('storeSort').value === 'problem') return rank[a.status] - rank[b.status] || a.name.localeCompare(b.name);
            if ($('storeSort').value === 'size') return b.pc_count - a.pc_count || a.name.localeCompare(b.name);
            return a.name.localeCompare(b.name);
        });
        $('storeGrid').innerHTML = list.length ? list.map(card).join('')
            : '<div style="grid-column:1/-1">' + (stores.length ? '<div class="empty">Ничего не найдено.</div>'
                : Ui.emptyState({ icon: 'store', title: 'Магазинов пока нет', text: 'Заведите магазин — потом кассы добавляются в него при заведении или переводом из другого магазина.',
                    action: canEdit ? { label: 'Завести магазин', id: 'emptyAddBtn' } : null })) + '</div>';
    }

    $('storeSearch').addEventListener('input', render);
    $('storeFilter').addEventListener('change', render);
    $('storeSort').addEventListener('change', render);
    document.addEventListener('click', function (e) {
        if (e.target.closest('#emptyAddBtn')) addStore();
        if (e.target.closest('#suggestBtn')) autoAssign();
    });

    async function addStore() {
        const id = await StoreDialogs.edit(null);
        if (!id) return;
        Ui.toast('Магазин создан', 'success');
        if (id !== true) window.location.href = '/admin/stores/store?id=' + id;
        else loadStores();
    }
    $('addStoreBtn').addEventListener('click', addStore);

    // Раскладка по подсетям: список касс, чей IP относится к подсети другого магазина, —
    // переносятся только отмеченные, после подтверждения.
    async function autoAssign() {
        const list = await Api.get('/admin/stores/auto-assign');
        if (!list.length) { Ui.toast('Все кассы с известным IP уже в магазинах своих подсетей', 'success'); return; }
        const ok = await Ui.modal({
            title: 'Разложить кассы по подсетям', wide: true,
            body: '<p>По IP последнего опроса эти кассы относятся к подсети другого магазина, чем тот, где они числятся. Отметьте, кого перевести.</p>' +
                '<table><thead><tr><th><input type="checkbox" id="aaAll" checked aria-label="Отметить все"></th><th>Касса</th><th>IP</th><th>Сейчас</th><th>Перейдёт в</th></tr></thead><tbody>' +
                list.map(function (m) {
                    return '<tr><td><input type="checkbox" data-aa="' + m.pc_id + '" checked></td><td>' + esc(m.display_name || m.hostname) + '</td>' +
                        '<td class="mono" style="font-size:12px">' + esc(m.last_ip) + '</td><td>' + esc(m.from_store) + '</td><td><b>' + esc(m.to_store) + '</b></td></tr>';
                }).join('') + '</tbody></table><p class="error modal-error"></p>',
            buttons: [{ label: 'Отмена', value: null }, { label: 'Перевести отмеченные', value: 'submit', kind: 'primary' }],
            onSubmit: async function (root) {
                const ids = [...root.querySelectorAll('[data-aa]:checked')].map(function (c) { return +c.dataset.aa; });
                if (!ids.length) { root.querySelector('.modal-error').textContent = 'Не отмечено ни одной кассы.'; return false; }
                const r = await Api.post('/admin/stores/auto-assign', { pc_ids: ids });
                Ui.toast('Переведено касс: ' + r.moved, 'success');
                return true;
            },
        });
        if (ok) loadStores();
    }
    document.addEventListener('change', function (e) {
        if (e.target.id === 'aaAll') document.querySelectorAll('[data-aa]').forEach(function (c) { c.checked = e.target.checked; });
    });
    $('autoAssignBtn').addEventListener('click', autoAssign);

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
        document.querySelector('#typesTable tbody').innerHTML = types.map(function (t) {
            return '<tr data-id="' + t.id + '"><td><a class="host-link" href="/admin/hosts?device_type_id=' + t.id + '" title="Хосты этого типа"><b>' + esc(t.name) + '</b></a></td>' +
                '<td class="num">' + t.pc_count + '</td>' +
                '<td><div class="actions">' + (canEdit ?
                    '<button type="button" class="small" data-act="edit">Переименовать</button>' +
                    '<button type="button" class="small" data-act="delete"' + (t.pc_count > 0 ? ' disabled title="Сначала переведите ПК на другой тип"' : '') + '>Удалить</button>' : '') +
                '</div></td></tr>';
        }).join('');
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

    // ?tab=types — прямая ссылка на вкладку.
    if (new URLSearchParams(location.search).get('tab') === 'types') document.querySelector('.tabs [data-tab="types"]').click();

    await Promise.all([loadStores(), loadTypes()]);
    setInterval(function () { if (!document.hidden) loadStores(); }, 30000);
})();
