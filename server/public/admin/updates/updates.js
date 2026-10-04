// Страница «Обновления»: версии агента (номер, статус, что изменилось, файлы), что стоит
// на кассах, мастер «Новая версия» и раскатка любой версии — в том числе откат на
// стабильную. Раскатка — POST /admin/agent-releases/{id}/deploy: сервер сам собирает
// пачку file_deploy-команд в папку агента (одна на файл, общий update_batch_id).
(async function () {
    const me = await requireAdminAuth();
    const canEdit = me.role === 'administrator' || me.role === 'superadmin';
    const $ = Ui.$, esc = Ui.escapeHtml;

    $('helpBtn').innerHTML = Ui.icon('info') + 'Как это работает';
    $('rollbackBtn').innerHTML = Ui.icon('refresh') + 'Откатиться на стабильную…';
    $('newReleaseBtn').innerHTML = Ui.icon('plus') + 'Новая версия';
    ['helpCloseBtn', 'newCloseBtn', 'deployCloseBtn', 'sentCloseBtn'].forEach(function (id) { $(id).innerHTML = Ui.icon('x'); });
    $('dropIcon').outerHTML = Ui.icon('upload');
    if (canEdit) $('adminActions').hidden = false;

    const STATUS = {
        testing: { label: 'тестовая', badge: 'badge-warn', tip: 'Новая версия, проверяется на пилоте. На все кассы — после проверки.' },
        stable: { label: 'стабильная', badge: 'badge-success', tip: 'Проверена — можно на все кассы. На стабильную откатываются.' },
        bad: { label: 'отозвана', badge: 'badge-danger', tip: 'В версии нашлась проблема — раскатать её нельзя. Чтобы всё-таки отправить, сначала смените статус.' },
    };
    const ERRORS = {
        version_invalid: 'номер версии — числа через точку, например 0.1.6', version_exists: 'такая версия уже сохранена',
        invalid_status: 'неверный статус', files_required: 'загрузите хотя бы один файл', file_not_found: 'файл не найден — возможно, его удалили',
        config_json_forbidden: 'config.json в версию класть нельзя — у каждой кассы он свой', duplicate_file_names: 'два файла с одинаковым именем',
        release_is_bad: 'версия отозвана — сначала смените ей статус', release_has_no_files: 'в версии нет файлов',
        install_dir_must_be_absolute_windows_path: 'папка агента — полный путь, например C:\\AMadmin',
        invalid_target_type: 'неверный тип цели', target_id_required: 'выберите, кому именно', insufficient_role: 'нужна роль администратора',
        target_path_invalid_chars: 'в пути недопустимые символы', target_path_must_be_absolute_windows_path: 'папка агента — полный путь, например C:\\AMadmin',
    };

    // Сравнение версий «0.1.10» > «0.1.9» — по числам, как на сервере (VersionCompare).
    function verCmp(a, b) {
        const pa = String(a || '').split('.').map(Number), pb = String(b || '').split('.').map(Number);
        for (let i = 0; i < 3; i++) {
            const x = pa[i] || 0, y = pb[i] || 0;
            if (x !== y) return x < y ? -1 : 1;
        }
        return 0;
    }
    const isVer = function (v) { return /^\d/.test(String(v || '')); };

    function statusBadge(s) {
        const st = STATUS[s] || STATUS.testing;
        return '<span class="badge ' + st.badge + '" title="' + esc(st.tip) + '">' + st.label + '</span>';
    }

    // ---- Инструкция: открыта при первом заходе, дальше — по кнопке ---------------------

    let helpSeen = false;
    try { helpSeen = localStorage.getItem('amadmin-updates-help') === 'hidden'; } catch (e) { /* — */ }
    $('helpCard').hidden = helpSeen;
    function setHelp(open) {
        $('helpCard').hidden = !open;
        try { localStorage.setItem('amadmin-updates-help', open ? 'shown' : 'hidden'); } catch (e) { /* — */ }
        if (open) $('helpCard').scrollIntoView({ behavior: 'smooth', block: 'start' });
    }
    $('helpBtn').addEventListener('click', function () { setHelp($('helpCard').hidden); });
    $('helpCloseBtn').addEventListener('click', function () { setHelp(false); });

    // ---- Данные -----------------------------------------------------------------------------

    let releases = [], installDir = 'C:\\AMadmin', stats = null, pcs = [], commands = [];

    async function load() {
        const [r, st, list] = await Promise.all([Api.get('/admin/agent-releases'), Api.get('/admin/stats'), Api.get('/admin/pcs')]);
        releases = r.releases;
        installDir = r.install_dir || installDir;
        stats = st;
        pcs = list;
        renderOverview();
        renderReleases();
    }

    const latestStable = function () { return releases.find(function (r) { return r.status === 'stable'; }) || null; };
    const onVersion = function (v) { return pcs.filter(function (pc) { return pc.agent_version === v; }).length; };

    function renderOverview() {
        const baseline = stats.agent_version_baseline;
        const sources = { manual: 'задана вручную', stable: 'последняя стабильная (авто)', newest_seen: 'самая новая на кассах (авто)' };
        $('ovCurrent').textContent = baseline || '—';
        const rel = releases.find(function (r) { return r.version === baseline; });
        $('ovCurrentSub').innerHTML = baseline
            ? esc(sources[stats.agent_version_baseline_source] || '') + (rel ? ' · ' + statusBadge(rel.status) : ' · <span title="Такой версии нет в списке ниже — её файлов на сервере нет, раскатать её отсюда нельзя">нет в списке версий</span>') +
              (canEdit && stats.agent_version_baseline_source === 'manual' ? ' <button type="button" class="small ghost" id="baselineAutoBtn" title="Считать актуальной последнюю стабильную версию автоматически">авто</button>' : '')
            : 'ни одна касса ещё не отчиталась';

        const stable = latestStable();
        $('ovStable').textContent = stable ? stable.version : '—';
        $('ovStableSub').textContent = stable ? 'на ' + onVersion(stable.version) + ' ' + Ui.plural(onVersion(stable.version), 'кассе', 'кассах', 'кассах') : 'пометьте проверенную версию стабильной';
        $('rollbackBtn').disabled = !stable;
        $('rollbackBtn').title = stable
            ? 'Раскатать стабильную версию ' + stable.version + ' — например, если новая оказалась с проблемой'
            : 'Нет стабильной версии — откатываться некуда. Пометьте проверенную версию «стабильной»';

        const reported = pcs.filter(function (pc) { return isVer(pc.agent_version); });
        const onCurrent = baseline ? reported.filter(function (pc) { return verCmp(pc.agent_version, baseline) >= 0; }).length : 0;
        const outdated = baseline ? reported.filter(function (pc) { return verCmp(pc.agent_version, baseline) < 0; }) : [];
        const mixed = pcs.filter(function (pc) { return pc.mgmt_agent_version && pc.ui_agent_version && pc.mgmt_agent_version !== pc.ui_agent_version; }).length;
        $('ovOnCurrent').textContent = onCurrent;
        $('ovOnCurrentSub').textContent = 'из ' + pcs.length + ' ' + Ui.plural(pcs.length, 'кассы', 'касс', 'касс') +
            (mixed ? ' · у ' + mixed + ' служба и окно на разных версиях (окно сменится при входе кассира)' : '') +
            (pcs.length - reported.length ? ' · ' + (pcs.length - reported.length) + ' не отчитались' : '');
        $('ovOutdated').textContent = outdated.length;
        $('ovOutdatedSub').innerHTML = outdated.length
            ? '<button type="button" class="small" id="showOutdatedBtn">' + ($('outdatedCard').hidden ? 'Показать' : 'Скрыть') + ' список</button>'
            : 'все на актуальной';
        if (!outdated.length) $('outdatedCard').hidden = true;

        $('outdatedSummary').textContent = baseline ? 'ниже ' + baseline : '';
        document.querySelector('#outdatedTable tbody').innerHTML = outdated.map(function (pc) {
            return '<tr><td><a class="host-link" href="/admin/hosts/host?id=' + pc.id + '">' + esc(pc.display_name || pc.hostname) + '</a></td>' +
                '<td>' + esc(pc.store_name) + '</td><td>' + Ui.agentVersionHtml(pc) + '</td>' +
                '<td class="muted">' + (pc.last_seen ? esc(formatServerTime(pc.last_seen)) : 'никогда') + '</td></tr>';
        }).join('');
    }

    $('overview').addEventListener('click', async function (e) {
        if (e.target.closest('#showOutdatedBtn')) {
            $('outdatedCard').hidden = !$('outdatedCard').hidden;
            renderOverview();
        }
        if (e.target.closest('#baselineAutoBtn')) {
            try { await Api.request('PUT', '/admin/settings', { current_agent_version: '' }); Ui.toast('Актуальная версия — снова автоматически', 'success'); await load(); }
            catch (err) { Ui.toast('Не удалось: ' + Ui.reason(err), 'error'); }
        }
    });

    // ---- Список версий ---------------------------------------------------------------------

    function renderReleases() {
        const tbody = document.querySelector('#releasesTable tbody');
        const open = new Set([...tbody.querySelectorAll('tr.open')].map(function (tr) { return tr.dataset.id; }));
        if (!releases.length) {
            tbody.innerHTML = '<tr><td colspan="6">' + Ui.emptyState({
                icon: 'package', title: 'Версий пока нет',
                text: canEdit ? 'Нажмите «Новая версия» и перетащите файлы сборки из dist\\client — номер подставится сам. Инструкция — кнопка «Как это работает».'
                    : 'Добавлять версии может администратор.',
            }) + '</td></tr>';
            return;
        }
        const baseline = stats.agent_version_baseline;
        tbody.innerHTML = releases.map(function (r) {
            const n = onVersion(r.version);
            const isRollback = baseline && verCmp(r.version, baseline) < 0;
            return '<tr class="clickable" data-id="' + r.id + '">' +
                '<td class="nowrap"><span class="ver">' + esc(r.version) + '</span>' +
                    (r.version === baseline ? ' <span class="badge badge-accent plain" title="С этой версией сравниваются все кассы">актуальная</span>' : '') +
                    '<span class="muted" style="display:block;font-size:12px">' + esc(formatServerTime(r.created_at)) + ' · ' + esc(r.created_by_username || '—') + '</span></td>' +
                '<td>' + statusBadge(r.status) + '</td>' +
                '<td>' + (r.notes ? '<div class="notes-short">' + esc(r.notes) + '</div>' : '<span class="muted">описания нет</span>') + '</td>' +
                '<td class="num">' + (n ? '<b>' + n + '</b>' : '<span class="muted">0</span>') + '</td>' +
                '<td class="nowrap" style="font-size:12.5px">' + (+r.deploy_count
                    ? +r.deploy_count + ' ' + Ui.plural(+r.deploy_count, 'раз', 'раза', 'раз') + '<span class="muted" style="display:block">' + esc(formatServerTime(r.last_deployed_at)) + '</span>'
                    : '<span class="muted">не раскатывали</span>') + '</td>' +
                '<td><div class="actions" style="flex-wrap:nowrap">' + (canEdit
                    ? '<button type="button" class="small' + (r.status === 'stable' && isRollback ? ' danger' : '') + '" data-act="deploy"' +
                        (r.status === 'bad' ? ' disabled title="Версия отозвана — раскатать нельзя. Чтобы всё-таки отправить, смените ей статус в меню ⋯"'
                            : ' title="' + (isRollback ? 'Откатить кассы на эту версию' : 'Раскатать эту версию на кассы') + '"') + '>' +
                        Ui.icon('send') + (isRollback ? 'Откатить…' : 'Раскатать…') + '</button>' +
                      '<button type="button" class="small ghost icon-only" data-act="more" title="Описание и статус, сделать актуальной, удалить">⋯</button>'
                    : '') + '</div></td></tr>';
        }).join('');
        open.forEach(function (id) {
            const tr = tbody.querySelector('tr[data-id="' + id + '"]');
            if (tr) Ui.toggleDetail(tr, detailHtml(releases.find(function (r) { return String(r.id) === id; })), 6);
        });
    }

    function detailHtml(r) {
        return (r.notes ? '<p class="notes-full">' + esc(r.notes) + '</p>' : '') +
            '<table><thead><tr><th>Файл</th><th>Версия файла</th><th style="text-align:right">Размер</th><th>SHA-256</th></tr></thead><tbody>' +
            r.files.map(function (f) {
                const off = f.pe_version && /^amadmin\./i.test(f.original_name) && f.pe_version !== r.version;
                return '<tr><td>' + esc(f.original_name) + '</td>' +
                    '<td class="upload-ver">' + (f.pe_version ? esc(f.pe_version) + (off ? ' <span class="badge badge-warn plain" title="Версия внутри файла не совпадает с номером версии">≠</span>' : '') : '<span class="muted">—</span>') + '</td>' +
                    '<td class="num">' + Ui.formatSize(+f.size) + '</td><td><code title="' + esc(f.sha256) + '">' + esc(f.sha256.slice(0, 12)) + '…</code></td></tr>';
            }).join('') + '</tbody></table>' +
            '<p class="muted" style="margin:8px 0 0">' +
                (r.status_changed_at ? 'Статус менялся ' + esc(formatServerTime(r.status_changed_at)) + '. ' : '') +
                (r.last_batch_command_ids.length ? '<a href="/admin/commands?watch=' + r.last_batch_command_ids.join(',') + '">Ход последней раскатки по каждой кассе →</a>' : 'Эту версию ещё не раскатывали.') +
            '</p>';
    }

    document.querySelector('#releasesTable').addEventListener('click', async function (e) {
        if (e.target.closest('a')) return;
        const tr = e.target.closest('tr[data-id]');
        if (!tr) return;
        const r = releases.find(function (x) { return String(x.id) === tr.dataset.id; });
        const btn = e.target.closest('button[data-act]');
        if (btn && btn.dataset.act === 'deploy') { openDeploy(r); return; }
        if (btn && btn.dataset.act === 'more') { releaseMenu(btn, r); return; }
        Ui.toggleDetail(tr, detailHtml(r), 6);
    });

    async function releaseMenu(anchor, r) {
        const items = [{ label: 'Изменить описание и статус…', value: 'edit' }];
        if (r.status !== 'stable') items.push({ label: 'Пометить стабильной', value: 'stable' });
        if (r.status !== 'testing') items.push({ label: 'Пометить тестовой', value: 'testing' });
        if (r.status !== 'bad') items.push({ label: 'Отозвать (нашлась проблема)', value: 'bad', danger: true });
        if (r.version !== stats.agent_version_baseline) items.push({ label: 'Сделать актуальной', value: 'current' });
        items.push({ label: 'Удалить версию…', value: 'delete', danger: true });
        const act = await Ui.menu(anchor, items);
        if (!act) return;
        try {
            if (act === 'edit') return editRelease(r);
            if (act === 'stable' || act === 'testing') {
                await Api.request('PUT', '/admin/agent-releases/' + r.id, { status: act });
                Ui.toast('Версия ' + r.version + ' — ' + STATUS[act].label, 'success');
            }
            if (act === 'bad') {
                if (!await Ui.confirm('Отозвать версию ' + r.version + '? Раскатать её будет нельзя, пока не смените статус. Кассы, где она уже стоит, это не затронет — чтобы вернуть их, откатитесь на стабильную.', { okLabel: 'Отозвать', danger: true })) return;
                await Api.request('PUT', '/admin/agent-releases/' + r.id, { status: 'bad' });
                Ui.toast('Версия ' + r.version + ' отозвана', 'success');
            }
            if (act === 'current') {
                await Api.request('PUT', '/admin/settings', { current_agent_version: r.version });
                Ui.toast('Актуальная версия — ' + r.version, 'success');
            }
            if (act === 'delete') {
                const lastStable = r.status === 'stable' && releases.filter(function (x) { return x.status === 'stable'; }).length === 1;
                const onIt = onVersion(r.version);
                if (!await Ui.confirm('Удалить версию ' + r.version + ' вместе с её файлами на сервере?' +
                    (lastStable ? ' Это единственная стабильная версия — откатываться станет некуда.' : '') +
                    (onIt ? ' На ней сейчас ' + onIt + ' ' + Ui.plural(onIt, 'касса', 'кассы', 'касс') + ' — им это не повредит, но раскатать её снова будет нельзя.' : '') +
                    ' История раскаток в «Командах» останется.', { okLabel: 'Удалить', danger: true })) return;
                await Api.request('DELETE', '/admin/agent-releases/' + r.id);
                Ui.toast('Версия ' + r.version + ' удалена', 'success');
            }
            await load();
        } catch (err) { Ui.toast('Не удалось: ' + Ui.reason(err, ERRORS), 'error'); }
    }

    async function editRelease(r) {
        const ok = await Ui.modal({
            title: 'Версия ' + r.version,
            body: '<label>Статус<span class="hint">Тестовая — проверяется на пилоте. Стабильная — можно на все кассы, на неё откатываются. Отозвана — нашлась проблема, раскатать нельзя.</span>' +
                '<select id="eStatus">' + ['testing', 'stable', 'bad'].map(function (s) {
                    return '<option value="' + s + '"' + (s === r.status ? ' selected' : '') + '>' + STATUS[s].label + '</option>';
                }).join('') + '</select></label>' +
                '<label>Что изменилось<span class="hint">Что исправлено, что нового, на что обратить внимание — видно в списке версий и при раскатке.</span>' +
                '<textarea id="eNotes" rows="6">' + esc(r.notes || '') + '</textarea></label><p class="error modal-error"></p>',
            buttons: [{ label: 'Отмена', value: null }, { label: 'Сохранить', value: 'submit', kind: 'primary' }],
            submitOnEnter: false, errors: ERRORS,
            onSubmit: async function (root) {
                await Api.request('PUT', '/admin/agent-releases/' + r.id, { status: root.querySelector('#eStatus').value, notes: root.querySelector('#eNotes').value });
                return true;
            },
        });
        if (ok) { Ui.toast('Сохранено', 'success'); await load(); }
    }

    // ---- Собрать версии из ранее загруженных файлов ---------------------------------------

    async function checkImport() {
        if (!canEdit) return;
        let preview;
        try { preview = await Api.get('/admin/agent-releases/import'); } catch (e) { return; }
        const v = preview.versions;
        $('importNote').hidden = !v.length;
        if (!v.length) return;
        $('importNote').innerHTML = 'Среди загруженных раньше файлов есть сборки агента: ' +
            v.map(function (x) { return '<b>' + esc(x.version) + '</b> (' + x.files.map(function (f) { return esc(f.original_name); }).join(', ') + ')'; }).join('; ') +
            '. Соберите из них версии, чтобы на них можно было откатиться. ' +
            '<button type="button" class="small primary" id="importBtn" style="margin-left:6px">Собрать версии</button>';
    }
    $('importNote').addEventListener('click', async function (e) {
        if (!e.target.closest('#importBtn')) return;
        try {
            const r = await Api.post('/admin/agent-releases/import', {});
            Ui.toast('Собрано версий: ' + r.created.length + '. Проверьте статусы и допишите, что в них изменилось.', 'success');
            await load();
            await checkImport();
        } catch (err) { Ui.toast('Не удалось: ' + Ui.reason(err, ERRORS), 'error'); }
    });

    // ---- Мастер «Новая версия» ------------------------------------------------------------

    let uploaded = []; // [{id, name, size, version}]

    function openNew() {
        uploaded = [];
        $('uploadList').innerHTML = '';
        $('relVersion').value = '';
        $('relStatus').value = 'testing';
        $('relNotes').value = '';
        $('newError').textContent = '';
        $('newWarn').hidden = true;
        $('deployCard').hidden = true;
        $('newCard').hidden = false;
        refreshNewSteps();
        $('newCard').scrollIntoView({ behavior: 'smooth', block: 'start' });
    }
    $('newReleaseBtn').addEventListener('click', openNew);
    $('newCloseBtn').addEventListener('click', function () { $('newCard').hidden = true; });
    $('newCancelBtn').addEventListener('click', function () { $('newCard').hidden = true; });

    const dz = $('dropzone');
    ['dragenter', 'dragover'].forEach(function (ev) { dz.addEventListener(ev, function (e) { e.preventDefault(); dz.classList.add('over'); }); });
    ['dragleave', 'drop'].forEach(function (ev) { dz.addEventListener(ev, function (e) { e.preventDefault(); dz.classList.remove('over'); }); });
    dz.addEventListener('drop', function (e) { if (e.dataTransfer.files.length) uploadAll(Array.from(e.dataTransfer.files)); });
    $('uploadInput').addEventListener('change', function () { if (this.files.length) uploadAll(Array.from(this.files)); this.value = ''; });

    // Не нужны для обновления: config.json у каждой кассы свой (ключ доступа), а
    // установщики и пример конфига на установленной кассе ни к чему.
    function skipReason(name) {
        const n = name.toLowerCase();
        if (n === 'config.json') return 'пропущен: у каждой кассы свой config.json (ключ доступа) — его раскатывать нельзя';
        if (n === 'config.example.json' || /^(un)?install-client\.(ps1|cmd)$/.test(n)) return 'пропущен: для обновления не нужен';
        return '';
    }

    // Список файлов копируется в массив сразу: FileList поля выбора живой — очистка поля
    // (value = '') посреди загрузки обнуляла его, и из нескольких файлов уходил только первый.
    function uploadOne(file, item) {
        return new Promise(function (resolve, reject) {
            const form = new FormData();
            form.append('file', file);
            const xhr = new XMLHttpRequest();
            xhr.open('POST', '/admin/files');
            xhr.upload.addEventListener('progress', function (e) {
                if (e.lengthComputable) item.querySelector('.fill').style.width = (e.loaded / e.total * 100).toFixed(1) + '%';
            });
            xhr.addEventListener('load', function () {
                let data = {};
                try { data = JSON.parse(xhr.responseText); } catch (e) { /* — */ }
                if (xhr.status >= 200 && xhr.status < 300) return resolve(data);
                const code = data.error || ('http_' + xhr.status);
                reject(new Error(code === 'file_required_or_too_large' ? 'больше лимита сервера (' + data.upload_max_filesize + ')' : (ERRORS[code] || code)));
            });
            xhr.addEventListener('error', function () { reject(new Error('сеть недоступна')); });
            xhr.send(form);
        });
    }

    async function uploadAll(fileList) {
        for (const file of fileList) {
            const item = document.createElement('div');
            item.className = 'upload-item';
            item.innerHTML = '<span>' + esc(file.name) + '</span><span class="muted"></span><div class="track"><div class="fill"></div></div>';
            $('uploadList').appendChild(item);
            const skip = skipReason(file.name);
            if (skip) { item.classList.add('bad'); item.querySelector('.muted').textContent = skip; continue; }
            item.querySelector('.muted').textContent = Ui.formatSize(file.size);
            try {
                const res = await uploadOne(file, item);
                uploaded = uploaded.filter(function (u) { return u.name.toLowerCase() !== file.name.toLowerCase(); });
                uploaded.push({ id: String(res.id), name: file.name, size: file.size, version: res.version || null });
                item.querySelector('.muted').innerHTML = res.version
                    ? 'версия в файле: <span class="upload-ver">' + esc(res.version) + '</span>' : 'загружен';
            } catch (err) {
                item.classList.add('bad');
                item.querySelector('.muted').textContent = 'ошибка: ' + err.message;
            }
        }
        // Номер версии — из службы управления (её версию и показывает хост), иначе из любого .exe.
        if (!$('relVersion').value.trim()) {
            const pick = uploaded.find(function (u) { return /^amadmin\.managementagent\.exe$/i.test(u.name) && u.version; }) ||
                uploaded.find(function (u) { return /\.exe$/i.test(u.name) && u.version; });
            if (pick) $('relVersion').value = pick.version;
        }
        refreshNewSteps();
    }

    function newProblems() {
        const problems = [], warns = [];
        const v = $('relVersion').value.trim();
        if (!uploaded.length) problems.push('загрузите файлы сборки');
        if (!/^\d{1,5}(\.\d{1,5}){1,2}$/.test(v)) problems.push('номер версии — числа через точку, например 0.1.6');
        else if (releases.some(function (r) { return verCmp(r.version, v) === 0; })) problems.push('версия ' + v + ' уже есть в списке');
        const need = ['AMadmin.ManagementAgent.exe', 'AMadmin.UiAgent.exe', 'AMadmin.Core.dll'];
        const missing = need.filter(function (n) { return !uploaded.some(function (u) { return u.name.toLowerCase() === n.toLowerCase(); }); });
        if (uploaded.length && missing.length) warns.push('нет ' + missing.join(', ') + ' — обычно в версию входят все три. Если менялся только один файл, это допустимо');
        const off = uploaded.filter(function (u) { return u.version && /^amadmin\./i.test(u.name) && /^\d/.test(v) && verCmp(u.version, v) !== 0; });
        if (off.length) warns.push('версия внутри ' + off.map(function (u) { return u.name + ' (' + u.version + ')'; }).join(', ') + ' не совпадает с номером ' + v + ' — проверьте, что файлы из одной сборки');
        return { problems: problems, warns: warns };
    }

    function refreshNewSteps() {
        const p = newProblems();
        document.querySelector('#newCard [data-step="files"]').classList.toggle('done', uploaded.length > 0);
        document.querySelector('#newCard [data-step="info"]').classList.toggle('done', !p.problems.length);
        $('newWarn').hidden = !p.warns.length;
        $('newWarn').innerHTML = p.warns.map(function (w) { return '⚠ ' + esc(w); }).join('<br>');
    }
    $('relVersion').addEventListener('input', refreshNewSteps);

    async function saveRelease(thenDeploy) {
        const p = newProblems();
        if (p.problems.length) { $('newError').textContent = 'Проверьте: ' + p.problems.join('; ') + '.'; return; }
        $('newError').textContent = '';
        try {
            const res = await Api.post('/admin/agent-releases', {
                version: $('relVersion').value.trim(), status: $('relStatus').value, notes: $('relNotes').value,
                file_ids: uploaded.map(function (u) { return u.id; }),
            });
            Ui.toast('Версия ' + res.version + ' сохранена', 'success');
            $('newCard').hidden = true;
            await load();
            await checkImport();
            if (thenDeploy) openDeploy(releases.find(function (r) { return +r.id === +res.id; }));
        } catch (err) {
            $('newError').textContent = 'Не удалось сохранить: ' + Ui.reason(err, ERRORS);
        }
    }
    $('newCard').addEventListener('submit', function (e) { e.preventDefault(); saveRelease(false); });
    $('newSaveDeployBtn').addEventListener('click', function () { saveRelease(true); });

    // ---- Мастер «Раскатать версию» ---------------------------------------------------------

    let deploying = null, deployRollback = false, target = null, targetState = { type: 'all', id: null, total: 0, online: 0 };

    async function openDeploy(r, opts) {
        opts = opts || {};
        deploying = r;
        deployRollback = !!opts.rollback;
        $('newCard').hidden = true;
        $('sentCard').hidden = true;
        $('deployCard').hidden = false;
        $('deployError').textContent = '';
        $('installDir').value = installDir;
        $('deployBadge').innerHTML = statusBadge(r.status);
        $('deployNotes').hidden = !r.notes;
        $('deployNotes').textContent = r.notes || '';
        if (!target) target = Ui.targetPicker($('targetBox'), { onChange: function (s) { targetState = s; renderDeploy(); } });
        if (opts.rollback) await target.set('all');
        $('makeCurrent').checked = !!opts.rollback || (r.status === 'stable' && targetState.type === 'all');
        renderDeploy();
        $('deployCard').scrollIntoView({ behavior: 'smooth', block: 'start' });
    }

    function renderDeploy() {
        const r = deploying;
        if (!r) return;
        const baseline = stats.agent_version_baseline;
        const rollback = baseline && verCmp(r.version, baseline) < 0;
        $('deployTitle').textContent = (deployRollback ? 'Откат на стабильную версию ' : rollback ? 'Откат на версию ' : 'Раскатать версию ') + r.version;

        // Подсказка по ситуации: что рекомендуем именно сейчас.
        const banner = $('deployBanner');
        banner.className = 'note';
        let text;
        if (deployRollback) {
            banner.classList.add('danger');
            text = 'Откат: все кассы, где стоит другая версия, получат проверенную ' + r.version + '. Кассы, на которых она уже стоит, ничего не скачают. ' +
                'Служба перезапустится сразу после скачивания, окно оповещений — при следующем входе кассира. Новую проблемную версию отзовите в меню ⋯, чтобы её не раскатили снова.';
        } else if (rollback) {
            banner.classList.add('danger');
            text = 'Это откат: кассы получат более старую версию ' + r.version + ' (сейчас актуальная — ' + baseline + '). Служба управления перезапустится сразу после скачивания, окно оповещений — при следующем входе кассира.' +
                (r.status !== 'stable' ? ' Внимание: версия не помечена стабильной — для отката обычно выбирают стабильную.' : ' Отметьте «Сделать актуальной», если откатываете все кассы.');
        } else if (r.status === 'testing') {
            banner.classList.add('warn');
            text = targetState.type === 'all'
                ? '⚠ Тестовая версия уходит на все кассы. Рекомендуем сначала одну кассу или пилотную группу/магазин, а после проверки — пометить версию стабильной.'
                : 'Тестовая версия: удачный выбор — пилот. После раскатки проверьте на «Хостах», что касса отчиталась версией ' + r.version + ' и команды/оповещения работают, затем пометьте версию стабильной.';
        } else {
            text = 'Стабильная версия — можно на все кассы. Если касс много или каналы в магазинах узкие, раскатывайте частями: по магазинам или группам.';
        }
        banner.textContent = text;

        const dir = $('installDir').value.trim().replace(/\//g, '\\');
        const dirOk = /^([A-Za-z]:\\|\\\\[^\\]+\\[^\\]+)/.test(dir) && !/[<>"|?*]/.test(dir);
        const base = dir.length > 3 ? dir.replace(/\\+$/, '') : dir;
        $('deployPaths').innerHTML = r.files.map(function (f) {
            return '<div class="row-path' + (dirOk ? '' : ' bad') + '">' + Ui.icon(dirOk ? 'file' : 'x') + '<span>' +
                esc((base.slice(-1) === '\\' ? base : base + '\\') + f.original_name) + (dirOk ? '' : ' — папка агента должна быть полным путём') + '</span></div>';
        }).join('');

        const total = targetState.total;
        $('deploySubmitBtn').innerHTML = Ui.icon('send') + (rollback || deployRollback ? 'Откатить на ' : 'Раскатать ') + r.version +
            (total ? ' на ' + total + ' ' + Ui.plural(total, 'кассу', 'кассы', 'касс') : '');
        $('deploySubmitBtn').className = rollback || deployRollback ? 'danger' : 'primary';
    }
    $('installDir').addEventListener('input', renderDeploy);

    $('rollbackBtn').addEventListener('click', function () {
        const stable = latestStable();
        if (stable) openDeploy(stable, { rollback: true });
    });
    $('deployCloseBtn').addEventListener('click', function () { $('deployCard').hidden = true; });
    $('deployCancelBtn').addEventListener('click', function () { $('deployCard').hidden = true; });

    $('deployCard').addEventListener('submit', async function (e) {
        e.preventDefault();
        const r = deploying;
        const t = target.value();
        const total = targetState.total;
        if (t.type !== 'all' && !t.id) { $('deployError').textContent = 'Выберите, кому именно.'; return; }
        if (!total) { $('deployError').textContent = 'Под выбранную цель сейчас не подходит ни одна касса.'; return; }
        $('deployError').textContent = '';
        const rollback = deployRollback || (stats.agent_version_baseline && verCmp(r.version, stats.agent_version_baseline) < 0);
        if (!await Ui.confirm((rollback ? 'Откатить на ' : 'Раскатать версию ') + r.version + ' (' + STATUS[r.status].label + ') на ' + total + ' ' +
            Ui.plural(total, 'кассу', 'кассы', 'касс') + ' (' + target.describe() + ')? Служба управления на них перезапустится. Отменить после отправки нельзя.',
            { okLabel: rollback ? 'Откатить' : 'Раскатать', danger: total > 1 || rollback, title: rollback ? 'Откат агента' : 'Обновление агента' })) return;

        $('deploySubmitBtn').disabled = true;
        try {
            const res = await Api.post('/admin/agent-releases/' + r.id + '/deploy', {
                target: t, install_dir: $('installDir').value.trim(), make_current: $('makeCurrent').checked,
            });
            Ui.toast((rollback ? 'Откат на ' : 'Раскатка ') + r.version + ' отправлен' + (rollback ? '' : 'а') + ' на ' + total + ' ' + Ui.plural(total, 'кассу', 'кассы', 'касс'), 'success');
            $('deployCard').hidden = true;
            watchSent(res.ids, r.version);
            await load();
        } catch (err) {
            $('deployError').textContent = 'Не удалось отправить: ' + Ui.reason(err, ERRORS);
        } finally {
            $('deploySubmitBtn').disabled = false;
        }
    });

    // ---- Ход раскатки после отправки -----------------------------------------------------

    let sentIds = [], sentUntil = 0, sentTimer = null;

    function watchSent(ids, version) {
        sentIds = ids.map(String);
        sentUntil = Date.now() + 15 * 60 * 1000;
        $('sentTitle').textContent = 'Версия ' + version + ': ход раскатки';
        $('sentCard').hidden = false;
        $('sentWatchLink').href = '/admin/commands?watch=' + sentIds.join(',');
        clearInterval(sentTimer);
        const tick = async function () {
            if (document.hidden) return;
            try { commands = await Api.get('/admin/commands'); } catch (e) { return; }
            renderSent();
        };
        tick();
        sentTimer = setInterval(tick, 3000);
    }

    function renderSent() {
        const mine = commands.filter(function (c) { return sentIds.indexOf(String(c.id)) >= 0; });
        $('sentList').innerHTML = mine.map(function (c) {
            const p = JSON.parse(c.payload);
            const total = +c.target_count;
            return '<div class="sent-item"><code class="path">' + esc(p.target_path) + '</code><span style="font-size:12.5px"><b>' + c.success_count + '</b> из ' + total + ' готово' +
                (+c.failed_count ? ' · <span style="color:var(--danger)">' + c.failed_count + ' с ошибкой</span>' : '') +
                (+c.in_progress_count ? ' · ' + c.in_progress_count + ' качают' : '') + (+c.pending_count ? ' · ' + c.pending_count + ' ждут' : '') + '</span>' +
                Ui.progressBar([
                    { n: +c.success_count, kind: 'ok', label: 'готово' }, { n: +c.failed_count, kind: 'bad', label: 'ошибка' },
                    { n: +c.in_progress_count, kind: 'run', label: 'качают' }, { n: +c.pending_count, kind: 'wait', label: 'ждут' },
                ], total) + '</div>';
        }).join('') || '<span class="muted">Загрузка…</span>';
        const active = mine.some(function (c) { return +c.in_progress_count > 0 || (+c.pending_online_count > 0 && !+c.expired); });
        const waiting = mine.length ? Math.max.apply(null, mine.map(function (c) { return +c.pending_count - +c.pending_online_count; })) : 0;
        if (mine.length && (!active || Date.now() > sentUntil)) {
            clearInterval(sentTimer);
            $('sentNote').textContent = (waiting > 0 ? 'Кассы на связи отработали; выключенные (' + waiting + ') получат обновление, когда включатся. ' : 'Все кассы получили файлы. ') +
                'Через минуту-другую после перезапуска службы касса сообщит новую версию — смотрите «На актуальной» выше.';
            setTimeout(load, 20000);
        } else {
            $('sentNote').textContent = 'Обновляется само каждые 3 секунды…';
        }
    }
    $('sentCloseBtn').addEventListener('click', function () { $('sentCard').hidden = true; clearInterval(sentTimer); });

    // ---- Старт ------------------------------------------------------------------------------

    await load();
    await checkImport();
    setInterval(function () { if (!document.hidden && $('deployCard').hidden && $('newCard').hidden) load(); }, 30000);
})();
