// Дашборд. Порядок работы:
//   1. requireAdminAuth — сессия и роль.
//   2. loadStats — одна сводка GET /admin/stats (парк, активность за сутки, магазины,
//      версии агентов, лента событий).
//   3. loadAttention — кассы, которые молчат больше суток / ни разу не выходили
//      (GET /admin/pcs?state=silent|never), первые 10.
//   4. «Обновить» и таймер раз в 30 с (только пока вкладка видна) повторяют 2–3.
(async function () {
    await requireAdminAuth();
    const $ = Ui.$, esc = Ui.escapeHtml;

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
        const p = st.pcs, a = st.activity;
        const total = +p.total, online = +p.online;
        $('statTotal').textContent = total;
        $('statNever').innerHTML = +p.never_seen ? '<a href="/admin/hosts/hosts.html?state=never">ни разу не выходили: ' + p.never_seen + '</a>' : 'все выходили на связь';
        $('statOnline').textContent = online;
        $('statOnlinePct').textContent = total ? Math.round(online / total * 100) + '% парка' : '';
        $('statOffline').textContent = total - online;
        $('statSilent').innerHTML = +p.silent_day ? '<a href="/admin/hosts/hosts.html?state=silent">молчат больше суток: ' + p.silent_day + '</a>' : '';
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
            ? st.stores.map(function (s) { return bar(s.name + (s.is_pilot ? ' (пилот)' : ''), +s.online, +s.total, s.total > 0 && +s.online === 0, '/admin/hosts/hosts.html?store_id=' + s.id); }).join('')
            : '<div class="muted">Магазинов пока нет — добавьте в Справочниках.</div>';
        $('versionBars').innerHTML = st.versions.length
            ? st.versions.map(function (v) { return bar(v.version === '—' ? 'агент ещё не отчитался' : 'v' + v.version, +v.count, total, v.version === '—'); }).join('')
            : '<div class="muted">—</div>';
        $('events').innerHTML = st.events.length
            ? st.events.map(function (ev) {
                return '<div class="event"><span class="when">' + esc(formatServerTime(ev.at)) + '</span><span class="what" title="' + esc(describeEvent(ev)) + '">' +
                    esc(describeEvent(ev)) + (ev.author ? ' <span class="muted">— ' + esc(ev.author) + '</span>' : '') + '</span></div>';
            }).join('')
            : '<div class="muted">Пока ничего не отправляли.</div>';
    }

    async function loadAttention() {
        let silent = [], never = [];
        try {
            silent = await Api.get('/admin/pcs?state=silent');
            never = await Api.get('/admin/pcs?state=never');
        } catch (e) { return; }
        const rows = silent.concat(never).slice(0, 10);
        const tbody = document.querySelector('#attentionTable tbody');
        tbody.innerHTML = rows.length ? rows.map(function (pc) {
            return '<tr><td><a class="host-link" href="/admin/hosts/host.html?id=' + pc.id + '" style="color:var(--text);font-weight:600;text-decoration:none">' + esc(pc.display_name || pc.hostname) + '</a></td>' +
                '<td>' + esc(pc.store_name) + '</td><td>' + esc(pc.agent_version || '—') + '</td>' +
                '<td class="muted">' + (pc.last_seen ? esc(formatServerTime(pc.last_seen)) : 'никогда') + '</td></tr>';
        }).join('') : '<tr><td colspan="4" class="empty">Все кассы на связи.</td></tr>';
    }

    async function refresh() { await Promise.all([loadStats(), loadAttention()]); }

    $('refreshBtn').addEventListener('click', async function () {
        $('refreshBtn').disabled = true;
        try { await refresh(); Ui.toast('Обновлено', 'success'); } finally { $('refreshBtn').disabled = false; }
    });

    await refresh();
    setInterval(function () { if (!document.hidden) refresh(); }, 30000);
})();
