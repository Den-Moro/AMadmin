// Страница «Файлы»: библиотека загруженных файлов, мастер раскатки «Что → Куда → Кому»
// и справочник «Папки назначения». Сама раскатка — обычные команды file_deploy (одна на
// файл, несколько файлов — одной пачкой через /admin/commands/batch): агенту на кассе
// всё равно, с какой страницы панели их отправили.
(async function () {
    const me = await requireAdminAuth();
    const canEdit = me.role === 'administrator' || me.role === 'superadmin';
    const $ = Ui.$, esc = Ui.escapeHtml;

    $('deployBtn').innerHTML = Ui.icon('send') + 'Раскатать файлы';
    $('deployCloseBtn').innerHTML = Ui.icon('x');
    $('sentCloseBtn').innerHTML = Ui.icon('x');
    $('dropIcon').outerHTML = Ui.icon('upload');
    $('searchIcon').outerHTML = Ui.icon('search');
    $('addDestBtn').innerHTML = Ui.icon('plus') + 'Добавить папку';

    if (canEdit) {
        $('adminActions').hidden = false;
        document.querySelectorAll('[data-admin]').forEach(function (el) { el.hidden = false; });
        Ui.settingsFieldsPanel({
            file_deploy_async: 'bool', file_deploy_max_parallel: 'text', file_deploy_limit_kbps: 'text',
        }, 'fileDeploySaveBtn');
    }

    const ERRORS = {
        file_id_required: 'выберите хотя бы один файл', file_not_found: 'файл не найден — возможно, его удалили',
        target_path_must_be_absolute_windows_path: 'путь на кассе должен быть полным, например C:\\Папка\\файл.txt',
        target_path_is_folder: 'в пути нет имени файла', target_path_invalid_chars: 'в пути есть недопустимые символы',
        invalid_target_type: 'неверный тип цели', target_id_required: 'выберите, кому именно',
        insufficient_role: 'нужна роль администратора', items_required: 'выберите хотя бы один файл',
        folder_must_be_absolute_windows_path: 'папка должна быть полным путём, например C:\\ProfiT',
    };

    // ---- Вкладки --------------------------------------------------------------------------

    function showTab(name) {
        document.querySelectorAll('.tabs button').forEach(function (x) { x.classList.toggle('active', x.dataset.tab === name); });
        document.querySelectorAll('.tab-panel').forEach(function (p) { p.hidden = p.dataset.panel !== name; });
    }
    document.querySelectorAll('.tabs button').forEach(function (b) {
        b.addEventListener('click', function () { showTab(b.dataset.tab); });
    });

    // ---- Пути Windows ---------------------------------------------------------------------

    // Те же правила, что проверяет сервер (AdminCommandsController::validateFileDeploy),
    // — только здесь ошибку видно сразу, пока набираешь путь, а не после «Отправить».
    function folderProblem(folder) {
        if (!folder) return 'укажите папку';
        if (!/^([A-Za-z]:\\|\\\\[^\\]+\\[^\\]+)/.test(folder)) return 'нужен полный путь: с буквы диска (C:\\…) или сетевой (\\\\сервер\\папка)';
        if (/[<>"|?*]/.test(folder) || folder.slice(2).indexOf(':') >= 0) return 'недопустимые символы в пути: < > " | ? * :';
        return '';
    }
    function nameProblem(name) {
        if (!name) return 'укажите имя файла';
        if (/[\\/:*?"<>|]/.test(name)) return 'в имени файла нельзя \\ / : * ? " < > |';
        if (/[. ]$/.test(name)) return 'имя не может кончаться точкой или пробелом';
        return '';
    }
    function normFolder(folder) {
        folder = folder.trim().replace(/\//g, '\\');
        return folder.length > 3 ? folder.replace(/\\+$/, '') : folder;
    }
    function joinPath(folder, name) {
        return folder.slice(-1) === '\\' ? folder + name : folder + '\\' + name;
    }

    // ---- Данные ---------------------------------------------------------------------------

    let files = [], dests = [], recent = [], commands = [];
    const filesById = function (id) { return files.find(function (f) { return String(f.id) === String(id); }); };

    async function loadFiles() {
        files = await Api.get('/admin/files');
        $('filesCount').textContent = files.length;
        renderFiles();
        if (!$('deployCard').hidden) renderWizard();
    }

    async function loadDests() {
        dests = await Api.get('/admin/deploy-destinations');
        $('destsCount').textContent = dests.length;
        renderDests();
        if (!$('deployCard').hidden) renderWizard();
    }

    async function loadRecent() {
        try { recent = await Api.get('/admin/files/recent-folders'); } catch (e) { recent = []; }
    }

    // ---- Таблица файлов -------------------------------------------------------------------

    const checked = new Set();
    const sort = Ui.makeSortable(document.querySelector('#filesTable'), { key: 'created_at', dir: 'desc' }, renderFiles);

    function renderFiles() {
        const q = $('search').value.trim().toLowerCase();
        const tbody = document.querySelector('#filesTable tbody');
        const open = new Set([...tbody.querySelectorAll('tr.open')].map(function (tr) { return tr.dataset.id; }));
        const rows = files.filter(function (f) { return !q || f.original_name.toLowerCase().indexOf(q) >= 0; })
            .sort(function (a, b) { return Ui.compareBy(a, b, sort, sort.key === 'size' || sort.key === 'deploy_count' ? { map: function (r) { return +r[sort.key]; } } : null); });

        if (!files.length) {
            tbody.innerHTML = '<tr><td colspan="6">' + Ui.emptyState({
                icon: 'folder', title: 'Файлов пока нет',
                text: canEdit ? 'Перетащите файл в область выше — например, новый конфиг кассовой программы. Потом нажмите «Раскатать» и выберите папку и кассы.'
                    : 'Загружать файлы может администратор.',
            }) + '</td></tr>';
            updateSelection();
            return;
        }
        if (!rows.length) {
            tbody.innerHTML = '<tr><td colspan="6" class="empty">Ничего не найдено по «' + esc(q) + '»</td></tr>';
            updateSelection();
            return;
        }

        tbody.innerHTML = rows.map(function (f) {
            const count = +f.deploy_count;
            return '<tr class="clickable" data-id="' + f.id + '">' +
                '<td class="check"><input type="checkbox" data-check' + (checked.has(String(f.id)) ? ' checked' : '') + ' aria-label="Отметить ' + esc(f.original_name) + '"></td>' +
                '<td><div class="file-name">' + Ui.icon(f.release_version ? 'package' : 'file') + '<div><b>' + esc(f.original_name) + '</b>' +
                    (f.release_version ? ' <a href="/admin/updates" class="badge badge-info plain" style="text-decoration:none" title="Файл входит в версию агента ' + esc(f.release_version) + ' — раскатывается и удаляется на странице «Обновления»">агент ' + esc(f.release_version) + '</a>' : '') +
                    '<span class="sub">SHA-256 <code title="' + esc(f.sha256) + '\nНажмите, чтобы скопировать" data-copy="' + esc(f.sha256) + '">' + esc(f.sha256.slice(0, 12)) + '…</code></span></div></div></td>' +
                '<td class="num nowrap">' + Ui.formatSize(+f.size) + '</td>' +
                '<td class="nowrap">' + esc(formatServerTime(f.created_at)) + '<span class="muted" style="display:block;font-size:12px">' + esc(f.uploaded_by_username || '—') + '</span></td>' +
                '<td class="deploy-info">' + (count
                    ? '<b>' + count + '</b> ' + Ui.plural(count, 'раз', 'раза', 'раз') + ' · последний ' + esc(formatServerTime(f.last_deployed_at)) +
                      '<br><code class="path" title="Куда раскатывали в последний раз">' + esc(f.last_target_path || '') + '</code>'
                    : '<span class="muted">ещё не раскатывали</span>') + '</td>' +
                '<td><div class="actions">' +
                    (canEdit ? '<button type="button" class="small" data-act="deploy" title="Разложить этот файл по кассам">' + Ui.icon('send') + 'Раскатать</button>' : '') +
                    '<button type="button" class="small ghost icon-only" data-act="more" title="Ещё: история, копировать хеш, удалить">⋯</button>' +
                '</div></td></tr>';
        }).join('');

        open.forEach(function (id) {
            const tr = tbody.querySelector('tr[data-id="' + id + '"]');
            if (tr) Ui.toggleDetail(tr, historyHtml(filesById(id)), 6);
        });
        updateSelection();
    }

    function updateSelection() {
        // Отметки у удалённых файлов не должны «висеть» невидимыми.
        [...checked].forEach(function (id) { if (!filesById(id)) checked.delete(id); });
        $('selectedInfo').textContent = checked.size ? 'Отмечено: ' + checked.size : '';
        $('deploySelectedBtn').hidden = !checked.size || !canEdit;
        $('checkAll').checked = files.length > 0 && checked.size === files.length;
    }

    // История раскаток файла — из списка последних команд (те же данные, что на «Командах»).
    function historyHtml(f) {
        const mine = commands.filter(function (c) {
            if (c.type !== 'file_deploy') return false;
            try { return String(JSON.parse(c.payload).file_id) === String(f.id); } catch (e) { return false; }
        });
        if (!mine.length) {
            return '<p class="muted" style="margin:0">Этот файл ещё не раскатывали' +
                (+f.deploy_count ? ' среди последних 100 команд' : '') + '.</p>';
        }
        return '<table><thead><tr><th>Когда</th><th>Куда</th><th>Кому</th><th>Ход</th><th>Автор</th></tr></thead><tbody>' +
            mine.map(function (c) {
                const p = JSON.parse(c.payload);
                return '<tr><td class="nowrap muted">' + esc(formatServerTime(c.created_at)) + '</td>' +
                    '<td><code class="path">' + esc(p.target_path) + '</code></td>' +
                    '<td>' + esc(describeTarget(c)) + '</td>' +
                    '<td style="min-width:180px">' + progressText(c) + Ui.progressBar(progressParts(c), +c.target_count) + '</td>' +
                    '<td>' + esc(c.created_by_username || '—') + '</td></tr>';
            }).join('') + '</tbody></table>' +
            '<p class="muted" style="margin:8px 0 0">Результат с каждой кассы — на странице <a href="/admin/commands?watch=' +
            mine.slice(0, 5).map(function (c) { return c.id; }).join(',') + '">«Команды»</a>.</p>';
    }

    const targetNames = { all: 'Всем кассам', store: 'Магазин', group: 'Группа', device_type: 'Тип', pc: 'ПК' };
    function describeTarget(c) {
        if (c.target_type === 'all') return targetNames.all;
        return (targetNames[c.target_type] || c.target_type) + ' «' + (c.target_name || '#' + c.target_id) + '»';
    }

    function progressParts(c) {
        return [
            { n: +c.success_count, kind: 'ok', label: 'готово' },
            { n: +c.failed_count, kind: 'bad', label: 'ошибка' },
            { n: +c.in_progress_count, kind: 'run', label: 'качают' },
            { n: +c.pending_count, kind: 'wait', label: 'ждут' },
        ];
    }

    function progressText(c) {
        const total = +c.target_count;
        if (!total) return '<span class="muted">нет касс под цель</span>';
        const bits = ['<b>' + c.success_count + '</b> из ' + total + ' готово'];
        if (+c.failed_count) bits.push('<span style="color:var(--danger)">' + c.failed_count + ' с ошибкой</span>');
        if (+c.in_progress_count) bits.push(c.in_progress_count + ' качают');
        if (+c.pending_count) bits.push(+c.expired ? c.pending_count + ' не получат (срок истёк)' : c.pending_count + ' ждут');
        return '<span style="font-size:12.5px">' + bits.join(' · ') + '</span>';
    }

    async function loadCommands() {
        try { commands = await Api.get('/admin/commands'); } catch (e) { commands = []; }
    }

    document.querySelector('#filesTable').addEventListener('click', async function (e) {
        const copy = e.target.closest('[data-copy]');
        if (copy) {
            e.stopPropagation();
            try { await navigator.clipboard.writeText(copy.dataset.copy); Ui.toast('SHA-256 скопирован', 'success'); }
            catch (err) { Ui.toast('Не удалось скопировать — выделите хеш вручную', 'error'); }
            return;
        }
        if (e.target.closest('input[data-check]')) {
            const tr = e.target.closest('tr[data-id]');
            if (e.target.checked) checked.add(tr.dataset.id); else checked.delete(tr.dataset.id);
            updateSelection();
            return;
        }
        if (e.target.closest('td.check')) return;
        const tr = e.target.closest('tr[data-id]');
        if (!tr) return;
        const f = filesById(tr.dataset.id);
        const btn = e.target.closest('button[data-act]');
        if (btn && btn.dataset.act === 'deploy') { openWizard([f.id]); return; }
        if (btn && btn.dataset.act === 'more') {
            const act = await Ui.menu(btn, [
                { label: 'История раскаток', value: 'history' },
                { label: 'Скопировать SHA-256', value: 'copy' },
            ].concat(canEdit ? [{ label: 'Удалить с сервера', value: 'delete', danger: true }] : []));
            if (act === 'history') { if (!tr.classList.contains('open')) Ui.toggleDetail(tr, historyHtml(f), 6); }
            if (act === 'copy') {
                try { await navigator.clipboard.writeText(f.sha256); Ui.toast('SHA-256 скопирован', 'success'); }
                catch (err) { Ui.toast('Не удалось скопировать', 'error'); }
            }
            if (act === 'delete') deleteFile(f);
            return;
        }
        Ui.toggleDetail(tr, historyHtml(f), 6);
    });

    $('checkAll').addEventListener('change', function () {
        checked.clear();
        if ($('checkAll').checked) files.forEach(function (f) { checked.add(String(f.id)); });
        renderFiles();
    });
    $('search').addEventListener('input', renderFiles);
    $('deploySelectedBtn').addEventListener('click', function () { openWizard([...checked]); });

    async function deleteFile(f) {
        const busy = commands.some(function (c) {
            try { return c.type === 'file_deploy' && String(JSON.parse(c.payload).file_id) === String(f.id) && +c.pending_count > 0 && !+c.expired; }
            catch (e) { return false; }
        });
        const text = 'Удалить «' + f.original_name + '» с сервера?' +
            (busy ? ' Внимание: часть касс ещё не скачала его — у них раскатка завершится ошибкой.' : ' На кассах уже разложенные копии останутся.');
        if (!await Ui.confirm(text, { danger: true, okLabel: 'Удалить' })) return;
        try {
            await Api.request('DELETE', '/admin/files/' + f.id);
            Ui.toast('Файл удалён', 'success');
            checked.delete(String(f.id));
            removePicked(String(f.id));
            await loadFiles();
        } catch (err) {
            Ui.toast('Не удалось удалить: ' + (err.data && err.data.error === 'file_in_release'
                ? 'файл входит в версию агента ' + err.data.version + ' — удалите версию на странице «Обновления»'
                : Ui.reason(err)), 'error');
        }
    }

    // ---- Загрузка (перетаскивание или выбор, сразу несколько) ----------------------------

    const dz = $('dropzone');
    ['dragenter', 'dragover'].forEach(function (ev) {
        dz.addEventListener(ev, function (e) { e.preventDefault(); dz.classList.add('over'); });
    });
    ['dragleave', 'drop'].forEach(function (ev) {
        dz.addEventListener(ev, function (e) { e.preventDefault(); dz.classList.remove('over'); });
    });
    dz.addEventListener('drop', function (e) { if (e.dataTransfer.files.length) uploadAll(Array.from(e.dataTransfer.files)); });
    $('uploadInput').addEventListener('change', function () {
        if (this.files.length) uploadAll(Array.from(this.files));
        this.value = '';
    });

    // Список файлов копируется в массив сразу: FileList поля выбора живой — очистка поля
    // (value = '') посреди загрузки обнуляла его, и из нескольких файлов уходил только первый.
    // По одному файлу за запрос (так устроен POST /admin/files), через XHR — ради полоски
    // хода загрузки: у fetch прогресса отправки нет.
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
        const list = $('uploadList');
        const uploaded = [];
        for (const file of fileList) {
            const item = document.createElement('div');
            item.className = 'upload-item';
            item.innerHTML = '<span>' + esc(file.name) + '</span><span class="muted">' + Ui.formatSize(file.size) + '</span><div class="track"><div class="fill"></div></div>';
            list.appendChild(item);
            try {
                const res = await uploadOne(file, item);
                item.querySelector('.muted').textContent = res.duplicate ? 'уже был — взят готовый' : 'загружен';
                uploaded.push(String(res.id));
            } catch (err) {
                item.classList.add('bad');
                item.querySelector('.muted').textContent = 'ошибка: ' + err.message;
            }
        }
        await loadFiles();
        setTimeout(function () { list.querySelectorAll('.upload-item:not(.bad)').forEach(function (el) { el.remove(); }); }, 4000);
        if (!uploaded.length) return;
        // Мастер открыт — новые файлы сразу попадают в раскатку; иначе предлагаем открыть его.
        if (!$('deployCard').hidden) {
            uploaded.forEach(addPicked);
            Ui.toast('Загружено и добавлено в раскатку: ' + uploaded.length, 'success');
        } else if (canEdit) {
            uploaded.forEach(function (id) { checked.add(id); });
            renderFiles();
            Ui.toast('Загружено: ' + uploaded.length + '. Файлы отмечены — нажмите «Раскатать отмеченные».', 'success');
        }
    }

    // ---- Мастер раскатки ------------------------------------------------------------------

    let picked = [];           // id файлов (строки) в порядке добавления
    const names = {};          // id файла -> имя на кассе (по умолчанию — исходное)
    let target = null;         // Ui.targetPicker
    let targetState = { type: 'all', id: null, total: 0, online: 0 };

    function addPicked(id) {
        id = String(id);
        if (!filesById(id) || picked.indexOf(id) >= 0) return;
        picked.push(id);
        if (!names[id]) names[id] = filesById(id).original_name;
        renderWizard();
    }
    function removePicked(id) {
        picked = picked.filter(function (x) { return x !== id; });
        if (!$('deployCard').hidden) renderWizard();
    }

    async function openWizard(ids, preset) {
        preset = preset || {};
        picked = [];
        (ids || []).forEach(function (id) { addPicked(id); });
        $('sentCard').hidden = true;
        $('deployCard').hidden = false;
        $('deployError').textContent = '';
        if (preset.folder !== undefined) $('folderInput').value = preset.folder;
        else if (!$('folderInput').value && picked.length === 1) {
            // Повторная раскатка того же файла — по умолчанию туда же, куда в прошлый раз.
            const last = filesById(picked[0]).last_target_path;
            if (last && last.lastIndexOf('\\') > 1) $('folderInput').value = last.slice(0, last.lastIndexOf('\\'));
        }
        if (preset.names) Object.keys(preset.names).forEach(function (id) { names[id] = preset.names[id]; });
        if (!target) {
            target = Ui.targetPicker($('targetBox'), { label: 'Цель', onChange: function (s) { targetState = s; renderSummary(); } });
        }
        if (preset.targetType) await target.set(preset.targetType, preset.targetId);
        renderWizard();
        $('deployCard').scrollIntoView({ behavior: 'smooth', block: 'start' });
    }

    function closeWizard() { $('deployCard').hidden = true; }

    function renderWizard() {
        // Шаг 1 — выбранные файлы и «добавить ещё».
        $('pickedFiles').innerHTML = picked.length ? picked.map(function (id) {
            const f = filesById(id);
            return '<span class="chip">' + Ui.icon('file') + esc(f.original_name) + ' <span class="muted">' + Ui.formatSize(+f.size) + '</span>' +
                '<button type="button" data-unpick="' + id + '" aria-label="Убрать ' + esc(f.original_name) + '" title="Убрать из раскатки">×</button></span>';
        }).join('') : '<span class="muted">Пока ничего не выбрано — добавьте файл из списка ниже.</span>';
        const rest = files.filter(function (f) { return picked.indexOf(String(f.id)) < 0; });
        $('addFileSelect').innerHTML = '<option value="">' + (rest.length ? '— выбрать загруженный файл —' : '— все загруженные файлы уже выбраны —') + '</option>' +
            rest.map(function (f) { return '<option value="' + f.id + '">' + esc(f.original_name) + ' (' + Ui.formatSize(+f.size) + ')</option>'; }).join('');

        // Шаг 2 — плитки папок + недавние.
        const folder = normFolder($('folderInput').value);
        const match = dests.find(function (d) { return d.path.toLowerCase() === folder.toLowerCase(); });
        $('destChoices').innerHTML = dests.map(function (d) {
            return '<button type="button" class="choice' + (match && match.id === d.id ? ' selected' : '') + '" data-dest="' + d.id + '"' +
                (d.description ? ' title="' + esc(d.description) + '"' : '') + '>' +
                '<span class="choice-title">' + Ui.icon('folder') + esc(d.name) + '</span>' +
                '<span class="choice-sub">' + esc(d.path) + '</span></button>';
        }).join('') +
            '<button type="button" class="choice' + (!match && folder ? ' selected' : '') + '" data-dest="custom" title="Впишите полный путь к папке в поле ниже">' +
            '<span class="choice-title">' + Ui.icon('plus') + 'Своя папка</span><span class="choice-sub">' + (!match && folder ? esc(folder) : 'ввести путь вручную') + '</span></button>';
        const recentOther = recent.filter(function (r) { return !dests.some(function (d) { return d.path.toLowerCase() === r.toLowerCase(); }); });
        $('recentWrap').hidden = !recentOther.length;
        $('recentFolders').innerHTML = recentOther.map(function (r) {
            return '<span class="chip link" data-recent="' + esc(r) + '" tabindex="0" role="button" title="Подставить эту папку">' + esc(r) + '</span>';
        }).join('');
        $('saveDestBtn').hidden = !canEdit || !folder || !!match || !!folderProblem(folder);

        renderNames();
        renderPreview();
        renderSummary();
    }

    // Имя файла на кассе: по умолчанию — как загружен; можно переименовать (например,
    // загрузили config-moscow.ini, а на кассе он должен называться config.ini).
    function renderNames() {
        const box = $('namesBox');
        if (!picked.length) { box.innerHTML = ''; return; }
        if (picked.length === 1) {
            const id = picked[0];
            box.innerHTML = '<label>Имя файла на кассе<span class="hint">По умолчанию — как файл был загружен. Измените, если на кассе он должен называться иначе: например, загружен config-moscow.ini, а на кассе нужен config.ini.</span>' +
                '<input type="text" class="mono" data-name="' + id + '" value="' + esc(names[id]) + '" spellcheck="false"></label>';
        } else {
            box.innerHTML = '<label style="margin-bottom:-4px">Имена файлов на кассе<span class="hint">По умолчанию — как файлы были загружены. Переименуйте, если на кассе они должны называться иначе.</span></label>' +
                '<div class="names-table">' + picked.map(function (id) {
                    return '<div class="name-row"><span class="orig" title="' + esc(filesById(id).original_name) + '">' + esc(filesById(id).original_name) + ' →</span>' +
                        '<input type="text" class="mono" data-name="' + id + '" value="' + esc(names[id]) + '" spellcheck="false" aria-label="Имя на кассе для ' + esc(filesById(id).original_name) + '"></div>';
                }).join('') + '</div>';
        }
        Ui.enhanceHints(box);
    }

    // Итоговые пути — крупно, по каждому файлу; ошибка видна сразу, до отправки.
    function renderPreview() {
        const folder = normFolder($('folderInput').value);
        const fp = folderProblem(folder);
        $('folderInput').setAttribute('aria-invalid', folder && fp ? 'true' : 'false');
        if (!picked.length) { $('pathPreview').innerHTML = ''; return; }
        if (!folder) {
            $('pathPreview').innerHTML = '<span class="muted">Выберите папку — здесь появится итоговый путь на кассе.</span>';
            return;
        }
        $('pathPreview').innerHTML = '<span class="muted">Файл окажется на кассе здесь:</span>' + picked.map(function (id) {
            const np = nameProblem((names[id] || '').trim());
            const problem = fp || np;
            return '<div class="row-path' + (problem ? ' bad' : '') + '">' + Ui.icon(problem ? 'x' : 'file') +
                '<span>' + esc(joinPath(folder, (names[id] || '').trim())) + (problem ? ' — ' + esc(problem) : '') + '</span></div>';
        }).join('');
    }

    function wizardProblems() {
        const problems = [];
        if (!picked.length) problems.push('выберите хотя бы один файл');
        const folder = normFolder($('folderInput').value);
        const fp = folderProblem(folder);
        if (fp) problems.push('папка: ' + fp);
        picked.forEach(function (id) {
            const np = nameProblem((names[id] || '').trim());
            if (np) problems.push(filesById(id).original_name + ': ' + np);
        });
        const lower = picked.map(function (id) { return (names[id] || '').trim().toLowerCase(); });
        if (lower.some(function (n, i) { return n && lower.indexOf(n) !== i; })) problems.push('два файла с одинаковым именем в одной папке');
        if (targetState.type !== 'all' && !targetState.id) problems.push('выберите, кому именно');
        else if (!targetState.total) problems.push('под выбранную цель не подходит ни одна касса');
        return problems;
    }

    function renderSummary() {
        const folder = normFolder($('folderInput').value);
        const total = targetState.total;
        const steps = {
            files: picked.length > 0,
            where: picked.length > 0 && !folderProblem(folder) && picked.every(function (id) { return !nameProblem((names[id] || '').trim()); }),
            who: (targetState.type === 'all' || !!targetState.id) && total > 0,
        };
        document.querySelectorAll('#deployCard .step').forEach(function (s) {
            const k = s.dataset.step;
            s.classList.toggle('done', k === 'send' ? steps.files && steps.where && steps.who : !!steps[k]);
        });
        $('summary').innerHTML =
            '<dt>Файлы</dt><dd>' + (picked.length ? picked.map(function (id) { return esc((names[id] || '').trim() || '?'); }).join(', ') : '—') + '</dd>' +
            '<dt>Папка</dt><dd><code class="path">' + esc(folder || '—') + '</code></dd>' +
            '<dt>Кому</dt><dd>' + esc(target ? target.describe() : '—') + (total ? ' — ' + total + ' ' + Ui.plural(total, 'касса', 'кассы', 'касс') + ', на связи ' + targetState.online : '') + '</dd>' +
            '<dt>Как</dt><dd class="muted">Касса сравнит хеш и скачает только если файл отличается; прежний сохранит рядом как .bak с датой. Папки нет — создаст.</dd>';
        $('deploySubmitBtn').innerHTML = Ui.icon('send') + (total ? 'Раскатать на ' + total + ' ' + Ui.plural(total, 'кассу', 'кассы', 'касс') : 'Раскатать');
    }

    $('pickedFiles').addEventListener('click', function (e) {
        const b = e.target.closest('[data-unpick]');
        if (b) removePicked(b.dataset.unpick);
    });
    $('addFileSelect').addEventListener('change', function () {
        if (this.value) addPicked(this.value);
    });
    $('destChoices').addEventListener('click', function (e) {
        const b = e.target.closest('[data-dest]');
        if (!b) return;
        if (b.dataset.dest === 'custom') {
            const d = dests.find(function (x) { return x.path.toLowerCase() === normFolder($('folderInput').value).toLowerCase(); });
            if (d) $('folderInput').value = '';
            $('folderInput').focus();
        } else {
            $('folderInput').value = dests.find(function (d) { return String(d.id) === b.dataset.dest; }).path;
        }
        renderWizard();
    });
    function pickRecent(el) { $('folderInput').value = el.dataset.recent; renderWizard(); }
    $('recentFolders').addEventListener('click', function (e) { const c = e.target.closest('[data-recent]'); if (c) pickRecent(c); });
    $('recentFolders').addEventListener('keydown', function (e) {
        const c = e.target.closest('[data-recent]');
        if (c && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); pickRecent(c); }
    });
    // Перерисовываем мастер не на каждую букву (иначе поле теряло бы фокус), а только
    // зависящие от пути части: плитки, превью, сводку.
    $('folderInput').addEventListener('input', function () {
        const folder = normFolder(this.value);
        const match = dests.find(function (d) { return d.path.toLowerCase() === folder.toLowerCase(); });
        document.querySelectorAll('#destChoices .choice').forEach(function (b) {
            b.classList.toggle('selected', b.dataset.dest === 'custom' ? !match && !!folder : !!match && String(match.id) === b.dataset.dest);
        });
        const custom = document.querySelector('#destChoices [data-dest="custom"] .choice-sub');
        if (custom) custom.textContent = !match && folder ? folder : 'ввести путь вручную';
        $('saveDestBtn').hidden = !canEdit || !folder || !!match || !!folderProblem(folder);
        renderPreview();
        renderSummary();
    });
    $('namesBox').addEventListener('input', function (e) {
        const input = e.target.closest('[data-name]');
        if (!input) return;
        names[input.dataset.name] = input.value;
        renderPreview();
        renderSummary();
    });

    $('saveDestBtn').addEventListener('click', async function () {
        const folder = normFolder($('folderInput').value);
        const tail = folder.split('\\').filter(Boolean).pop() || folder;
        const name = await Ui.prompt('Название папки', { title: 'Добавить в справочник', value: tail, okLabel: 'Добавить',
            hint: 'Как папка будет подписана в мастере, например «Профи-Т» или «Обработки 1С». Путь: ' + folder,
            validate: function (v) { return v.trim() ? '' : 'укажите название'; } });
        if (name === null) return;
        try {
            await Api.post('/admin/deploy-destinations', { name: name.trim(), path: folder });
            Ui.toast('Папка «' + name.trim() + '» добавлена в справочник', 'success');
            await loadDests();
        } catch (err) { Ui.toast('Не удалось: ' + Ui.reason(err, ERRORS), 'error'); }
    });

    $('deployBtn').addEventListener('click', function () { openWizard(checked.size ? [...checked] : []); });
    $('deployCloseBtn').addEventListener('click', closeWizard);
    $('deployCancelBtn').addEventListener('click', closeWizard);

    $('deployCard').addEventListener('submit', async function (e) {
        e.preventDefault();
        const problems = wizardProblems();
        if (problems.length) {
            $('deployError').textContent = 'Проверьте: ' + problems.join('; ') + '.';
            return;
        }
        $('deployError').textContent = '';
        const folder = normFolder($('folderInput').value);
        const total = targetState.total;
        const items = picked.map(function (id) {
            return { type: 'file_deploy', payload: { file_id: id, target_path: joinPath(folder, names[id].trim()) } };
        });
        const what = items.length === 1 ? '«' + names[picked[0]].trim() + '»' : items.length + ' ' + Ui.plural(items.length, 'файл', 'файла', 'файлов');
        if (!await Ui.confirm('Разложить ' + what + ' в ' + folder + ' на ' + total + ' ' + Ui.plural(total, 'кассу', 'кассы', 'касс') +
            ' (' + target.describe() + ')? Отменить после отправки нельзя.', { okLabel: 'Раскатать', danger: total > 1, title: 'Раскатка файлов' })) return;

        const btn = $('deploySubmitBtn');
        btn.disabled = true;
        try {
            const t = target.value();
            let ids;
            if (items.length === 1) {
                const created = await Api.post('/admin/commands', { type: 'file_deploy', payload: items[0].payload, target: t });
                ids = [created.id];
            } else {
                const created = await Api.post('/admin/commands/batch', { target: t, items: items });
                ids = created.ids;
            }
            Ui.toast('Раскатка отправлена: ' + what + ' на ' + total + ' ' + Ui.plural(total, 'кассу', 'кассы', 'касс'), 'success');
            closeWizard();
            watchSent(ids);
            await Promise.all([loadCommands(), loadRecent()]);
            renderSent();
            await loadFiles();
        } catch (err) {
            const idx = err.data && err.data.index !== undefined ? ' (файл ' + names[picked[err.data.index]] + ')' : '';
            $('deployError').textContent = 'Не удалось отправить' + idx + ': ' + Ui.reason(err, ERRORS);
        } finally {
            btn.disabled = false;
        }
    });

    // ---- Ход раскатки после отправки -----------------------------------------------------

    let sentIds = [], sentUntil = 0, sentTimer = null;

    function watchSent(ids) {
        sentIds = ids.map(String);
        sentUntil = Date.now() + 10 * 60 * 1000;
        $('sentCard').hidden = false;
        $('sentWatchLink').href = '/admin/commands?watch=' + sentIds.join(',');
        renderSent();
        clearInterval(sentTimer);
        sentTimer = setInterval(async function () {
            if (document.hidden) return;
            await loadCommands();
            renderSent();
        }, 3000);
    }

    function renderSent() {
        const mine = commands.filter(function (c) { return sentIds.indexOf(String(c.id)) >= 0; });
        $('sentList').innerHTML = mine.map(function (c) {
            const p = JSON.parse(c.payload);
            return '<div class="sent-item"><span><code class="path">' + esc(p.target_path) + '</code></span>' +
                '<span>' + progressText(c) + '</span>' + Ui.progressBar(progressParts(c), +c.target_count) + '</div>';
        }).join('') || '<span class="muted">Загрузка…</span>';
        const active = mine.some(function (c) { return +c.in_progress_count > 0 || (+c.pending_online_count > 0 && !+c.expired); });
        const waiting = mine.reduce(function (s, c) { return s + +c.pending_count - +c.pending_online_count; }, 0);
        if (mine.length && (!active || Date.now() > sentUntil)) {
            clearInterval(sentTimer);
            $('sentNote').textContent = waiting > 0
                ? 'Кассы на связи отработали. Выключенные (' + waiting + ') заберут файл, когда включатся.'
                : 'Готово — все кассы отчитались.';
        } else {
            $('sentNote').textContent = 'Обновляется само каждые 3 секунды…';
        }
    }

    $('sentCloseBtn').addEventListener('click', function () { $('sentCard').hidden = true; clearInterval(sentTimer); });

    // ---- Справочник «Папки назначения» ---------------------------------------------------

    function renderDests() {
        const tbody = document.querySelector('#destsTable tbody');
        if (!dests.length) {
            tbody.innerHTML = '<tr><td colspan="4">' + Ui.emptyState({ icon: 'folder', title: 'Папок пока нет',
                text: 'Добавьте папки, куда часто кладёте файлы: папку кассовой программы, обработок, ярлыков.' }) + '</td></tr>';
            return;
        }
        tbody.innerHTML = dests.map(function (d) {
            return '<tr data-id="' + d.id + '"><td><b>' + esc(d.name) + '</b></td>' +
                '<td><span class="dest-path">' + esc(d.path) + '</span></td>' +
                '<td class="muted">' + esc(d.description || '') + '</td>' +
                '<td><div class="actions">' + (canEdit
                    ? '<button type="button" class="small" data-edit title="Изменить название, путь или пояснение">Изменить</button>' +
                      '<button type="button" class="small" data-delete title="Убрать из справочника. Уже отправленные раскатки не затронет">Удалить</button>'
                    : '') + '</div></td></tr>';
        }).join('');
    }

    async function editDest(d) {
        const v = await Ui.modal({
            title: d ? 'Папка назначения' : 'Новая папка назначения',
            body: '<label>Название<span class="hint">Как папка подписана в мастере раскатки, например «Профи-Т».</span>' +
                '<input type="text" id="dName" value="' + esc(d ? d.name : '') + '" placeholder="Профи-Т"></label>' +
                '<label>Папка на кассе<span class="hint">Полный путь, например C:\\ProfiT. Без имени файла — оно подставится при раскатке.</span>' +
                '<input type="text" id="dPath" class="mono" value="' + esc(d ? d.path : '') + '" placeholder="C:\\ProfiT" spellcheck="false"></label>' +
                '<label>Пояснение (необязательно)<span class="hint">Показывается подсказкой при наведении на плитку в мастере.</span>' +
                '<input type="text" id="dDesc" value="' + esc(d && d.description ? d.description : '') + '" placeholder="Папка кассовой программы"></label>' +
                '<p class="error modal-error"></p>',
            buttons: [{ label: 'Отмена', value: null }, { label: d ? 'Сохранить' : 'Добавить', value: 'submit', kind: 'primary' }],
            errors: ERRORS,
            onSubmit: async function (root) {
                const body = { name: root.querySelector('#dName').value.trim(), path: normFolder(root.querySelector('#dPath').value), description: root.querySelector('#dDesc').value.trim() };
                const problem = !body.name ? 'укажите название' : folderProblem(body.path);
                if (problem) { root.querySelector('.modal-error').textContent = problem; return false; }
                if (d) await Api.request('PUT', '/admin/deploy-destinations/' + d.id, body);
                else await Api.post('/admin/deploy-destinations', body);
                return true;
            },
        });
        if (v) { Ui.toast('Сохранено', 'success'); await loadDests(); }
    }

    $('addDestBtn').addEventListener('click', function () { editDest(null); });
    document.querySelector('#destsTable').addEventListener('click', async function (e) {
        const tr = e.target.closest('tr[data-id]');
        if (!tr) return;
        const d = dests.find(function (x) { return String(x.id) === tr.dataset.id; });
        if (e.target.closest('[data-edit]')) editDest(d);
        if (e.target.closest('[data-delete]')) {
            if (!await Ui.confirm('Убрать «' + d.name + '» (' + d.path + ') из справочника? Уже отправленные раскатки это не затронет.', { danger: true, okLabel: 'Удалить' })) return;
            try { await Api.request('DELETE', '/admin/deploy-destinations/' + d.id); Ui.toast('Удалено', 'success'); await loadDests(); }
            catch (err) { Ui.toast('Не удалось: ' + Ui.reason(err), 'error'); }
        }
    });

    // ---- Старт ------------------------------------------------------------------------------

    await Promise.all([loadCommands(), loadRecent()]);
    await Promise.all([loadFiles(), loadDests()]);

    // ?file=ID — «Раскатать» из другого места; ?pc=ID — из профиля хоста;
    // ?repeat=ID — «Повторить» раскатку со страницы «Команды».
    const qs = new URLSearchParams(location.search);
    if (canEdit && qs.get('repeat')) {
        const c = commands.find(function (x) { return String(x.id) === qs.get('repeat'); });
        if (c) {
            const p = JSON.parse(c.payload);
            const cut = p.target_path.lastIndexOf('\\');
            const preset = { folder: cut > 2 ? p.target_path.slice(0, cut) : p.target_path.slice(0, cut + 1), names: {}, targetType: c.target_type, targetId: c.target_id };
            preset.names[String(p.file_id)] = p.target_path.slice(cut + 1);
            if (filesById(p.file_id)) openWizard([p.file_id], preset);
            else Ui.toast('Файл этой раскатки уже удалён с сервера — загрузите его заново', 'error');
        }
    } else if (canEdit && (qs.get('file') || qs.get('pc'))) {
        openWizard(qs.get('file') ? [qs.get('file')] : [], qs.get('pc') ? { targetType: 'pc', targetId: qs.get('pc') } : {});
    }
})();
