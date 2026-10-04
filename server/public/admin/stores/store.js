// Страница магазина (/admin/stores/store?id=N): сводка по кассам, кассы, которые по IP
// похожи на этот магазин, список касс с массовыми действиями (в другой магазин, в группу)
// и действия над магазином целиком — оповестить, команда, файл.
(async function () {
    const me = await requireAdminAuth();
    const canEdit = me.role === 'administrator' || me.role === 'superadmin';
    const $ = Ui.$, esc = Ui.escapeHtml;

    const id = parseInt(new URLSearchParams(location.search).get('id'), 10);
    if (!id) { location.href = '/admin/stores'; return; }

    $('notifyBtn').innerHTML = Ui.icon('bell') + 'Оповестить';
    $('commandBtn').innerHTML = Ui.icon('terminal') + 'Команда…';
    $('fileBtn').innerHTML = Ui.icon('folder') + 'Файл…';
    $('editBtn').innerHTML = Ui.icon('sliders') + 'Изменить';
    $('addPcsBtn').innerHTML = Ui.icon('plus') + 'Добавить кассы из других магазинов';
    $('searchIcon').outerHTML = Ui.icon('search');
    if (canEdit) { $('adminActions').hidden = false; $('addPcsWrap').hidden = false; $('editBtn2').hidden = false; }

    let store = null, pcs = [], suggestions = [];
    const selected = new Set();

    function ago(ts) {
        if (!ts) return 'никогда';
        const sec = Math.round((Date.now() - new Date(ts.replace(' ', 'T') + 'Z')) / 1000);
        if (sec < 90) return sec + ' с назад';
        if (sec < 5400) return Math.round(sec / 60) + ' мин назад';
        if (sec < 172800) return Math.round(sec / 3600) + ' ч назад';
        return Math.round(sec / 86400) + ' дн назад';
    }

    async function load() {
        try {
            [store, pcs, suggestions] = await Promise.all([
                Api.get('/admin/stores/' + id), Api.get('/admin/pcs?store_id=' + id), Api.get('/admin/stores/' + id + '/suggestions'),
            ]);
        } catch (err) {
            Ui.toast('Магазин не найден', 'error');
            location.href = '/admin/stores';
            return;
        }
        renderHead();
        renderSuggestions();
        renderPcs();
    }

    function renderHead() {
        document.title = store.name + ' — AMadmin';
        $('crumbName').textContent = store.name;
        $('title').innerHTML = esc(store.name) + (+store.is_pilot ? ' <span class="badge badge-accent plain" style="vertical-align:middle" title="Пилотный магазин: новое сюда раньше остальных">пилот</span>' : '');
        $('statusDot').className = 'status-dot ' + store.status;
        const offline = store.pc_count - store.online_count - store.never_count;
        $('statusText').textContent = store.pc_count
            ? store.online_count + ' из ' + store.pc_count + ' ' + Ui.plural(store.pc_count, 'кассы', 'касс', 'касс') + ' на связи' +
              (store.last_seen ? ' · последний опрос ' + ago(store.last_seen) : '')
            : 'в магазине пока нет касс';
        $('tTotal').textContent = store.pc_count;
        $('tOnline').textContent = store.online_count;
        $('tOnlinePct').textContent = store.pc_count ? Math.round(store.online_count / store.pc_count * 100) + '% касс' : '';
        $('tOffline').textContent = offline;
        $('tNever').textContent = store.never_count;
        document.querySelectorAll('#tiles a.stat').forEach(function (a) { a.classList.toggle('active-filter', a.dataset.state === $('stateFilter').value && !!$('stateFilter').value); });

        $('info').innerHTML =
            '<dt>Пилотный</dt><dd>' + (+store.is_pilot ? 'да — новое сюда раньше остальных' : 'нет') + '</dd>' +
            '<dt>Подсети</dt><dd>' + (store.subnets ? '<code>' + esc(store.subnets) + '</code>'
                : '<span class="muted">не заданы — укажите локальную сеть магазина (например, 192.168.5.0/24), и панель подскажет, какие кассы стоят здесь</span>') + '</dd>' +
            '<dt>Бренд в оповещениях</dt><dd>' + (store.brand_name || store.brand_contact
                ? esc([store.brand_name, store.brand_contact].filter(Boolean).join(' · ')) : '<span class="muted">общий из Настроек</span>') + '</dd>';
    }

    function renderSuggestions() {
        $('suggestCard').hidden = !suggestions.length;
        if (!suggestions.length) return;
        $('suggestText').textContent = 'IP этих касс — из подсети магазина (' + store.subnets + '), а числятся они в других магазинах.' +
            (canEdit ? ' Отметьте, кого перевести сюда.' : '');
        $('suggestActions').hidden = !canEdit;
        $('sgAll').hidden = !canEdit;
        document.querySelector('#suggestTable tbody').innerHTML = suggestions.map(function (m) {
            return '<tr><td class="check">' + (canEdit ? '<input type="checkbox" data-sg="' + m.pc_id + '" checked>' : '') + '</td>' +
                '<td><a class="host-link" href="/admin/hosts/host?id=' + m.pc_id + '">' + esc(m.display_name || m.hostname) + '</a></td>' +
                '<td><code>' + esc(m.last_ip) + '</code></td>' +
                '<td><a href="/admin/stores/store?id=' + m.from_store_id + '">' + esc(m.from_store) + '</a></td></tr>';
        }).join('');
    }

    $('sgAll').addEventListener('change', function () {
        document.querySelectorAll('[data-sg]').forEach(function (c) { c.checked = $('sgAll').checked; });
    });
    $('suggestMoveBtn').addEventListener('click', async function () {
        const ids = [...document.querySelectorAll('[data-sg]:checked')].map(function (c) { return +c.dataset.sg; });
        if (!ids.length) { Ui.toast('Не отмечено ни одной кассы', 'error'); return; }
        try {
            const r = await Api.post('/admin/pcs/move', { pc_ids: ids, store_id: id });
            Ui.toast('Переведено сюда: ' + r.moved, 'success');
            await load();
        } catch (err) { Ui.toast('Не удалось: ' + Ui.reason(err, StoreDialogs.ERRORS), 'error'); }
    });

    // ---- Кассы ------------------------------------------------------------------------------

    function stateOf(pc) { return pc.online ? 'online' : (pc.last_seen ? 'offline' : 'never'); }

    function renderPcs() {
        const q = $('search').value.trim().toLowerCase();
        const st = $('stateFilter').value;
        const list = pcs.filter(function (pc) {
            if (st && stateOf(pc) !== st) return false;
            return !q || [pc.display_name, pc.hostname, pc.username, pc.last_ip].some(function (v) { return v && String(v).toLowerCase().indexOf(q) >= 0; });
        });
        [...selected].forEach(function (pid) { if (!pcs.some(function (pc) { return String(pc.id) === pid; })) selected.delete(pid); });

        const tbody = document.querySelector('#pcsTable tbody');
        if (!pcs.length) {
            tbody.innerHTML = '<tr><td colspan="8">' + Ui.emptyState({ icon: 'monitor', title: 'В магазине пока нет касс',
                text: canEdit ? 'Переведите сюда кассы из других магазинов — кнопка «Добавить кассы» выше — или заведите новые на странице «Хосты».' : 'Кассы заводит администратор.' }) + '</td></tr>';
        } else if (!list.length) {
            tbody.innerHTML = '<tr><td colspan="8" class="empty">Под фильтр ничего не попало.</td></tr>';
        } else {
            tbody.innerHTML = list.map(function (pc) {
                const s = stateOf(pc);
                const badge = s === 'online' ? '<span class="badge badge-online">на связи</span>'
                    : s === 'offline' ? '<span class="badge badge-offline" title="Последний опрос ' + esc(ago(pc.last_seen)) + '">не на связи</span>'
                    : '<span class="badge badge-neutral" title="Агент ни разу не выходил на связь — скорее всего, не установлен">ни разу</span>';
                return '<tr data-id="' + pc.id + '">' +
                    '<td class="check">' + (canEdit ? '<input type="checkbox" data-check' + (selected.has(String(pc.id)) ? ' checked' : '') + ' aria-label="Отметить">' : '') + '</td>' +
                    '<td>' + badge + '</td>' +
                    '<td><a class="host-link" href="/admin/hosts/host?id=' + pc.id + '" title="Профиль кассы">' + esc(pc.display_name || pc.hostname) + '</a>' +
                        '<span class="host-sub">' + esc(pc.hostname) + (pc.username ? '\\' + esc(pc.username) : '') + '</span></td>' +
                    '<td>' + (pc.last_ip ? '<code>' + esc(pc.last_ip) + '</code>' : '<span class="muted">—</span>') + '</td>' +
                    '<td>' + esc(pc.device_type_name) + '</td>' +
                    '<td class="muted" style="font-size:12.5px">' + esc(pc.groups || '—') + '</td>' +
                    '<td>' + Ui.agentVersionHtml(pc, '—') + '</td>' +
                    '<td class="muted nowrap" title="' + esc(formatServerTime(pc.last_seen)) + '">' + esc(ago(pc.last_seen)) + '</td></tr>';
            }).join('');
        }
        $('bulkCount').textContent = selected.size;
        $('bulkBar').classList.toggle('show', selected.size > 0);
        $('checkAll').checked = list.length > 0 && list.every(function (pc) { return selected.has(String(pc.id)); });
        $('checkAll').hidden = !canEdit;
    }

    document.querySelector('#pcsTable').addEventListener('change', function (e) {
        const cb = e.target.closest('input[data-check]');
        if (!cb) return;
        const pid = cb.closest('tr').dataset.id;
        if (cb.checked) selected.add(pid); else selected.delete(pid);
        renderPcs();
    });
    $('checkAll').addEventListener('change', function () {
        document.querySelectorAll('#pcsTable tbody tr[data-id]').forEach(function (tr) {
            if ($('checkAll').checked) selected.add(tr.dataset.id); else selected.delete(tr.dataset.id);
        });
        renderPcs();
    });
    $('search').addEventListener('input', renderPcs);
    $('stateFilter').addEventListener('change', function () { renderPcs(); renderHead(); });
    document.querySelectorAll('#tiles a.stat').forEach(function (a) {
        a.addEventListener('click', function (e) {
            e.preventDefault();
            $('stateFilter').value = a.dataset.state;
            renderPcs();
            renderHead();
            document.querySelector('#pcsTable').scrollIntoView({ behavior: 'smooth', block: 'start' });
        });
    });

    document.querySelector('#bulkBar').addEventListener('click', async function (e) {
        const btn = e.target.closest('button[data-bulk]');
        if (!btn) return;
        const ids = [...selected].map(Number);
        if (btn.dataset.bulk === 'clear') { selected.clear(); renderPcs(); return; }
        if (btn.dataset.bulk === 'move') {
            if (await StoreDialogs.move(ids, id)) { selected.clear(); await load(); }
            return;
        }
        if (btn.dataset.bulk === 'group') {
            const groups = await Api.get('/admin/host-groups');
            if (!groups.length) { Ui.toast('Сначала создайте группу на странице «Группы»', 'error'); return; }
            const ok = await Ui.modal({
                title: 'Добавить ' + ids.length + ' ' + Ui.plural(ids.length, 'кассу', 'кассы', 'касс') + ' в группу',
                body: '<label>Группа<span class="hint">Касса может состоять в нескольких группах и при этом оставаться в своём магазине.</span>' +
                    '<select id="bulkGroup">' + groups.map(function (g) { return '<option value="' + g.id + '">' + esc(g.name) + '</option>'; }).join('') + '</select></label>',
                buttons: [{ label: 'Отмена', value: null }, { label: 'Добавить', value: 'submit', kind: 'primary' }],
                onSubmit: async function (root) {
                    await Api.post('/admin/host-groups/' + root.querySelector('#bulkGroup').value + '/members', { pc_ids: ids });
                    return true;
                },
            });
            if (ok) { Ui.toast('Добавлено в группу: ' + ids.length, 'success'); selected.clear(); await load(); }
        }
    });

    // Перевести сюда кассы из других магазинов: список с поиском и чекбоксами.
    $('addPcsBtn').addEventListener('click', async function () {
        const others = (await Api.get('/admin/pcs')).filter(function (pc) { return +pc.store_id !== id; });
        if (!others.length) { Ui.toast('Все кассы уже в этом магазине', 'info'); return; }
        const ok = await Ui.modal({
            title: 'Перевести кассы в «' + store.name + '»', wide: true,
            body: '<input type="search" id="apSearch" placeholder="Поиск: имя, магазин, IP…">' +
                '<div class="checklist" id="apList" style="max-height:46vh">' + others.map(function (pc) {
                    return '<label data-text="' + esc([pc.display_name, pc.hostname, pc.store_name, pc.last_ip].join(' ').toLowerCase()) + '">' +
                        '<input type="checkbox" value="' + pc.id + '">' + esc(pc.display_name || pc.hostname) +
                        '<span class="sub">' + esc(pc.store_name) + (pc.last_ip ? ' · ' + esc(pc.last_ip) : '') + '</span></label>';
                }).join('') + '</div>' +
                '<p class="muted" style="margin:0">У кассы меняется только магазин: ключ, группы и история остаются.</p><p class="error modal-error"></p>',
            buttons: [{ label: 'Отмена', value: null }, { label: 'Перевести отмеченные', value: 'submit', kind: 'primary' }],
            onSubmit: async function (root) {
                const ids = [...root.querySelectorAll('#apList input:checked')].map(function (c) { return +c.value; });
                if (!ids.length) { root.querySelector('.modal-error').textContent = 'Отметьте хотя бы одну кассу.'; return false; }
                const r = await Api.post('/admin/pcs/move', { pc_ids: ids, store_id: id });
                Ui.toast('Переведено сюда: ' + r.moved, 'success');
                return true;
            },
        });
        if (ok) await load();
    });
    document.addEventListener('input', function (e) {
        if (e.target.id !== 'apSearch') return;
        const q = e.target.value.trim().toLowerCase();
        document.querySelectorAll('#apList label').forEach(function (l) { l.hidden = !!q && l.dataset.text.indexOf(q) < 0; });
    });

    // ---- Действия над магазином --------------------------------------------------------------

    $('notifyBtn').addEventListener('click', function () { location.href = '/admin/notifications?target=store:' + id; });
    $('commandBtn').addEventListener('click', function () { location.href = '/admin/commands?target=store:' + id; });
    $('fileBtn').addEventListener('click', function () { location.href = '/admin/files?target=store:' + id; });
    async function edit() { if (await StoreDialogs.edit(store)) { Ui.toast('Сохранено', 'success'); await load(); } }
    $('editBtn').addEventListener('click', edit);
    $('editBtn2').addEventListener('click', edit);
    $('moreBtn').addEventListener('click', async function () {
        const act = await Ui.menu($('moreBtn'), [{ label: 'Хосты магазина на странице «Хосты»', value: 'hosts' }, { label: 'Удалить магазин', value: 'delete', danger: true }]);
        if (act === 'hosts') location.href = '/admin/hosts?store_id=' + id;
        if (act === 'delete') {
            if (store.pc_count) { Ui.toast('В магазине ' + store.pc_count + ' ' + Ui.plural(store.pc_count, 'касса', 'кассы', 'касс') + ' — сначала переведите их в другой магазин', 'error'); return; }
            if (!await Ui.confirm('Удалить магазин «' + store.name + '»?', { danger: true, okLabel: 'Удалить' })) return;
            try { await Api.request('DELETE', '/admin/stores/' + id); Ui.toast('Магазин удалён', 'success'); location.href = '/admin/stores'; }
            catch (err) { Ui.toast('Не удалось: ' + Ui.reason(err), 'error'); }
        }
    });

    await load();
    setInterval(function () { if (!document.hidden && !document.querySelector('.modal-back')) load(); }, 30000);
})();
