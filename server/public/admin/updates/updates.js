// Страница «Обновления». Порядок работы:
//   1. requireAdminAuth — кто мы и что нам можно.
//   2. loadOutdated — GET /admin/stats: какая версия считается актуальной (сервер сам
//      решает — явно заданная на этой же странице или, если не задана, самая свежая из
//      реально отчитавшихся, см. VersionCompare/AdminStatsController) и список отставших.
//   3. Файлы — тот же upload, что на «Командах» → «Файлы для раскатки», плюс путь на
//      кассе для каждого и таргет — «Отправить» создаёт пачку file_deploy-команд одним
//      действием (POST /admin/commands/batch), в истории команд они группируются по
//      update_batch_id.
(async function () {
    const me = await requireAdminAuth();
    const canEdit = me.role === 'administrator' || me.role === 'superadmin';
    const $ = Ui.$, esc = Ui.escapeHtml;

    if (canEdit) $('filesAdminCard').hidden = false;
    if (me.role === 'superadmin') {
        $('baselineCard').hidden = false;
        Ui.settingsFieldsPanel({ current_agent_version: 'text' }, 'baselineSaveBtn');
    }

    // ---- Устаревшие хосты ----------------------------------------------------------------

    async function loadOutdated() {
        const st = await Api.get('/admin/stats');
        const baseline = st.agent_version_baseline;
        const outdatedVersions = new Set(st.versions.filter(function (v) { return v.outdated; }).map(function (v) { return v.version; }));
        const outdatedCount = st.versions.filter(function (v) { return v.outdated; }).reduce(function (sum, v) { return sum + (+v.count); }, 0);

        $('outdatedSummary').textContent = baseline
            ? (outdatedCount ? 'Актуальная версия — v' + baseline + '. Устаревших: ' + outdatedCount + '.' : 'Все кассы на актуальной версии v' + baseline + '.')
            : 'Актуальная версия не задана — ни одна касса не отчиталась.';

        const tbody = document.querySelector('#outdatedTable tbody');
        if (!outdatedCount) {
            tbody.innerHTML = '<tr><td colspan="4" class="empty">Устаревших нет.</td></tr>';
            return;
        }

        const pcs = await Api.get('/admin/pcs');
        const rows = pcs.filter(function (pc) { return outdatedVersions.has(pc.agent_version || '—'); });
        tbody.innerHTML = rows.length ? rows.map(function (pc) {
            return '<tr><td><a class="host-link" href="/admin/hosts/host?id=' + pc.id + '">' + esc(pc.display_name || pc.hostname) + '</a></td>' +
                '<td>' + esc(pc.store_name) + '</td><td>' + esc(pc.agent_version || '—') + '</td>' +
                '<td class="muted">' + (pc.last_seen ? esc(formatServerTime(pc.last_seen)) : 'никогда') + '</td></tr>';
        }).join('') : '<tr><td colspan="4" class="empty">—</td></tr>';
    }

    // ---- Файлы ------------------------------------------------------------------------

    const suggestPath = function (name) { return 'C:\\AMadmin\\' + name; };

    async function loadFiles() {
        const files = await Api.get('/admin/files');
        const tbody = document.querySelector('#filesTable tbody');
        tbody.innerHTML = files.length ? files.map(function (f) {
            return '<tr data-id="' + f.id + '">' +
                '<td><input type="checkbox" data-select-file></td>' +
                '<td>' + esc(f.original_name) + '</td>' +
                '<td class="num">' + Ui.formatSize(f.size) + '</td>' +
                '<td class="muted">' + esc(formatServerTime(f.created_at)) + '</td>' +
                '<td><input type="text" data-target-path value="' + esc(suggestPath(f.original_name)) + '" style="width:100%"></td></tr>';
        }).join('') : '<tr><td colspan="5" class="empty">Файлов пока нет — загрузите ниже.</td></tr>';
    }

    // Загрузка — multipart, не JSON: браузер сам ставит boundary, обёртка Api не подходит
    // (тот же приём, что на «Командах» → «Файлы для раскатки»).
    $('uploadForm').addEventListener('submit', async function (e) {
        e.preventDefault();
        const input = $('uploadFile');
        if (!input.files.length) return;
        const form = new FormData();
        form.append('file', input.files[0]);
        const btn = $('uploadForm').querySelector('button[type=submit]');
        btn.disabled = true;
        btn.textContent = 'Загружается…';
        try {
            const response = await fetch('/admin/files', { method: 'POST', body: form });
            const data = await response.json().catch(function () { return {}; });
            if (!response.ok) {
                const code = data.error || ('http_' + response.status);
                throw new Error(code === 'file_required_or_too_large' ? 'файл больше лимита сервера (' + data.upload_max_filesize + ')' : code);
            }
            Ui.toast('Файл загружен: ' + input.files[0].name, 'success');
            $('uploadForm').reset();
            await loadFiles();
        } catch (err) {
            Ui.toast('Не удалось загрузить: ' + err.message, 'error');
        } finally {
            btn.disabled = false;
            btn.textContent = 'Загрузить';
        }
    });

    // ---- Таргет (тот же паттерн, что на «Командах») ------------------------------------

    const targetTypeEl = $('targetType'), targetIdWrap = $('targetIdWrap'), targetIdEl = $('targetId'), targetPcPickerEl = $('targetPcPicker');
    const optionsCache = {};

    async function loadTargetOptions(type) {
        if (type === 'all') { targetIdWrap.style.display = 'none'; return; }
        targetIdWrap.style.display = '';
        if (!optionsCache[type]) {
            const endpoints = { store: '/admin/stores', group: '/admin/host-groups', device_type: '/admin/device-types', pc: '/admin/pcs' };
            optionsCache[type] = await Api.get(endpoints[type]);
        }

        if (type === 'pc') {
            targetIdEl.style.display = 'none';
            targetPcPickerEl.style.display = '';
            targetIdEl.innerHTML = '';
            Ui.pcPicker(targetPcPickerEl, optionsCache.pc, function (pc) {
                targetIdEl.innerHTML = pc ? '<option value="' + pc.id + '" selected>' + esc(Ui.pcLabel(pc)) + '</option>' : '';
            });
            return;
        }

        targetIdEl.style.display = '';
        targetPcPickerEl.style.display = 'none';
        targetIdEl.innerHTML = '';
        optionsCache[type].forEach(function (item) {
            const opt = document.createElement('option');
            opt.value = item.id;
            opt.textContent = item.name;
            targetIdEl.appendChild(opt);
        });
    }
    targetTypeEl.addEventListener('change', function () { loadTargetOptions(targetTypeEl.value); });

    $('sendUpdateBtn').addEventListener('click', async function () {
        const selected = Array.prototype.filter.call(document.querySelectorAll('#filesTable tbody tr[data-id]'), function (tr) {
            const cb = tr.querySelector('[data-select-file]');
            return cb && cb.checked;
        });
        if (!selected.length) { Ui.toast('Отметьте хотя бы один файл', 'error'); return; }

        const targetType = targetTypeEl.value;
        const targetId = targetType === 'all' ? null : targetIdEl.value;
        if (targetType !== 'all' && !targetId) { Ui.toast('Выберите, кому именно', 'error'); return; }

        const items = selected.map(function (tr) {
            return { type: 'file_deploy', payload: { file_id: tr.dataset.id, target_path: tr.querySelector('[data-target-path]').value.trim() } };
        });
        if (items.some(function (it) { return !it.payload.target_path; })) {
            Ui.toast('Укажите путь на кассе для каждого отмеченного файла', 'error');
            return;
        }

        if (!await Ui.confirm('Отправить ' + items.length + ' файл(ов)? Отменить после отправки нельзя.', { okLabel: 'Отправить', danger: true })) return;

        try {
            await Api.post('/admin/commands/batch', { target: { type: targetType, id: targetId }, items: items });
            Ui.toast('Отправлено — результаты появятся на странице «Команды» по мере опроса касс.', 'success');
            document.querySelectorAll('#filesTable [data-select-file]').forEach(function (cb) { cb.checked = false; });
        } catch (err) {
            Ui.toast('Не удалось отправить: ' + Ui.reason(err, { target_path_must_be_absolute_windows_path: 'путь на кассе должен быть полным, например C:\\Папка\\файл.exe' }), 'error');
        }
    });

    await loadOutdated();
    if (canEdit) await loadFiles();
    setInterval(function () { if (!document.hidden) loadOutdated(); }, 30000);
})();
