// Группы хостов. Обычная группа наполняется руками; смарт-группа (бета, только
// суперадмин) — сама, по условиям: её состав сервер пересчитывает при сохранении и раз в
// минуту (Core/SmartGroups.php). Обоим видам одинаково шлют оповещения, команды и файлы.
(async function () {
    const me = await requireAdminAuth();
    const canEdit = me.role === 'administrator' || me.role === 'superadmin';
    const isSuper = me.role === 'superadmin';
    const $ = Ui.$, esc = Ui.escapeHtml;

    let groups = [];
    let allPcs = null;
    let lookups = null;

    if (isSuper) $('addSmartBtn').hidden = false;

    async function loadLookups() {
        if (!lookups) {
            const [stores, deviceTypes] = await Promise.all([Api.get('/admin/stores'), Api.get('/admin/device-types')]);
            lookups = { stores: stores, deviceTypes: deviceTypes, groups: [] };
        }
        lookups.groups = groups.filter(function (g) { return g.kind !== 'smart'; });
        return lookups;
    }

    async function loadGroups() {
        groups = await Api.get('/admin/host-groups');
        if (isSuper && groups.some(function (g) { return g.kind === 'smart'; })) await loadLookups();
        const tbody = document.querySelector('#groupsTable tbody');
        tbody.innerHTML = '';
        if (!groups.length) {
            tbody.innerHTML = '<tr><td colspan="4">' + Ui.emptyState({ icon: 'layers', title: 'Групп пока нет',
                text: 'Группа — свой набор касс поверх магазинов: «Кассы 1 этажа», «Пилот». Ей можно слать оповещения, команды и файлы.' }) + '</td></tr>';
            return;
        }
        groups.forEach(function (g) {
            const smart = g.kind === 'smart';
            const tr = document.createElement('tr');
            tr.className = 'clickable';
            tr.dataset.id = g.id;
            tr.innerHTML =
                '<td><b>' + esc(g.name) + '</b>' + (smart ? ' <span class="badge badge-beta" title="Смарт-группа: наполняется сама по условиям. Бета, видна только суперадмину">смарт · бета</span>' : '') +
                    (g.description ? '<div class="muted" style="font-size:12.5px">' + esc(g.description) + '</div>' : '') + '</td>' +
                '<td class="muted" style="font-size:12.5px;max-width:420px">' + (smart
                    ? esc(SmartRules.describe(g.rules, lookups || {})) + (g.refreshed_at ? '<div>пересчитана ' + esc(formatServerTime(g.refreshed_at)) + '</div>' : '')
                    : 'вручную') + '</td>' +
                '<td class="num">' + g.member_count + '</td>' +
                '<td><div class="actions" style="flex-wrap:nowrap">' +
                '<button type="button" class="small" data-act="notify" title="Новое оповещение для этой группы">' + Ui.icon('bell') + 'Оповестить</button>' +
                '<button type="button" class="small ghost icon-only" data-act="more" title="Хосты группы, команда, файл, изменить, удалить">⋯</button>' +
                '</div></td>';
            tbody.appendChild(tr);
        });
    }

    function groupNameForm(g) {
        return Ui.modal({
            title: g ? 'Группа «' + g.name + '»' : 'Новая группа',
            body:
                '<label>Название<input type="text" id="grName" value="' + esc(g ? g.name : '') + '"></label>' +
                '<label>Свой бренд в оповещениях<input type="text" id="grBrandName" value="' + esc(g && g.brand_name || '') + '" placeholder="пусто — общий из Настроек (или магазина)"></label>' +
                '<label>Свой контакт в оповещениях<input type="text" id="grBrandContact" value="' + esc(g && g.brand_contact || '') + '" placeholder="пусто — общий из Настроек (или магазина)"></label>' +
                '<p class="error modal-error"></p>',
            buttons: [{ label: 'Отмена', value: null }, { label: g ? 'Сохранить' : 'Создать', value: 'submit', kind: 'primary' }],
            onSubmit: async function (root) {
                const name = root.querySelector('#grName').value.trim();
                if (!name) { root.querySelector('.modal-error').textContent = 'Введите название.'; return false; }
                const body = { name: name, brand_name: root.querySelector('#grBrandName').value.trim(), brand_contact: root.querySelector('#grBrandContact').value.trim() };
                if (g) await Api.request('PUT', '/admin/host-groups/' + g.id, body);
                else await Api.post('/admin/host-groups', body);
            },
        }).then(async function (v) {
            if (!v) return;
            Ui.toast('Сохранено', 'success');
            await loadGroups();
        });
    }

    // ---- Смарт-группа: конструктор условий с живым предпросмотром ----------------------

    async function smartForm(g) {
        await loadLookups();
        let ed = null, timer = null, seq = 0;
        const result = await Ui.modal({
            title: g ? 'Смарт-группа «' + g.name + '»' : 'Новая смарт-группа', wide: true,
            body:
                '<p class="muted" style="margin-top:0"><span class="badge badge-beta">бета</span> Группа наполняется сама: сервер проверяет условия при сохранении и дальше ' +
                'раз в минуту — касса, которая обновила агента или сменила IP, попадёт в группу (или выпадет) без вашего участия. Видна только суперадмину.</p>' +
                '<div class="row"><label>Название<input type="text" id="sgName" value="' + esc(g ? g.name : '') + '" placeholder="Например: Старый агент"></label>' +
                '<label>Описание (необязательно)<input type="text" id="sgDesc" value="' + esc(g && g.description || '') + '" placeholder="зачем эта группа"></label></div>' +
                '<div id="sgRules"></div>' +
                '<div class="rule-preview" id="sgPreview"><span class="muted">Считаю, кто подходит…</span></div>' +
                '<p class="error modal-error"></p>',
            buttons: [{ label: 'Отмена', value: null }, { label: g ? 'Сохранить' : 'Создать', value: 'submit', kind: 'primary' }],
            onSubmit: async function (root) {
                const name = root.querySelector('#sgName').value.trim();
                if (!name) { root.querySelector('.modal-error').textContent = 'Введите название.'; return false; }
                const body = { kind: 'smart', name: name, description: root.querySelector('#sgDesc').value.trim(), rules: ed.rules() };
                try {
                    if (g) return await Api.request('PUT', '/admin/host-groups/' + g.id, body);
                    return await Api.post('/admin/host-groups', body);
                } catch (err) {
                    root.querySelector('.modal-error').textContent = 'Не сохранено: ' + Ui.reason(err, SmartRules.ERRORS) +
                        (err.data && err.data.index !== undefined ? ' (условие №' + (err.data.index + 1) + ')' : '');
                    return false;
                }
            },
            onOpen: function (root) {
            ed = SmartRules.editor(root.querySelector('#sgRules'), g ? g.rules : null, lookups);
            const box = root.querySelector('#sgPreview');
            async function preview() {
                const my = ++seq;
                try {
                    const r = await Api.post('/admin/host-groups/preview', { rules: ed.rules() });
                    if (my !== seq) return;
                    box.innerHTML = '<b>' + r.count + '</b> ' + Ui.plural(r.count, 'касса', 'кассы', 'касс') + ' из ' + r.total +
                        ' <span class="muted">· на связи ' + r.online + '</span>' +
                        (r.pcs.length ? '<div class="sample">' + r.pcs.map(function (pc) {
                            return esc(pc.display_name || pc.hostname) + ' <span class="muted">' + esc(pc.store_name) + (pc.last_ip ? ' · ' + esc(pc.last_ip) : '') + '</span>';
                        }).join('<br>') + (r.count > r.pcs.length ? '<br><span class="muted">… и ещё ' + (r.count - r.pcs.length) + '</span>' : '') + '</div>' : '');
                } catch (err) {
                    if (my !== seq) return;
                    box.innerHTML = '<span class="warn-text">' + esc(Ui.reason(err, SmartRules.ERRORS)) +
                        (err.data && err.data.index !== undefined ? ' (условие №' + (err.data.index + 1) + ')' : '') + '</span>';
                }
            }
            ed.onChange(function () { clearTimeout(timer); timer = setTimeout(preview, 400); });
            preview();
            },
        });
        if (!result) return;
        Ui.toast('Сохранено' + (result.member_count !== null && result.member_count !== undefined ? ': в группе ' + result.member_count + ' ' + Ui.plural(result.member_count, 'касса', 'кассы', 'касс') : ''), 'success');
        await loadGroups();
    }

    $('addGroupBtn').addEventListener('click', function () { groupNameForm(null); });
    $('addSmartBtn').addEventListener('click', function () { smartForm(null); });

    // ---- Состав группы (раскрывается под строкой) --------------------------------------

    async function renderMembers(detailRow, g) {
        const members = await Api.get('/admin/host-groups/' + g.id + '/members');
        const host = detailRow.querySelector('.members');
        const smart = g.kind === 'smart';
        if (!members.length) {
            host.innerHTML = '<p class="muted">' + (smart ? 'Под условия сейчас не подходит ни одна касса.' : 'В группе пока никого.') + '</p>';
        } else {
            host.innerHTML = '<table><thead><tr><th>Магазин</th><th>Хост</th>' + (smart ? '<th>IP</th>' : '<th></th>') + '</tr></thead><tbody>' +
                members.map(function (m) {
                    return '<tr><td>' + esc(m.store_name) + '</td><td><a class="host-link" href="/admin/hosts/host?id=' + m.id + '">' + esc(m.display_name || m.hostname) + '</a>' +
                        (m.display_name ? ' <span class="muted">' + esc(m.hostname) + '</span>' : '') + '</td>' +
                        (smart ? '<td class="muted">' + esc(m.last_ip || '—') + '</td>'
                            : '<td><div class="actions"><button type="button" data-remove="' + m.id + '">Убрать</button></div></td>') + '</tr>';
                }).join('') + '</tbody></table>';
        }
        return members;
    }

    async function openSmartGroup(tr, g) {
        const html = '<div class="row" style="align-items:center;gap:10px;margin-bottom:8px">' +
            '<span class="muted" style="flex:1">Условия: ' + esc(SmartRules.describe(g.rules, lookups || {})) + '</span>' +
            '<button type="button" class="small" data-refresh title="Проверить условия по всем кассам прямо сейчас (сервер и так делает это раз в минуту)">' + Ui.icon('refresh') + 'Пересчитать</button>' +
            '<button type="button" class="small" data-edit-rules>Изменить условия</button></div>' +
            '<div class="members"></div>';
        const row = Ui.toggleDetail(tr, html, 4);
        if (!row) return;
        await renderMembers(row, g);
        row.querySelector('[data-refresh]').addEventListener('click', async function () {
            try {
                const r = await Api.post('/admin/host-groups/' + g.id + '/refresh');
                Ui.toast('Пересчитано: ' + r.member_count + ' ' + Ui.plural(r.member_count, 'касса', 'кассы', 'касс'), 'success');
                await renderMembers(row, g);
                await loadGroupsKeepingDetail(tr);
            } catch (err) { Ui.toast('Не удалось: ' + Ui.reason(err), 'error'); }
        });
        row.querySelector('[data-edit-rules]').addEventListener('click', function () { smartForm(g); });
    }

    async function openGroup(tr, g) {
        if (g.kind === 'smart') return openSmartGroup(tr, g);
        const html =
            '<div class="row" style="align-items:flex-start;gap:20px">' +
            '<div style="flex:1;min-width:0"><h2>Состав</h2><div class="members"></div></div>' +
            '<div style="flex:1;min-width:0"><h2>Добавить ПК</h2>' +
            '<input type="search" class="pick-search" placeholder="Фильтр: hostname, магазин…" style="width:100%;margin:6px 0 8px">' +
            '<div class="checklist"></div>' +
            '<div class="row" style="margin-top:10px"><button type="button" class="primary small add-selected">Добавить отмеченные</button>' +
            '<span class="muted selected-count"></span></div></div></div>';
        const row = Ui.toggleDetail(tr, html, 4);
        if (!row) return;

        const members = await renderMembers(row, g);
        if (!allPcs) allPcs = await Api.get('/admin/pcs');
        const list = row.querySelector('.checklist');
        const search = row.querySelector('.pick-search');
        const count = row.querySelector('.selected-count');

        function renderList() {
            const memberIds = new Set(members.map(function (m) { return m.id; }));
            const q = search.value.toLowerCase();
            const items = allPcs.filter(function (pc) {
                if (memberIds.has(pc.id)) return false;
                return !q || Ui.pcMatches(pc, q);
            });
            list.innerHTML = items.length ? items.map(function (pc) {
                return '<label><input type="checkbox" value="' + pc.id + '">' + esc(pc.display_name || pc.hostname) +
                    '<span class="sub">' + esc(pc.store_name) + (pc.last_ip ? ' · ' + esc(pc.last_ip) : '') + '</span></label>';
            }).join('') : '<div class="empty">Все подходящие ПК уже в группе.</div>';
            count.textContent = '';
        }
        renderList();
        search.addEventListener('input', renderList);
        list.addEventListener('change', function () {
            const n = list.querySelectorAll('input:checked').length;
            count.textContent = n ? 'выбрано: ' + n : '';
        });

        row.querySelector('.add-selected').addEventListener('click', async function () {
            const ids = [...list.querySelectorAll('input:checked')].map(function (i) { return parseInt(i.value, 10); });
            if (!ids.length) { Ui.toast('Отметьте хотя бы один ПК', 'error'); return; }
            try {
                await Api.post('/admin/host-groups/' + g.id + '/members', { pc_ids: ids });
                Ui.toast('Добавлено: ' + ids.length, 'success');
                ids.forEach(function (id) { members.push(allPcs.find(function (p) { return p.id === id; })); });
                await renderMembers(row, g);
                renderList();
                await loadGroupsKeepingDetail(tr);
            } catch (err) { Ui.toast('Не удалось: ' + Ui.reason(err), 'error'); }
        });

        row.addEventListener('click', async function (e) {
            const btn = e.target.closest('button[data-remove]');
            if (!btn) return;
            await Api.request('DELETE', '/admin/host-groups/' + g.id + '/members/' + btn.dataset.remove);
            const idx = members.findIndex(function (m) { return String(m.id) === btn.dataset.remove; });
            if (idx >= 0) members.splice(idx, 1);
            await renderMembers(row, g);
            renderList();
            await loadGroupsKeepingDetail(tr);
        });
    }

    // Обновить счётчик участников в таблице, не закрывая раскрытую строку.
    async function loadGroupsKeepingDetail(tr) {
        const fresh = await Api.get('/admin/host-groups');
        groups = fresh;
        const g = fresh.find(function (x) { return String(x.id) === tr.dataset.id; });
        if (g) tr.children[2].textContent = g.member_count;
    }

    document.querySelector('#groupsTable').addEventListener('click', async function (e) {
        const tr = e.target.closest('tr[data-id]');
        if (!tr) return;
        const g = groups.find(function (x) { return String(x.id) === tr.dataset.id; });
        const btn = e.target.closest('button[data-act]');
        if (btn) {
            const target = 'target=group:' + g.id;
            const smart = g.kind === 'smart';
            let act = btn.dataset.act;
            if (act === 'more') {
                act = await Ui.menu(btn, [{ label: 'Показать хосты группы', value: 'hosts' }].concat(canEdit ? [
                    { label: 'Команда группе…', value: 'command' },
                    { label: 'Положить файл группе…', value: 'file' },
                ] : []).concat(smart ? [
                    { label: 'Изменить условия и название', value: 'smart' },
                ] : [
                    { label: 'Переименовать', value: 'rename' },
                ]).concat([
                    { label: 'Удалить группу', value: 'delete', danger: true },
                ]));
            }
            if (act === 'notify') window.location.href = '/admin/notifications?' + target;
            if (act === 'hosts') window.location.href = '/admin/hosts?group_id=' + g.id;
            if (act === 'command') window.location.href = '/admin/commands?' + target;
            if (act === 'file') window.location.href = '/admin/files?' + target;
            if (act === 'rename') groupNameForm(g);
            if (act === 'smart') smartForm(g);
            if (act === 'delete') {
                if (!await Ui.confirm('Удалить группу «' + g.name + '»? Оповещения и команды, нацеленные на неё, перестанут кому-либо попадать.', { danger: true, okLabel: 'Удалить' })) return;
                try { await Api.request('DELETE', '/admin/host-groups/' + g.id); Ui.toast('Группа удалена', 'success'); loadGroups(); }
                catch (err) { Ui.toast('Не удалось: ' + Ui.reason(err), 'error'); }
            }
            return;
        }
        openGroup(tr, g);
    });

    await loadGroups();
    setInterval(function () { if (!document.hidden && !document.querySelector('.modal-back') && !document.querySelector('tr.detail-row')) loadGroups(); }, 30000);
})();
