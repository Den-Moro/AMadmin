// Дашборд. Порядок работы:
//   1. requireAdminAuth — сессия и роль.
//   1а. loadBoard — доска «Важная информация» (GET /admin/announcements).
//   2. loadStats — одна сводка GET /admin/stats (парк, активность за сутки, магазины,
//      версии агентов, лента событий).
//   3. loadAttention — кассы, которые молчат больше суток / ни разу не выходили
//      (GET /admin/pcs?state=silent|never), первые 10.
//   4. «Обновить» и таймер раз в 30 с (только пока вкладка видна) повторяют 2–3.
(async function () {
    const me = await requireAdminAuth();
    const $ = Ui.$, esc = Ui.escapeHtml;

    function renderNtp(ntp) {
        // Настройка проверки — в «Настройках» → «Сервер»; здесь только предупреждение.
        if (!ntp || !ntp.enabled) { $('ntpWarning').hidden = true; return; }
        const bad = !ntp.ok || Math.abs(+ntp.drift_seconds) > +ntp.threshold_seconds;
        $('ntpWarning').hidden = !bad;
        if (bad) {
            $('ntpWarning').textContent = !ntp.ok
                ? 'NTP: проверка времени сервера не удалась (' + ntp.server + '): ' + ntp.error
                : 'NTP: часы сервера разошлись с ' + ntp.server + ' на ' + ntp.drift_seconds + ' с — больше порога ' + ntp.threshold_seconds + ' с. Часы сервера панель сама не переводит.';
        }
    }

    function bar(name, value, total, bad, href) {
        const pct = total ? Math.round(value / total * 100) : 0;
        const label = href ? '<a href="' + href + '" style="color:inherit;text-decoration:none">' + esc(name) + '</a>' : esc(name);
        return '<div class="bar"><span class="name">' + label + '</span><span class="val">' + value + ' / ' + total + ' · ' + pct + '%</span>' +
            '<div class="track"><div class="fill' + (bad ? ' bad' : '') + '" style="width:' + pct + '%"></div></div></div>';
    }

    function describeEvent(ev) {
        if (ev.kind === 'notification') return (ev.extra === 'important' ? '❗ ' : '🔔 ') + 'Оповещение: ' + ev.title;
        let p = {};
        try { p = JSON.parse(ev.extra); } catch (e) { /* — */ }
        const names = { service_control: 'Служба', process_action: 'Процесс', script_run: 'Скрипт', file_deploy: 'Файл' };
        const detail = p.service_name || p.process_name || p.original_name || (p.script ? p.script.split(/\r?\n/)[0] : p.path) || p.action || '';
        return '⌘ ' + (names[ev.title] || ev.title) + (detail ? ': ' + detail : '');
    }

    async function loadStats() {
        let st;
        try { st = await Api.get('/admin/stats'); } catch (e) { return; }
        renderNtp(st.ntp);
        const p = st.pcs, a = st.activity;
        const total = +p.total, online = +p.online;
        $('statTotal').textContent = total;
        // Плитка сама — ссылка на список, вложенная <a> была бы недопустимой разметкой.
        $('statNever').textContent = +p.never_seen ? 'ни разу не выходили: ' + p.never_seen : 'все выходили на связь';
        $('statOnline').textContent = online;
        $('statOnlinePct').textContent = total ? Math.round(online / total * 100) + '% парка' : '';
        $('statOffline').textContent = total - online;
        $('statSilent').textContent = +p.silent_day ? 'молчат больше суток: ' + p.silent_day : '';
        $('statStores').textContent = st.stores.length;
        $('statGroups').textContent = 'групп: ' + a.groups + ', администраторов: ' + a.admins;

        $('actNotif').textContent = a.notifications_24h;
        $('actAcks').textContent = 'подтверждений: ' + a.acks_24h;
        $('actCmd').textContent = a.commands_24h;
        $('actCmdRes').textContent = 'ок ' + a.results_success_24h + ' · ошибок ' + a.results_failed_24h;
        $('actInProgress').textContent = a.results_in_progress;
        $('actFiles').textContent = a.files_count;
        $('actFilesSize').textContent = Ui.formatSize(a.files_bytes);

        $('storeBars').innerHTML = st.stores.length
            ? st.stores.map(function (s) { return bar(s.name + (s.is_pilot ? ' (пилот)' : ''), +s.online, +s.total, s.total > 0 && +s.online === 0, '/admin/stores/store?id=' + s.id); }).join('')
            : '<div class="muted">Магазинов пока нет — заведите на странице «Магазины».</div>';
        $('versionBars').innerHTML = st.versions.length
            ? st.versions.map(function (v) { return bar(v.version === '—' ? 'агент ещё не отчитался' : 'v' + v.version, +v.count, total, v.version === '—'); }).join('')
            : '<div class="muted">—</div>';

        // "Устаревшие" — теперь считает сервер (см. AdminStatsController::index,
        // VersionCompare): явно заданная на «Обновлениях» версия, а если не задана —
        // самая новая из реально отчитавшихся, как раньше вычислялось прямо здесь.
        const outdatedCount = st.versions.filter(function (v) { return v.outdated; }).reduce(function (sum, v) { return sum + (+v.count); }, 0);
        $('statOutdated').textContent = outdatedCount;
        $('statOutdatedSub').textContent = st.agent_version_baseline
            ? (outdatedCount ? 'актуальная — v' + st.agent_version_baseline : 'все на v' + st.agent_version_baseline)
            : '—';
        $('events').innerHTML = st.events.length
            ? st.events.map(function (ev) {
                return '<div class="event"><span class="when">' + esc(formatServerTime(ev.at)) + '</span><span class="what" title="' + esc(describeEvent(ev)) + '">' +
                    esc(describeEvent(ev)) + (ev.author ? ' <span class="muted">— ' + esc(ev.author) + '</span>' : '') + '</span></div>';
            }).join('')
            : '<div class="muted">Пока ничего не отправляли.</div>';
    }

    let attentionRows = [];

    async function loadAttention() {
        let silent = [], never = [];
        try {
            silent = await Api.get('/admin/pcs?state=silent');
            never = await Api.get('/admin/pcs?state=never');
        } catch (e) { return; }
        attentionRows = silent.concat(never);
        renderAttention();
    }

    function renderAttention() {
        const q = $('attentionSearch').value;
        const rows = attentionRows.filter(function (pc) { return Ui.pcMatches(pc, q); }).slice(0, 10);
        const tbody = document.querySelector('#attentionTable tbody');
        tbody.innerHTML = rows.length ? rows.map(function (pc) {
            return '<tr><td><a class="host-link" href="/admin/hosts/host?id=' + pc.id + '" style="color:var(--text);font-weight:600;text-decoration:none">' + esc(pc.display_name || pc.hostname) + '</a></td>' +
                '<td>' + esc(pc.store_name) + '</td><td class="muted">' + esc(pc.last_ip || '—') + '</td><td>' + Ui.agentVersionHtml(pc) + '</td>' +
                '<td class="muted">' + (pc.last_seen ? esc(formatServerTime(pc.last_seen)) : 'никогда') + '</td></tr>';
        }).join('') : '<tr><td colspan="5" class="empty">' + (q ? 'Ничего не найдено.' : 'Все кассы на связи.') + '</td></tr>';
    }

    $('attentionSearch').addEventListener('input', renderAttention);

    // ---- Ресурсы сервера (Docker cgroup или реальный хост в Native — см. ServerMetrics) --

    const MODE_NAMES = { docker: 'Docker (контейнер)', 'native-windows': 'Native (хост Windows)', 'native-linux': 'Native (хост Linux)' };
    let lastIps = [];

    function formatRate(bps) { return bps == null ? '—' : Ui.formatSize(bps) + '/с'; }

    function formatUptime(seconds) {
        if (seconds == null) return '—';
        const d = Math.floor(seconds / 86400), h = Math.floor(seconds % 86400 / 3600), m = Math.floor(seconds % 3600 / 60);
        if (d > 0) return d + 'д ' + h + 'ч';
        if (h > 0) return h + 'ч ' + m + 'м';
        return m + 'м';
    }

    async function loadMetrics() {
        let m;
        try { m = await Api.get('/admin/server-metrics'); } catch (e) { return; }

        $('metricsMode').textContent = MODE_NAMES[m.mode] || m.mode;

        $('mCpu').textContent = m.cpu.percent != null ? m.cpu.percent + '%' : '—';
        $('mCpuSub').textContent = m.cpu.note || (m.cpu.cores ? 'ядер: ' + m.cpu.cores : '');

        $('mMem').textContent = m.mem.used_bytes != null ? Ui.formatSize(m.mem.used_bytes) : '—';
        $('mMemSub').textContent = m.mem.limit_bytes
            ? 'из ' + Ui.formatSize(m.mem.limit_bytes) + (m.mem.percent != null ? ' · ' + m.mem.percent + '%' : '')
            : (m.mem.used_bytes != null ? 'лимит не задан' : '');

        $('mDisk').textContent = m.disk.percent_used != null ? m.disk.percent_used + '%' : '—';
        $('mDiskSub').textContent = (m.disk.free_bytes != null && m.disk.total_bytes != null)
            ? 'свободно ' + Ui.formatSize(m.disk.free_bytes) + ' из ' + Ui.formatSize(m.disk.total_bytes) : '';

        $('mConn').textContent = m.connections.tcp_count != null ? m.connections.tcp_count : '—';

        $('mTraffic').textContent = (m.traffic.rx_bps != null) ? '↓' + formatRate(m.traffic.rx_bps) : '—';
        $('mTrafficSub').textContent = (m.traffic.tx_bps != null) ? '↑' + formatRate(m.traffic.tx_bps) : (m.traffic.rx_bps == null ? 'копится за 2 опроса' : '');

        $('mUptime').textContent = formatUptime(m.uptime_seconds);

        lastIps = m.ips || [];
        if (!$('mIpsValue').hidden) $('mIpsValue').textContent = lastIps.length ? lastIps.join(', ') : '—';
    }

    $('mIpsReveal').addEventListener('click', function () {
        $('mIpsHidden').hidden = true;
        $('mIpsValue').hidden = false;
        $('mIpsValue').textContent = lastIps.length ? lastIps.join(', ') : '—';
    });

    // ---- Доска «Важная информация» ---------------------------------------------------------
    // Объявления для всех пользователей панели. Пишут администраторы, видят все роли;
    // истёкшие на дашборде не показываются (кнопка «Все, включая истёкшие» — показать).

    const canPost = me.role === 'administrator' || me.role === 'superadmin';
    const BOARD_LEVELS = { info: 'Информация', warning: 'Внимание', critical: 'Критично' };
    let board = [], boardAll = false;
    if (canPost) {
        $('boardAdmin').hidden = false;
        $('boardAddBtn').innerHTML = Ui.icon('plus') + 'Объявление';
    }

    function linkify(text) {
        return esc(text).replace(/(https?:\/\/[^\s<]+)/g, '<a href="$1" target="_blank" rel="noopener">$1</a>');
    }

    async function loadBoard() {
        try { board = await Api.get('/admin/announcements' + (boardAll ? '?all=1' : '')); } catch (e) { return; }
        // Блок виден, если есть что показать; администратору — всегда (чтобы было где добавить).
        $('boardCard').hidden = !board.length && !canPost;
        $('boardAllBtn').textContent = boardAll ? 'Только действующие' : 'Все, включая истёкшие';
        $('boardList').innerHTML = board.length ? board.map(function (a) {
            return '<div class="board-item ' + esc(a.level) + (+a.expired ? ' expired' : '') + '" data-id="' + a.id + '">' +
                '<div class="board-text">' + linkify(a.text) + '</div>' +
                '<div class="board-meta">' + esc(BOARD_LEVELS[a.level]) + ' · ' + esc(a.author || '—') + ' · ' + esc(formatServerTime(a.created_at)) +
                    (a.expires_at ? ' · ' + (+a.expired ? 'истекло ' : 'до ') + esc(formatServerTime(a.expires_at)) : '') + '</div>' +
                (canPost ? '<div class="actions"><button type="button" class="small ghost icon-only" data-board="' + a.id + '" title="Изменить или удалить">⋯</button></div>' : '') +
                '</div>';
        }).join('') : '<span class="muted">Объявлений нет. Напишите здесь то, что должны знать все пользователи панели: плановые работы на сервере, «в магазине №5 кассы не трогать», новые правила.</span>';
    }

    function pad(n) { return String(n).padStart(2, '0'); }
    function toLocalInput(d) { return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()) + 'T' + pad(d.getHours()) + ':' + pad(d.getMinutes()); }

    async function editBoard(a) {
        const exp = a && a.expires_at ? toLocalInput(new Date(a.expires_at.replace(' ', 'T') + 'Z')) : '';
        const ok = await Ui.modal({
            title: a ? 'Объявление' : 'Новое объявление', wide: true,
            body: '<label>Текст<span class="hint">Увидят все пользователи панели вверху дашборда. Ссылки станут кликабельными.</span>' +
                '<textarea id="bText" rows="4" placeholder="Сегодня с 22:00 до 23:00 обновляем сервер — панель будет недоступна.">' + esc(a ? a.text : '') + '</textarea></label>' +
                '<div class="row"><label>Уровень<span class="hint">Критично — красным и первым в списке, для аварий.</span><select id="bLevel">' +
                    Object.keys(BOARD_LEVELS).map(function (k) { return '<option value="' + k + '"' + ((a ? a.level : 'info') === k ? ' selected' : '') + '>' + BOARD_LEVELS[k] + '</option>'; }).join('') +
                '</select></label>' +
                '<label>Показывать до (необязательно)<span class="hint">После этого времени объявление само уйдёт с дашборда. Пусто — пока не удалят.</span>' +
                '<input type="datetime-local" id="bExpires" value="' + exp + '"></label></div>' +
                '<div class="chips"><span class="muted">Быстро:</span>' +
                    '<button type="button" class="chip link" style="font-family:inherit" data-exp="1">на сутки</button>' +
                    '<button type="button" class="chip link" style="font-family:inherit" data-exp="7">на неделю</button>' +
                    '<button type="button" class="chip link" style="font-family:inherit" data-exp="0">бессрочно</button></div>' +
                '<p class="error modal-error"></p>',
            buttons: [{ label: 'Отмена', value: null }, { label: a ? 'Сохранить' : 'Опубликовать', value: 'submit', kind: 'primary' }],
            submitOnEnter: false,
            errors: { text_required: 'введите текст', invalid_expires_at: 'неверная дата' },
            onSubmit: async function (root) {
                const text = root.querySelector('#bText').value.trim();
                if (!text) { root.querySelector('.modal-error').textContent = 'Введите текст.'; return false; }
                const expVal = root.querySelector('#bExpires').value;
                const body = { text: text, level: root.querySelector('#bLevel').value, expires_at: expVal ? new Date(expVal).toISOString() : null };
                if (a) await Api.request('PUT', '/admin/announcements/' + a.id, body);
                else await Api.post('/admin/announcements', body);
                return true;
            },
        });
        if (ok) { Ui.toast('Опубликовано на дашборде', 'success'); loadBoard(); }
    }
    document.addEventListener('click', function (e) {
        const q = e.target.closest('[data-exp]');
        if (!q) return;
        const input = document.getElementById('bExpires');
        if (!input) return;
        input.value = +q.dataset.exp ? toLocalInput(new Date(Date.now() + +q.dataset.exp * 86400000)) : '';
    });

    if (canPost) {
        $('boardAddBtn').addEventListener('click', function () { editBoard(null); });
        $('boardAllBtn').addEventListener('click', function () { boardAll = !boardAll; loadBoard(); });
        $('boardList').addEventListener('click', async function (e) {
            const b = e.target.closest('[data-board]');
            if (!b) return;
            const a = board.find(function (x) { return String(x.id) === b.dataset.board; });
            const act = await Ui.menu(b, [{ label: 'Изменить', value: 'edit' }, { label: 'Удалить', value: 'delete', danger: true }]);
            if (act === 'edit') editBoard(a);
            if (act === 'delete') {
                if (!await Ui.confirm('Удалить объявление? Оно пропадёт с дашборда у всех.', { danger: true, okLabel: 'Удалить' })) return;
                try { await Api.request('DELETE', '/admin/announcements/' + a.id); Ui.toast('Удалено', 'success'); loadBoard(); }
                catch (err) { Ui.toast('Не удалось: ' + Ui.reason(err), 'error'); }
            }
        });
    }

    async function refresh() { await Promise.all([loadBoard(), loadStats(), loadAttention(), loadMetrics()]); }

    $('refreshBtn').addEventListener('click', async function () {
        $('refreshBtn').disabled = true;
        try { await refresh(); Ui.toast('Обновлено', 'success'); } finally { $('refreshBtn').disabled = false; }
    });

    await refresh();
    setInterval(function () { if (!document.hidden) refresh(); }, 30000);
})();
