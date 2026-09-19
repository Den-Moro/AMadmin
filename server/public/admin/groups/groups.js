(async function () {
    await requireAdminAuth();
    const $ = Ui.$, esc = Ui.escapeHtml;

    let groups = [];
    let allPcs = null;

    async function loadGroups() {
        groups = await Api.get('/admin/host-groups');
        const tbody = document.querySelector('#groupsTable tbody');
        tbody.innerHTML = '';
        if (!groups.length) {
            tbody.innerHTML = '<tr><td colspan="3" class="empty">Групп пока нет — создайте первую.</td></tr>';
            return;
        }
        groups.forEach(function (g) {
            const tr = document.createElement('tr');
            tr.className = 'clickable';
            tr.dataset.id = g.id;
            tr.innerHTML =
                '<td><b>' + esc(g.name) + '</b></td>' +
                '<td class="num">' + g.member_count + '</td>' +
                '<td><div class="actions">' +
                '<button type="button" data-act="rename">Переименовать</button>' +
                '<button type="button" data-act="delete" class="danger">Удалить</button>' +
                '</div></td>';
            tbody.appendChild(tr);
        });
    }

    function groupNameForm(g) {
        return Ui.prompt('Название группы', {
            title: g ? 'Переименовать группу' : 'Новая группа',
            value: g ? g.name : '',
            okLabel: g ? 'Сохранить' : 'Создать',
            validate: function (v) { return v.trim() ? null : 'Введите название.'; },
        }).then(async function (name) {
            if (name === null) return;
            try {
                if (g) await Api.request('PUT', '/admin/host-groups/' + g.id, { name: name.trim() });
                else await Api.post('/admin/host-groups', { name: name.trim() });
                Ui.toast('Сохранено', 'success');
                await loadGroups();
            } catch (err) { Ui.toast('Не удалось: ' + Ui.reason(err), 'error'); }
        });
    }

    $('addGroupBtn').addEventListener('click', function () { groupNameForm(null); });

    // ---- Состав группы (раскрывается под строкой) --------------------------------------

    async function renderMembers(detailRow, g) {
        const members = await Api.get('/admin/host-groups/' + g.id + '/members');
        const host = detailRow.querySelector('.members');
        if (!members.length) {
            host.innerHTML = '<p class="muted">В группе пока никого.</p>';
        } else {
            host.innerHTML = '<table><thead><tr><th>Магазин</th><th>Хост</th><th></th></tr></thead><tbody>' +
                members.map(function (m) {
                    return '<tr><td>' + esc(m.store_name) + '</td><td>' + esc(m.display_name || m.hostname) +
                        (m.display_name ? ' <span class="muted">' + esc(m.hostname) + '</span>' : '') + '</td>' +
                        '<td><div class="actions"><button type="button" data-remove="' + m.id + '">Убрать</button></div></td></tr>';
                }).join('') + '</tbody></table>';
        }
        return members;
    }

    async function openGroup(tr, g) {
        const html =
            '<div class="row" style="align-items:flex-start;gap:20px">' +
            '<div style="flex:1;min-width:0"><h2>Состав</h2><div class="members"></div></div>' +
            '<div style="flex:1;min-width:0"><h2>Добавить ПК</h2>' +
            '<input type="search" class="pick-search" placeholder="Фильтр: hostname, магазин…" style="width:100%;margin:6px 0 8px">' +
            '<div class="checklist"></div>' +
            '<div class="row" style="margin-top:10px"><button type="button" class="primary small add-selected">Добавить отмеченные</button>' +
            '<span class="muted selected-count"></span></div></div></div>';
        const row = Ui.toggleDetail(tr, html, 3);
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
                const hay = (pc.hostname + ' ' + (pc.display_name || '') + ' ' + pc.store_name).toLowerCase();
                return !q || hay.indexOf(q) >= 0;
            });
            list.innerHTML = items.length ? items.map(function (pc) {
                return '<label><input type="checkbox" value="' + pc.id + '">' + esc(pc.display_name || pc.hostname) +
                    '<span class="sub">' + esc(pc.store_name) + '</span></label>';
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
                await loadGroupsKeepingDetail(tr, row);
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
            await loadGroupsKeepingDetail(tr, row);
        });
    }

    // Обновить счётчик участников в таблице, не закрывая раскрытую строку.
    async function loadGroupsKeepingDetail(tr, row) {
        const fresh = await Api.get('/admin/host-groups');
        groups = fresh;
        const g = fresh.find(function (x) { return String(x.id) === tr.dataset.id; });
        if (g) tr.children[1].textContent = g.member_count;
    }

    document.querySelector('#groupsTable').addEventListener('click', async function (e) {
        const tr = e.target.closest('tr[data-id]');
        if (!tr) return;
        const g = groups.find(function (x) { return String(x.id) === tr.dataset.id; });
        const btn = e.target.closest('button[data-act]');
        if (btn) {
            if (btn.dataset.act === 'rename') groupNameForm(g);
            if (btn.dataset.act === 'delete') {
                if (!await Ui.confirm('Удалить группу «' + g.name + '»? Оповещения и команды, нацеленные на неё, перестанут кому-либо попадать.', { danger: true, okLabel: 'Удалить' })) return;
                try { await Api.request('DELETE', '/admin/host-groups/' + g.id); Ui.toast('Группа удалена', 'success'); loadGroups(); }
                catch (err) { Ui.toast('Не удалось: ' + Ui.reason(err), 'error'); }
            }
            return;
        }
        openGroup(tr, g);
    });

    await loadGroups();
})();
