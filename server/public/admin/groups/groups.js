(async function () {
    await requireAdminAuth();


    function escapeHtml(s) {
        const div = document.createElement('div');
        div.textContent = s == null ? '' : String(s);
        return div.innerHTML;
    }

    let currentGroupId = null;
    let allPcs = [];

    async function loadGroups() {
        const groups = await Api.get('/admin/host-groups');
        const tbody = document.querySelector('#groupsTable tbody');
        tbody.innerHTML = '';
        groups.forEach(function (g) {
            const tr = document.createElement('tr');
            tr.innerHTML =
                '<td>' + escapeHtml(g.name) + '</td>' +
                '<td>' + g.member_count + '</td>' +
                '<td>' +
                '<button type="button" data-open="' + g.id + '">Открыть</button> ' +
                '<button type="button" data-delete="' + g.id + '">Удалить</button>' +
                '</td>';
            tbody.appendChild(tr);
        });
    }

    document.querySelector('#groupsTable').addEventListener('click', async function (e) {
        const openId = e.target.getAttribute('data-open');
        const deleteId = e.target.getAttribute('data-delete');

        if (openId) {
            await openGroup(openId, e.target.closest('tr').children[0].textContent);
        }

        if (deleteId) {
            if (!confirm('Удалить группу? Оповещения, нацеленные на неё, просто перестанут кому-то попадать.')) {
                return;
            }
            await Api.request('DELETE', '/admin/host-groups/' + deleteId);
            if (currentGroupId === deleteId) {
                document.getElementById('detail').style.display = 'none';
                currentGroupId = null;
            }
            await loadGroups();
        }
    });

    async function openGroup(id, name) {
        currentGroupId = id;
        document.getElementById('detail').style.display = '';
        document.getElementById('detailTitle').textContent = 'Участники: ' + name;
        await loadMembers();
        await loadPcOptions();
    }

    async function loadMembers() {
        const members = await Api.get('/admin/host-groups/' + currentGroupId + '/members');
        const tbody = document.querySelector('#membersTable tbody');
        tbody.innerHTML = '';
        members.forEach(function (m) {
            const tr = document.createElement('tr');
            tr.innerHTML =
                '<td>' + escapeHtml(m.store_name) + '</td>' +
                '<td>' + escapeHtml(m.display_name || m.hostname) + ' <span class="muted">(' + escapeHtml(m.hostname) + ')</span></td>' +
                '<td><button type="button" data-remove="' + m.id + '">Убрать</button></td>';
            tbody.appendChild(tr);
        });
    }

    async function loadPcOptions() {
        if (allPcs.length === 0) {
            allPcs = await Api.get('/admin/pcs');
        }
        const select = document.getElementById('addPcSelect');
        select.innerHTML = '';
        allPcs.forEach(function (pc) {
            const opt = document.createElement('option');
            opt.value = pc.id;
            opt.textContent = (pc.display_name || pc.hostname) + ' (' + pc.store_name + ')';
            select.appendChild(opt);
        });
    }

    document.querySelector('#membersTable').addEventListener('click', async function (e) {
        const removeId = e.target.getAttribute('data-remove');
        if (removeId) {
            await Api.request('DELETE', '/admin/host-groups/' + currentGroupId + '/members/' + removeId);
            await loadMembers();
            await loadGroups(); // счётчик "Участников" в таблице групп тоже должен обновиться
        }
    });

    document.getElementById('addPcBtn').addEventListener('click', async function () {
        const pcId = document.getElementById('addPcSelect').value;
        if (!pcId) return;
        await Api.post('/admin/host-groups/' + currentGroupId + '/members', { pc_id: pcId });
        await loadMembers();
        await loadGroups();
    });

    document.getElementById('createForm').addEventListener('submit', async function (e) {
        e.preventDefault();
        const errorEl = document.getElementById('createError');
        errorEl.textContent = '';
        try {
            await Api.post('/admin/host-groups', { name: document.getElementById('name').value });
            document.getElementById('createForm').reset();
            await loadGroups();
        } catch (err) {
            errorEl.textContent = 'Не удалось создать группу.';
        }
    });

    await loadGroups();
})();
