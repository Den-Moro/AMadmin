(async function () {
    await requireAdminAuth();
    const $ = Ui.$, esc = Ui.escapeHtml;

    const targetTypeEl = $('targetType');
    const targetIdWrap = $('targetIdWrap');
    const targetIdEl = $('targetId');
    const optionsCache = {};
    let rows = [];

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
            const endpoints = { store: '/admin/stores', group: '/admin/host-groups', device_type: '/admin/device-types', pc: '/admin/pcs' };
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

    targetTypeEl.addEventListener('change', function () { loadTargetOptions(targetTypeEl.value); });

    // ---- Форма ------------------------------------------------------------------------

    $('newBtn').addEventListener('click', function () {
        $('createForm').hidden = !$('createForm').hidden;
        if (!$('createForm').hidden) $('text').focus();
    });
    $('cancelNewBtn').addEventListener('click', function () { $('createForm').hidden = true; });

    const manualPickerEl = $('manualPicker');
    let manuals = [];

    async function loadManualPicker() {
        manuals = await Api.get('/admin/manuals');
        manuals.forEach(function (m) {
            const opt = document.createElement('option');
            opt.value = m.id;
            opt.textContent = m.title;
            manualPickerEl.appendChild(opt);
        });
    }

    // Выбор мануала копирует его текст в поле — не хранит ссылку на мануал (правка
    // мануала в библиотеке не меняет уже отправленные оповещения задним числом).
    manualPickerEl.addEventListener('change', function () {
        const picked = manuals.find(function (m) { return String(m.id) === manualPickerEl.value; });
        if (picked) $('manualUrl').value = picked.url_or_text;
    });

    $('createForm').addEventListener('submit', async function (e) {
        e.preventDefault();
        const targetType = targetTypeEl.value;
        const body = {
            text: $('text').value,
            priority: $('priority').value,
            size: $('size').value,
            manual_url: $('manualUrl').value,
            target: { type: targetType, id: targetType === 'all' ? null : targetIdEl.value },
        };
        try {
            await Api.post('/admin/notifications', body);
            Ui.toast('Оповещение отправлено — кассы получат его при следующем опросе', 'success');
            $('createForm').reset();
            $('createForm').hidden = true;
            targetIdWrap.style.display = 'none';
            await loadNotifications();
        } catch (err) {
            Ui.toast('Не удалось отправить: ' + Ui.reason(err, {
                text_required: 'введите текст', target_id_required: 'выберите, кому именно', target_not_found: 'получатель не найден',
            }), 'error');
        }
    });

    // ---- История ----------------------------------------------------------------------

    async function loadNotifications() {
        rows = await Api.get('/admin/notifications');
        const q = $('search').value.toLowerCase();
        const tbody = document.querySelector('#notificationsTable tbody');
        tbody.innerHTML = '';
        const visible = rows.filter(function (n) { return !q || n.text.toLowerCase().indexOf(q) >= 0; });
        if (!visible.length) {
            tbody.innerHTML = '<tr><td colspan="5" class="empty">Оповещений ещё не было.</td></tr>';
            return;
        }
        visible.forEach(function (n) {
            const tr = document.createElement('tr');
            tr.className = 'clickable';
            tr.dataset.id = n.id;
            tr.innerHTML =
                '<td class="muted" style="white-space:nowrap">' + esc(formatServerTime(n.created_at)) + '</td>' +
                '<td>' + esc(n.text) + '</td>' +
                '<td>' + (n.priority === 'important' ? '<span class="badge badge-important">важное</span>' : '<span class="badge badge-neutral">обычное</span>') + '</td>' +
                '<td class="num">' + n.acks_count + '</td>' +
                '<td><div class="actions"><button type="button" data-act="recall" class="danger">Отозвать</button></div></td>';
            tbody.appendChild(tr);
        });
    }

    async function showAcks(tr, n) {
        const acks = await Api.get('/admin/notifications/' + n.id + '/acks');
        let html = '<h2 style="margin-bottom:8px">Кто подтвердил (' + acks.length + ')</h2>';
        if (!acks.length) {
            html += '<p class="muted">Пока никто — либо кассы ещё не опрашивали сервер, либо окно ещё висит на экране.</p>';
        } else {
            html += '<table><thead><tr><th>Магазин</th><th>Хост</th><th>Когда</th><th>Открыл инструкцию</th></tr></thead><tbody>' +
                acks.map(function (a) {
                    return '<tr><td>' + esc(a.store_name) + '</td><td>' + esc(a.display_name || a.hostname) + '</td>' +
                        '<td class="muted">' + esc(formatServerTime(a.acked_at)) + '</td>' +
                        '<td>' + (a.reacted ? '<span class="badge badge-success">да</span>' : '<span class="muted">—</span>') + '</td></tr>';
                }).join('') + '</tbody></table>';
        }
        Ui.toggleDetail(tr, html, 5);
    }

    document.querySelector('#notificationsTable').addEventListener('click', async function (e) {
        const tr = e.target.closest('tr[data-id]');
        if (!tr) return;
        const n = rows.find(function (x) { return String(x.id) === tr.dataset.id; });
        const btn = e.target.closest('button[data-act]');
        if (btn && btn.dataset.act === 'recall') {
            if (!await Ui.confirm('Отозвать оповещение «' + n.text.slice(0, 60) + '»? Кассы, которые его ещё не показали, уже не покажут.', { danger: true, okLabel: 'Отозвать' })) return;
            try { await Api.request('DELETE', '/admin/notifications/' + n.id); Ui.toast('Отозвано', 'success'); loadNotifications(); }
            catch (err) { Ui.toast('Не удалось: ' + Ui.reason(err), 'error'); }
            return;
        }
        showAcks(tr, n);
    });

    $('search').addEventListener('input', loadNotifications);

    await loadNotifications();
    await loadManualPicker();
})();
