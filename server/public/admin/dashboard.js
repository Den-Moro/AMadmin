// Дашборд. Порядок работы:
//   1. requireAdminAuth — сессия и роль.
//   2. loadStats — одна сводка GET /admin/stats (парк, активность за сутки, магазины,
//      версии агентов, лента событий).
//   3. loadAttention — кассы, которые молчат больше суток / ни разу не выходили
//      (GET /admin/pcs?state=silent|never), первые 10.
//   4. «Обновить» и таймер раз в 30 с (только пока вкладка видна) повторяют 2–3.
(async function () {
    const me = await requireAdminAuth();
    const $ = Ui.$, esc = Ui.escapeHtml;

    if (me.role === 'superadmin') {
        $('ntpCard').hidden = false;
        Ui.settingsFieldsPanel({
            ntp_enabled: 'bool', ntp_server_address: 'text',
            ntp_drift_threshold_seconds: 'text', ntp_check_interval_seconds: 'text',
        }, 'ntpSaveBtn');
    }

    function renderNtp(ntp) {
        if (!ntp || !ntp.enabled) { $('ntpWarning').hidden = true; if ($('ntpStatusLine')) $('ntpStatusLine').textContent = ''; return; }
        const line = $('ntpStatusLine');
        if (line) {
            line.textContent = !ntp.ok
                ? 'Проверка не удалась (' + ntp.server + '): ' + ntp.error
                : 'Расхождение с ' + ntp.server + ': ' + ntp.drift_seconds + ' с (проверено ' + formatServerTime(ntp.checked_at) + ')';
        }
        const bad = !ntp.ok || Math.abs(+ntp.drift_seconds) > +ntp.threshold_seconds;
        $('ntpWarning').hidden = !bad;
        if (bad) {
            $('ntpWarning').textContent = !ntp.ok
                ? 'NTP: проверка времени сервера не удалась (' + ntp.server + '): ' + ntp.error
                : 'NTP: часы сервера разошлись с ' + ntp.server + ' на ' + ntp.drift_seconds + ' с — больше порога ' + ntp.threshold_seconds + ' с.';
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
        $('statNever').innerHTML = +p.never_seen ? '<a href="/admin/hosts?state=never">ни разу не выходили: ' + p.never_seen + '</a>' : 'все выходили на связь';
        $('statOnline').textContent = online;
        $('statOnlinePct').textContent = total ? Math.round(online / total * 100) + '% парка' : '';
        $('statOffline').textContent = total - online;
        $('statSilent').innerHTML = +p.silent_day ? '<a href="/admin/hosts?state=silent">молчат больше суток: ' + p.silent_day + '</a>' : '';
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
            ? st.stores.map(function (s) { return bar(s.name + (s.is_pilot ? ' (пилот)' : ''), +s.online, +s.total, s.total > 0 && +s.online === 0, '/admin/hosts?store_id=' + s.id); }).join('')
            : '<div class="muted">Магазинов пока нет — добавьте в Справочниках.</div>';
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
                '<td>' + esc(pc.store_name) + '</td><td class="muted">' + esc(pc.last_ip || '—') + '</td><td>' + esc(pc.agent_version || '—') + '</td>' +
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

    async function refresh() { await Promise.all([loadStats(), loadAttention(), loadMetrics()]); }

    $('refreshBtn').addEventListener('click', async function () {
        $('refreshBtn').disabled = true;
        try { await refresh(); Ui.toast('Обновлено', 'success'); } finally { $('refreshBtn').disabled = false; }
    });

    await refresh();
    setInterval(function () { if (!document.hidden) refresh(); }, 30000);
})();
