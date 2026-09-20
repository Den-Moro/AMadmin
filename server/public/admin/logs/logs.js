(async function () {
    const me = await requireAdminAuth();
    const $ = Ui.$, esc = Ui.escapeHtml;

    if (me.role === 'operator') {
        $('logView').innerHTML = '<div class="empty">Лог доступен администраторам.</div>';
        return;
    }

    const view = $('logView');
    const MAX_LINES = 5000;          // держим в DOM не больше — дальше старое выкидываем
    let lines = [];                  // буфер всех загруженных строк {ts, level, text}
    let offset = null;               // смещение в файле для следующего запроса
    let paused = false;
    let file = 'current';
    let timer = null;
    const enabled = { debug: true, info: true, warning: true, error: true, raw: true };

    function atBottom() {
        return view.scrollHeight - view.scrollTop - view.clientHeight < 40;
    }

    function matches(line) {
        if (!enabled[line.level]) return false;
        const q = $('search').value.trim().toLowerCase();
        return !q || (line.text + ' ' + (line.ts || '')).toLowerCase().indexOf(q) >= 0;
    }

    function highlight(text) {
        const q = $('search').value.trim();
        if (!q) return esc(text);
        const re = new RegExp('(' + q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + ')', 'ig');
        return esc(text).replace(re, '<mark>$1</mark>');
    }

    function render(line) {
        const div = document.createElement('div');
        div.className = 'log-line ' + line.level;
        div.innerHTML = '<span class="ts">' + esc(line.ts ? formatServerTime(line.ts) : '') + '</span>' +
            '<span class="lvl">' + esc(line.level === 'raw' ? '' : line.level) + '</span>' +
            '<span>' + highlight(line.text) + '</span>';
        return div;
    }

    function rerender() {
        view.innerHTML = '';
        const frag = document.createDocumentFragment();
        let shown = 0;
        lines.forEach(function (l) { if (matches(l)) { frag.appendChild(render(l)); shown++; } });
        view.appendChild(frag);
        if (!shown) view.innerHTML = '<div class="empty">' + (lines.length ? 'Ничего не подходит под фильтр.' : 'Лог пока пуст.') + '</div>';
        view.scrollTop = view.scrollHeight;
        $('counter').textContent = 'показано ' + shown + ' из ' + lines.length;
    }

    function append(newLines) {
        const stick = atBottom();
        if (view.querySelector('.empty')) view.innerHTML = '';
        const frag = document.createDocumentFragment();
        newLines.forEach(function (l) {
            lines.push(l);
            if (matches(l)) frag.appendChild(render(l));
        });
        view.appendChild(frag);
        if (lines.length > MAX_LINES) {
            lines = lines.slice(lines.length - MAX_LINES);
            while (view.children.length > MAX_LINES) view.removeChild(view.firstChild);
        }
        if (stick) view.scrollTop = view.scrollHeight;
        $('counter').textContent = 'показано ' + view.querySelectorAll('.log-line').length + ' из ' + lines.length;
    }

    async function poll(initial) {
        try {
            const q = new URLSearchParams();
            if (file === 'old') q.set('file', 'old');
            if (!initial && offset !== null) q.set('offset', offset);
            const r = await Api.get('/admin/logs?' + q.toString());
            if (!r.exists) {
                $('fileInfo').textContent = file === 'old' ? 'старого файла ещё нет' : 'файла лога ещё нет';
                if (initial) { lines = []; rerender(); }
                return;
            }
            if (r.reset) {
                Ui.toast('Лог был ротирован — показываю новый файл с начала', 'info');
                lines = [];
                rerender();
            }
            offset = r.offset;
            $('fileInfo').textContent = (file === 'old' ? 'app.log.old' : 'app.log') + ' · ' + Ui.formatSize(r.size);
            if (initial) { lines = r.lines; rerender(); }
            else if (r.lines.length) append(r.lines);
            // Большой хвост отдаётся кусками — дочитываем сразу, не дожидаясь таймера.
            if (r.more) await poll(false);
        } catch (err) {
            $('fileInfo').textContent = 'ошибка: ' + Ui.reason(err);
        }
    }

    function startLive() {
        stopLive();
        if (file !== 'current') return;
        timer = setInterval(function () { if (!paused && !document.hidden) poll(false); }, 2000);
    }
    function stopLive() { if (timer) clearInterval(timer); timer = null; }

    $('pauseBtn').addEventListener('click', function () {
        paused = !paused;
        $('pauseBtn').textContent = paused ? '▶ Продолжить' : '⏸ Пауза';
        $('liveDot').classList.toggle('paused', paused);
        $('liveText').textContent = paused ? 'на паузе' : 'обновляется каждые 2 с';
        if (!paused) poll(false);
    });

    $('olderBtn').addEventListener('click', async function () {
        file = file === 'current' ? 'old' : 'current';
        $('olderBtn').textContent = file === 'old' ? 'Текущий файл' : 'Старый файл';
        $('liveDot').classList.toggle('paused', file === 'old');
        $('liveText').textContent = file === 'old' ? 'старый файл, не обновляется' : (paused ? 'на паузе' : 'обновляется каждые 2 с');
        offset = null;
        await poll(true);
        startLive();
    });

    $('downloadBtn').addEventListener('click', function () { window.location.href = '/admin/logs/download'; });
    $('clearBtn').addEventListener('click', function () { lines = []; rerender(); });

    document.querySelectorAll('.lvl-chip').forEach(function (chip) {
        chip.addEventListener('click', function () {
            enabled[chip.dataset.level] = !enabled[chip.dataset.level];
            chip.classList.toggle('off', !enabled[chip.dataset.level]);
            rerender();
        });
    });

    let searchTimer;
    $('search').addEventListener('input', function () { clearTimeout(searchTimer); searchTimer = setTimeout(rerender, 200); });

    try { $('curLevel').textContent = (await Api.get('/admin/settings')).log_level || '?'; } catch (e) { $('curLevel').textContent = '?'; }

    await poll(true);
    startLive();
})();
