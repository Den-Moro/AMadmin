// Профиль хоста (/admin/hosts/host?id=N). Порядок работы:
//   1. id из адресной строки -> GET /admin/pcs/{id} (карточка + группы + история).
//   2. Кнопки сверху: «Оповестить» и «Команда…» ведут на соответствующие страницы с
//      уже выбранным этим ПК (?pc=N); «Изменить», ключ и удаление — здесь же.
//   3. «Обновить» и таймер раз в 30 с перечитывают всё.
(async function () {
    const me = await requireAdminAuth();
    const canEdit = me.role === 'administrator' || me.role === 'superadmin';
    const $ = Ui.$, esc = Ui.escapeHtml;

    const id = parseInt(new URLSearchParams(window.location.search).get('id'), 10);
    if (!id) { window.location.href = '/admin/hosts'; return; }
    if (canEdit) $('adminActions').hidden = false;

    let data = null, stores = [], deviceTypes = [];

    function fact(k, v) { return '<div class="fact"><div class="k">' + esc(k) + '</div><div class="v">' + v + '</div></div>'; }

    function ago(ts) {
        if (!ts) return 'никогда';
        const sec = Math.round((Date.now() - new Date(ts.replace(' ', 'T') + 'Z')) / 1000);
        if (sec < 90) return sec + ' с назад';
        if (sec < 5400) return Math.round(sec / 60) + ' мин назад';
        if (sec < 172800) return Math.round(sec / 3600) + ' ч назад';
        return Math.round(sec / 86400) + ' дн назад';
    }

    const typeNames = { service_control: 'Служба', process_action: 'Процесс', script_run: 'Скрипт', file_deploy: 'Файл' };
    function describeCommand(r) {
        let p = {};
        try { p = JSON.parse(r.payload); } catch (e) { /* — */ }
        const detail = p.service_name || p.process_name || p.original_name || (p.script ? p.script.split(/\r?\n/)[0] : p.path) || p.action || '';
        return (typeNames[r.type] || r.type) + (detail ? ': ' + detail : '');
    }

    async function load() {
        try { data = await Api.get('/admin/pcs/' + id); }
        catch (err) { Ui.toast('Хост не найден', 'error'); window.location.href = '/admin/hosts'; return; }
        const pc = data.pc;
        const name = pc.display_name || pc.hostname;
        document.title = name + ' — AMadmin';
        $('crumbName').textContent = name;
        $('title').textContent = name;
        $('statusBadge').className = 'badge ' + (pc.online ? 'badge-online' : 'badge-offline');
        $('statusBadge').textContent = pc.online ? 'онлайн' : 'офлайн';
        $('statusText').textContent = pc.last_seen ? 'последний опрос ' + ago(pc.last_seen) + ' (' + formatServerTime(pc.last_seen) + ')' : 'агент ещё ни разу не выходил на связь';

        $('facts').innerHTML =
            fact('Hostname', esc(pc.hostname)) +
            fact('Понятное имя', esc(pc.display_name || '—')) +
            fact('Пользователь Windows', esc(pc.username || '—')) +
            fact('IP', pc.last_ip ? '<span class="ip-copy" data-ip="' + esc(pc.last_ip) + '" title="Скопировать IP">' + esc(pc.last_ip) + '</span>' : '—') +
            fact('Магазин', '<a href="/admin/hosts?store_id=' + pc.store_id + '">' + esc(pc.store_name) + '</a>') +
            fact('Тип устройства', esc(pc.device_type_name)) +
            fact('Версия агента', esc(pc.agent_version || 'не отчитался')) +
            fact('Заведён', esc(formatServerTime(pc.created_at))) +
            fact('ID', '#' + pc.id);

        const okCount = data.totals.results - data.totals.failed;
        const rate = data.totals.results ? Math.round((okCount / data.totals.results) * 100) : null;
        $('totals').innerHTML =
            fact('Подтверждений оповещений', data.totals.acks) +
            fact('Выполнено команд', data.totals.results) +
            fact('Успешно', '<span class="badge badge-success">' + okCount + '</span>') +
            fact('С ошибкой', data.totals.failed ? '<span class="badge badge-failed">' + data.totals.failed + '</span>' : '0') +
            (rate !== null ? fact('Надёжность', rate + '%') : '');

        $('groups').innerHTML = data.groups.length
            ? data.groups.map(function (g) { return '<a href="/admin/hosts?group_id=' + g.id + '"><span class="badge badge-accent">' + esc(g.name) + '</span></a> '; }).join('')
            : 'ни в одной группе';

        const rt = document.querySelector('#resultsTable tbody');
        rt.innerHTML = data.results.length ? data.results.map(function (r) {
            return '<tr><td class="muted" style="white-space:nowrap">' + esc(formatServerTime(r.executed_at || r.claimed_at)) + '</td>' +
                '<td>' + esc(describeCommand(r)) + '</td><td>' + esc(r.author || '—') + '</td>' +
                '<td><span class="badge badge-' + esc(r.status) + '">' + esc(r.status) + '</span></td>' +
                '<td style="max-width:480px">' + (r.output ? '<pre class="output">' + esc(r.output) + '</pre>' : '<span class="muted">—</span>') + '</td></tr>';
        }).join('') : '<tr><td colspan="5" class="empty">Команд на этот хост ещё не было.</td></tr>';

        const at = document.querySelector('#acksTable tbody');
        at.innerHTML = data.acks.length ? data.acks.map(function (a) {
            return '<tr><td class="muted" style="white-space:nowrap">' + esc(formatServerTime(a.acked_at)) + '</td><td>' + esc(a.text) + '</td>' +
                '<td>' + (a.priority === 'important' ? '<span class="badge badge-important">важное</span>' : '<span class="badge badge-neutral">обычное</span>') + '</td>' +
                '<td>' + (a.reacted ? '<span class="badge badge-success">да</span>' : '<span class="muted">—</span>') + '</td></tr>';
        }).join('') : '<tr><td colspan="4" class="empty">Подтверждений пока нет.</td></tr>';
    }

    // ---- Действия ------------------------------------------------------------------------

    function buildConfigText(token) {
        return JSON.stringify({ server_url: window.location.origin, agent_token: token, poll_interval_seconds: 30, log_level: 'debug',
            proxy_url: '', proxy_username: '', proxy_password: '', download_limit_kbps: 0 }, null, 4);
    }
    function showConfig(token) {
        Ui.modal({
            title: 'config.json для ' + data.pc.hostname,
            body: '<textarea class="config" readonly>' + esc(buildConfigText(token)) + '</textarea>',
            buttons: [{ label: 'Скачать', value: 'download' }, { label: 'Скопировать', value: 'copy', kind: 'primary' }],
        }).then(function (v) {
            if (v === 'copy') navigator.clipboard.writeText(buildConfigText(token)).then(function () { Ui.toast('Скопировано', 'success'); });
            if (v === 'download') { const a = document.createElement('a'); a.href = 'data:application/json;charset=utf-8,' + encodeURIComponent(buildConfigText(token)); a.download = 'config.json'; a.click(); }
        });
    }

    $('facts').addEventListener('click', function (e) {
        const ip = e.target.closest('.ip-copy');
        if (!ip) return;
        navigator.clipboard.writeText(ip.dataset.ip).then(function () { Ui.toast('IP скопирован: ' + ip.dataset.ip, 'success'); });
    });

    $('refreshBtn').addEventListener('click', async function () { await load(); Ui.toast('Обновлено', 'success'); });
    $('notifyBtn').addEventListener('click', function () { window.location.href = '/admin/notifications?pc=' + id; });
    $('commandBtn').addEventListener('click', function () { window.location.href = '/admin/commands?pc=' + id; });

    $('editBtn').addEventListener('click', async function () {
        if (!stores.length) { stores = await Api.get('/admin/stores'); deviceTypes = await Api.get('/admin/device-types'); }
        const pc = data.pc;
        const opts = function (items, cur, labelFn) { return items.map(function (i) { return '<option value="' + i.id + '"' + (i.id == cur ? ' selected' : '') + '>' + esc(labelFn(i)) + '</option>'; }).join(''); };
        const v = await Ui.modal({
            title: 'ПК ' + pc.hostname,
            body: '<label>Понятное имя<input type="text" id="edName" value="' + esc(pc.display_name || '') + '"></label>' +
                '<div class="row"><label>Магазин<select id="edStore">' + opts(stores, pc.store_id, function (s) { return s.name; }) + '</select></label>' +
                '<label>Тип устройства<select id="edType">' + opts(deviceTypes, pc.device_type_id, function (d) { return d.name; }) + '</select></label></div><p class="error modal-error"></p>',
            buttons: [{ label: 'Отмена', value: null }, { label: 'Сохранить', value: 'submit', kind: 'primary' }],
            onSubmit: async function (root) {
                await Api.request('PUT', '/admin/pcs/' + id, { display_name: root.querySelector('#edName').value, store_id: root.querySelector('#edStore').value, device_type_id: root.querySelector('#edType').value });
            },
        });
        if (v) { Ui.toast('Сохранено', 'success'); load(); }
    });

    $('moreBtn').addEventListener('click', async function () {
        const act = await Ui.menu($('moreBtn'), [
            { label: 'Показать config.json', value: 'config' },
            { label: 'Выпустить новый ключ', value: 'token' },
            { label: 'Удалить хост', value: 'delete', danger: true },
        ]);
        if (act === 'config') showConfig(data.pc.agent_token);
        if (act === 'token') {
            if (!await Ui.confirm('Выпустить новый ключ? Старый перестанет работать сразу — на кассе нужно заменить config.json.', { danger: true, okLabel: 'Выпустить' })) return;
            try { const r = await Api.post('/admin/pcs/' + id + '/token'); await load(); showConfig(r.agent_token); }
            catch (err) { Ui.toast('Не удалось: ' + Ui.reason(err), 'error'); }
        }
        if (act === 'delete') {
            if (!await Ui.confirm('Удалить ' + data.pc.hostname + ' вместе с историей?', { danger: true, okLabel: 'Удалить' })) return;
            try { await Api.request('DELETE', '/admin/pcs/' + id); Ui.toast('Хост удалён', 'success'); window.location.href = '/admin/hosts'; }
            catch (err) { Ui.toast('Не удалось: ' + Ui.reason(err), 'error'); }
        }
    });

    await load();
    setInterval(function () { if (!document.hidden) load(); }, 30000);
})();
