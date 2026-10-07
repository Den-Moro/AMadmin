// Переменные (бета, только суперадмин):
//   1. «Переменные панели» — пары ИМЯ = значение на уровнях все кассы / магазин / группа /
//      касса; подставляются в скрипты и пути файлов как {{ИМЯ}} (Core/HostVariables.php).
//   2. «Переменные среды Windows на кассах» — команда env_var агенту (агент 0.2.0+).
(async function () {
    const me = await requireAdminAuth();
    const $ = Ui.$, esc = Ui.escapeHtml;
    if (me.role !== 'superadmin') {
        document.querySelector('main').innerHTML = Ui.emptyState({ icon: 'key', title: 'Только для суперадмина',
            text: 'Переменные хоста — бета-функция, она доступна только главному администратору.' });
        return;
    }
    $('searchIcon').outerHTML = Ui.icon('search');

    const SCOPES = { global: 'Все кассы', store: 'Магазин', group: 'Группа', pc: 'Касса' };
    const ERRORS = {
        invalid_scope: 'выберите уровень', scope_not_found: 'магазин, группа или касса не найдены',
        invalid_variable_name: 'имя — латиница, цифры и _, с буквы (например PROFIT_DIR)', variable_exists: 'на этом уровне переменная с таким именем уже есть',
        value_too_long: 'значение длиннее 4000 символов', value_multiline: 'значение должно быть в одну строку',
        invalid_env_name: 'имя переменной Windows — латиница, цифры, _ ( ) . -', protected_env_var: 'эту системную переменную можно только смотреть',
        env_value_required: 'укажите значение', env_value_invalid: 'значение — одна строка до 2047 символов',
        env_path_folder_invalid: 'папка — полный путь (C:\\…) или от переменной (%ProgramFiles%\\…), одна, без «;»',
        insufficient_role: 'только для суперадмина', smart_group_requires_superadmin: 'смарт-группы — только для суперадмина',
    };

    // ---- Вкладки -------------------------------------------------------------------------
    function showTab(name) {
        document.querySelectorAll('.tabs button').forEach(function (b) { b.classList.toggle('active', b.dataset.tab === name); });
        document.querySelectorAll('.tab-panel').forEach(function (p) { p.hidden = p.dataset.panel !== name; });
        if (name === 'windows') loadEnvCommands();
    }
    document.querySelectorAll('.tabs button').forEach(function (b) { b.addEventListener('click', function () { showTab(b.dataset.tab); }); });

    // ---- Справочники для выбора уровня -----------------------------------------------------
    let lookups = null;
    async function loadLookups() {
        if (!lookups) {
            const r = await Promise.all([Api.get('/admin/stores'), Api.get('/admin/host-groups'), Api.get('/admin/pcs')]);
            lookups = { store: r[0], group: r[1], pc: r[2] };
        }
        return lookups;
    }

    // ---- Переменные панели ---------------------------------------------------------------
    let vars = [];
    const revealed = new Set();

    async function loadVars() {
        vars = await Api.get('/admin/variables');
        $('varCount').textContent = vars.length;
        renderVars();
    }

    function scopeHtml(v) {
        const links = { store: '/admin/stores/store?id=', group: '/admin/hosts?group_id=', pc: '/admin/hosts/host?id=' };
        return '<span class="badge badge-neutral plain scope-badge">' + SCOPES[v.scope] + '</span>' +
            (v.scope === 'global' ? '' : ' <a href="' + links[v.scope] + v.scope_id + '">' + esc(v.scope_name || ('#' + v.scope_id)) + '</a>');
    }

    function valueHtml(v) {
        if (+v.is_secret && !revealed.has(v.id)) {
            return '<span class="secret-mask">••••••</span> <button type="button" class="small ghost" data-reveal="' + v.id + '" title="Показать значение">показать</button>';
        }
        return '<code>' + esc(v.value) + '</code>' + (+v.is_secret ? ' <span class="muted" style="font-size:12px">секретное</span>' : '');
    }

    function renderVars() {
        const q = $('search').value.trim().toLowerCase();
        const scope = $('scopeFilter').value;
        const list = vars.filter(function (v) {
            if (scope && v.scope !== scope) return false;
            if (!q) return true;
            return [v.name, +v.is_secret ? '' : v.value, v.scope_name, v.note].some(function (x) { return x && String(x).toLowerCase().indexOf(q) >= 0; });
        });
        const tbody = document.querySelector('#varsTable tbody');
        if (!vars.length) {
            tbody.innerHTML = '<tr><td colspan="6">' + Ui.emptyState({ icon: 'braces', title: 'Переменных пока нет',
                text: 'Например, PROFIT_DIR = C:\\ProfiT для всех касс и своё значение для магазина, где программа стоит в другой папке.',
                action: { id: 'emptyAddBtn', label: '＋ Переменная' } }) + '</td></tr>';
            $('emptyAddBtn').addEventListener('click', function () { editVar(null); });
            return;
        }
        tbody.innerHTML = list.length ? list.map(function (v) {
            return '<tr data-id="' + v.id + '"><td><span class="var-name">' + esc(v.name) + '</span></td>' +
                '<td style="max-width:360px;word-break:break-all">' + valueHtml(v) + '</td>' +
                '<td>' + scopeHtml(v) + '</td>' +
                '<td class="muted" style="font-size:12.5px">' + esc(v.note || '') + '</td>' +
                '<td class="muted nowrap" style="font-size:12.5px" title="' + esc(formatServerTime(v.updated_at)) + '">' + esc(v.updated_by_username || '—') + '<br>' + esc(formatServerTime(v.updated_at)) + '</td>' +
                '<td><div class="actions" style="flex-wrap:nowrap">' +
                    '<button type="button" class="small" data-edit title="Изменить значение, уровень или примечание">Изменить</button>' +
                    '<button type="button" class="small ghost icon-only" data-more title="Скопировать {{ИМЯ}}, задать для другого уровня, удалить">⋯</button>' +
                '</div></td></tr>';
        }).join('') : '<tr><td colspan="6" class="empty">Под фильтр ничего не попало.</td></tr>';
    }

    $('search').addEventListener('input', renderVars);
    $('scopeFilter').addEventListener('change', renderVars);
    $('addVarBtn').addEventListener('click', function () { editVar(null); });

    document.querySelector('#varsTable').addEventListener('click', async function (e) {
        const reveal = e.target.closest('[data-reveal]');
        if (reveal) { revealed.add(+reveal.dataset.reveal); renderVars(); return; }
        const tr = e.target.closest('tr[data-id]');
        if (!tr) return;
        const v = vars.find(function (x) { return String(x.id) === tr.dataset.id; });
        if (e.target.closest('[data-edit]')) { editVar(v); return; }
        const more = e.target.closest('[data-more]');
        if (more) {
            const act = await Ui.menu(more, [
                { label: 'Скопировать {{' + v.name + '}}', value: 'copy' },
                { label: 'Задать для другого уровня…', value: 'override' },
                { label: 'Удалить', value: 'delete', danger: true },
            ]);
            if (act === 'copy') navigator.clipboard.writeText('{{' + v.name + '}}').then(function () { Ui.toast('Скопировано: {{' + v.name + '}}', 'success'); });
            if (act === 'override') editVar({ name: v.name, scope: v.scope === 'global' ? 'store' : 'pc', value: v.value, is_secret: v.is_secret }, true);
            if (act === 'delete') {
                if (!await Ui.confirm('Удалить переменную ' + v.name + ' (' + SCOPES[v.scope] + (v.scope_name ? ' «' + v.scope_name + '»' : '') + ')? ' +
                    'Команды с {{' + v.name + '}}, которые кассы ещё не забрали, на кассах без другого значения завершатся ошибкой.', { danger: true, okLabel: 'Удалить' })) return;
                try { await Api.request('DELETE', '/admin/variables/' + v.id); Ui.toast('Удалено', 'success'); await loadVars(); }
                catch (err) { Ui.toast('Не удалось: ' + Ui.reason(err, ERRORS), 'error'); }
            }
        }
    });

    // Форма переменной. asNew — заготовка для нового уровня (без id).
    async function editVar(v, asNew) {
        const lk = await loadLookups();
        const isEdit = v && v.id && !asNew;
        let pickedPc = null;
        const ok = await Ui.modal({
            title: isEdit ? 'Переменная ' + v.name : 'Новая переменная', wide: true,
            body:
                '<div class="row">' +
                '<label>Имя<span class="hint">Латиница, цифры и _, с буквы. В скрипте — {{ИМЯ}}. Регистр не важен.</span>' +
                '<input type="text" id="vName" class="mono" spellcheck="false" value="' + esc(v ? v.name : '') + '" placeholder="PROFIT_DIR"></label>' +
                '<label>Уровень<span class="hint">Где действует значение. Более узкий уровень перекрывает более широкий: касса → группа → магазин → все кассы.</span>' +
                '<select id="vScope">' + Object.keys(SCOPES).map(function (k) { return '<option value="' + k + '">' + SCOPES[k] + '</option>'; }).join('') + '</select></label>' +
                '<label id="vScopeIdWrap">Для кого<select id="vScopeId"></select><div id="vPc" hidden></div></label>' +
                '</div>' +
                '<label>Значение<span class="hint">Подставляется в скрипт и путь как есть, одной строкой.</span>' +
                '<input type="text" id="vValue" class="mono" spellcheck="false" value="' + esc(v ? v.value : '') + '"></label>' +
                '<div class="row"><label style="flex:2">Примечание (необязательно)<input type="text" id="vNote" value="' + esc(v && v.note || '') + '" placeholder="зачем эта переменная"></label>' +
                '<label style="align-self:end"><input type="checkbox" id="vSecret"' + (v && +v.is_secret ? ' checked' : '') + '> Секретное значение' +
                '<span class="hint">Не показывать в списке (только по кнопке). До кассы значение всё равно доходит открытым текстом в составе скрипта.</span></label></div>' +
                '<p class="error modal-error"></p>',
            buttons: [{ label: 'Отмена', value: null }, { label: isEdit ? 'Сохранить' : 'Создать', value: 'submit', kind: 'primary' }],
            onOpen: function (root) {
                const scopeEl = root.querySelector('#vScope');
                const idEl = root.querySelector('#vScopeId');
                const pcBox = root.querySelector('#vPc');
                function fill(selectedId) {
                    const s = scopeEl.value;
                    root.querySelector('#vScopeIdWrap').hidden = s === 'global';
                    idEl.hidden = s === 'pc';
                    pcBox.hidden = s !== 'pc';
                    if (s === 'store' || s === 'group') {
                        idEl.innerHTML = lk[s].map(function (it) {
                            return '<option value="' + it.id + '">' + esc(it.name) + (it.kind === 'smart' ? ' (смарт)' : '') + '</option>';
                        }).join('');
                        if (selectedId) idEl.value = selectedId;
                    }
                    if (s === 'pc') {
                        pickedPc = null;
                        Ui.pcPicker(pcBox, lk.pc, function (pc) { pickedPc = pc; });
                        const pre = selectedId && lk.pc.find(function (pc) { return String(pc.id) === String(selectedId); });
                        if (pre) { pickedPc = pre; pcBox.querySelector('.pc-picker-search').value = Ui.pcLabel(pre); }
                    }
                }
                scopeEl.value = v && v.scope ? v.scope : 'global';
                fill(v && v.scope_id);
                scopeEl.addEventListener('change', function () { fill(null); });
            },
            onSubmit: async function (root) {
                const scope = root.querySelector('#vScope').value;
                const body = {
                    name: root.querySelector('#vName').value.trim(), scope: scope,
                    scope_id: scope === 'pc' ? (pickedPc ? pickedPc.id : null) : (scope === 'global' ? null : root.querySelector('#vScopeId').value),
                    value: root.querySelector('#vValue').value, note: root.querySelector('#vNote').value.trim(),
                    is_secret: root.querySelector('#vSecret').checked ? 1 : 0,
                };
                if (scope !== 'global' && !body.scope_id) { root.querySelector('.modal-error').textContent = 'Выберите, для кого задано значение.'; return false; }
                try {
                    if (isEdit) await Api.request('PUT', '/admin/variables/' + v.id, body);
                    else await Api.post('/admin/variables', body);
                } catch (err) {
                    root.querySelector('.modal-error').textContent = 'Не сохранено: ' + Ui.reason(err, ERRORS);
                    return false;
                }
            },
        });
        if (ok) { Ui.toast('Сохранено', 'success'); await loadVars(); }
    }

    // Что получит конкретная касса.
    $('checkPcBtn').addEventListener('click', async function () {
        const lk = await loadLookups();
        let picked = null;
        Ui.modal({
            title: 'Переменные кассы', wide: true,
            body: '<label>Касса<div id="effPc"></div></label><div id="effOut" class="muted">Выберите кассу — покажу, какие значения она получит и откуда каждое.</div>',
            buttons: [{ label: 'Закрыть', value: null }],
            onOpen: function (root) {
                Ui.pcPicker(root.querySelector('#effPc'), lk.pc, async function (pc) {
                    picked = pc;
                    const out = root.querySelector('#effOut');
                    out.innerHTML = '<span class="spinner"></span>';
                    try {
                        const list = await Api.get('/admin/variables/effective?pc_id=' + pc.id);
                        if (picked !== pc) return;
                        out.innerHTML = list.length ? '<table><thead><tr><th>Имя</th><th>Значение</th><th>Откуда</th></tr></thead><tbody>' + list.map(function (x) {
                            return '<tr><td><span class="var-name">' + esc(x.name) + '</span></td><td>' + (+x.is_secret ? '<span class="secret-mask">••••••</span>' : '<code>' + esc(x.value) + '</code>') +
                                '</td><td>' + SCOPES[x.scope] + (x.scope_name ? ' «' + esc(x.scope_name) + '»' : '') + '</td></tr>';
                        }).join('') + '</tbody></table>' : 'У этой кассы нет ни одной переменной.';
                    } catch (err) { out.textContent = 'Не удалось: ' + Ui.reason(err, ERRORS); }
                });
            },
        });
    });

    // ---- Переменные среды Windows -------------------------------------------------------
    const ACTIONS = { list: 'показать все', get: 'показать', set: 'задать', delete: 'удалить', path_add: 'добавить в PATH', path_remove: 'убрать из PATH' };
    const target = Ui.targetPicker($('envTarget'), {});
    const initial = Ui.targetFromQuery();
    if (initial) { showTab('windows'); target.set(initial.type, initial.id); }

    function syncEnvForm() {
        const a = $('envAction').value;
        $('envNameWrap').hidden = !(a === 'get' || a === 'set' || a === 'delete');
        $('envValueWrap').hidden = !(a === 'set' || a === 'path_add' || a === 'path_remove');
        $('envValueLabel').textContent = a === 'set' ? 'Значение' : 'Папка';
        $('envValue').placeholder = a === 'set' ? 'C:\\ProfiT' : '%ProgramFiles%\\ProfiT\\bin';
        $('envSendBtn').textContent = a === 'list' || a === 'get' ? 'Посмотреть' : 'Отправить';
    }
    $('envAction').addEventListener('change', syncEnvForm);
    syncEnvForm();

    $('envForm').addEventListener('submit', async function (e) {
        e.preventDefault();
        $('envError').textContent = '';
        const a = $('envAction').value;
        const payload = { action: a, name: $('envName').value.trim(), value: $('envValue').value.trim() };
        const t = target.value();
        const stats = target.stats();
        if (t.type !== 'all' && !t.id) { $('envError').textContent = 'Выберите, кому.'; return; }
        if (!stats.total) { $('envError').textContent = 'Под эту цель не подходит ни одна касса.'; return; }
        const changes = a !== 'list' && a !== 'get';
        if (changes && !await Ui.confirm('Изменить системные переменные среды на ' + stats.total + ' ' + Ui.plural(stats.total, 'кассе', 'кассах', 'кассах') +
            ' (' + target.describe() + '): ' + ACTIONS[a] + (payload.name && a !== 'path_add' && a !== 'path_remove' ? ' ' + payload.name : '') +
            (payload.value ? ' «' + payload.value + '»' : '') + '?', { okLabel: 'Отправить', danger: a === 'delete' })) return;
        $('envSendBtn').disabled = true;
        try {
            const r = await Api.post('/admin/commands', { type: 'env_var', payload: payload, target: t });
            Ui.toast('Отправлено — касса выполнит на ближайшем опросе', 'success');
            await loadEnvCommands(r.id);
        } catch (err) {
            $('envError').textContent = 'Не отправлено: ' + Ui.reason(err, ERRORS);
        } finally {
            $('envSendBtn').disabled = false;
        }
    });

    let envTimer = null;
    async function loadEnvCommands(openId) {
        clearTimeout(envTimer);
        const all = await Api.get('/admin/commands');
        const list = all.filter(function (c) { return c.type === 'env_var'; }).slice(0, 30);
        const tbody = document.querySelector('#envTable tbody');
        tbody.innerHTML = list.length ? list.map(function (c) {
            let p = {};
            try { p = JSON.parse(c.payload); } catch (e) { /* — */ }
            const what = ACTIONS[p.action] + (p.name && p.action !== 'path_add' && p.action !== 'path_remove' ? ' ' + p.name : '') + (p.value ? ' «' + p.value + '»' : '');
            return '<tr data-id="' + c.id + '"><td class="muted nowrap">' + esc(formatServerTime(c.created_at)) + '<br>' + esc(c.created_by_username || '') + '</td>' +
                '<td><code>' + esc(what) + '</code></td>' +
                '<td>' + esc(c.target_type === 'all' ? 'все кассы' : (c.target_name || c.target_type)) + '</td>' +
                '<td style="min-width:180px">' + Ui.commandProgressHtml(c) + '</td>' +
                '<td><div class="actions" style="flex-wrap:nowrap"><button type="button" class="small" data-results>Результаты</button>' +
                '<button type="button" class="small ghost" data-csv title="Результаты по каждой кассе одним файлом для Excel">CSV</button></div></td></tr>';
        }).join('') : '<tr><td colspan="5" class="empty">Команд с переменными среды ещё не было.</td></tr>';
        if (openId) {
            const tr = tbody.querySelector('tr[data-id="' + openId + '"]');
            if (tr) showResults(tr, openId);
        }
        // Пока есть незавершённые — обновлять сами.
        if (list.some(function (c) { return +c.pending_count && !+c.expired || +c.in_progress_count; }) && !$('envTable').closest('[hidden]')) {
            envTimer = setTimeout(function () { loadEnvCommands(); }, 4000);
        }
    }

    async function showResults(tr, id) {
        const row = Ui.toggleDetail(tr, '<div class="env-results"><span class="spinner"></span></div>', 5);
        if (!row) return;
        const results = await Api.get('/admin/commands/' + id + '/results');
        const LABELS = { pending: 'ждёт', in_progress: 'в работе', success: 'ок', failed: 'ошибка', timeout: 'таймаут' };
        row.querySelector('.env-results').innerHTML = '<table><thead><tr><th>Касса</th><th>Статус</th><th>Вывод</th></tr></thead><tbody>' + results.map(function (r) {
            return '<tr><td><a class="host-link" href="/admin/hosts/host?id=' + r.pc_id + '">' + esc(r.display_name || r.hostname) + '</a><span class="muted" style="display:block;font-size:12px">' + esc(r.store_name) + '</span></td>' +
                '<td><span class="badge badge-' + esc(r.status) + '">' + esc(LABELS[r.status] || r.status) + '</span></td>' +
                '<td>' + (r.output ? '<pre class="output">' + esc(r.output) + '</pre>' : '<span class="muted">' + (r.status === 'pending' ? (r.online ? 'заберёт на ближайшем опросе' : 'не на связи — заберёт, когда включится') : '—') + '</span>') + '</td></tr>';
        }).join('') + '</tbody></table>';
    }

    document.querySelector('#envTable').addEventListener('click', function (e) {
        const csv = e.target.closest('[data-csv]');
        if (csv) { window.location.href = '/admin/commands/' + csv.closest('tr[data-id]').dataset.id + '/results.csv'; return; }
        const btn = e.target.closest('[data-results]');
        if (!btn) return;
        const tr = btn.closest('tr[data-id]');
        showResults(tr, tr.dataset.id);
    });

    await loadVars();
})();
