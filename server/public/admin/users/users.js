(async function () {
    const me = await requireAdminAuth();

    function $(id) { return document.getElementById(id); }

    function escapeHtml(s) {
        const div = document.createElement('div');
        div.textContent = s == null ? '' : String(s);
        return div.innerHTML;
    }

    const ERRORS = {
        invalid_username: 'логин: только латиница, цифры, точка, дефис, подчёркивание (2–64 символа)',
        invalid_role: 'неверная роль',
        password_too_short: 'пароль короче 8 символов',
        username_taken: 'такой логин уже есть',
        last_superadmin: 'это последний суперадмин — сначала назначьте другого',
        cannot_delete_self: 'себя удалить нельзя',
        wrong_current_password: 'текущий пароль неверный',
        insufficient_role: 'нужна роль суперадмина',
        not_found: 'пользователь не найден',
    };

    function reason(err) {
        const code = (err.data && err.data.error) || err.message;
        return ERRORS[code] || code;
    }

    const roleNames = { operator: 'Оператор', administrator: 'Администратор', superadmin: 'Суперадмин' };

    // Страница целиком — только для суперадмина; остальным сервер отдаст 403 на список,
    // но блок «Мой пароль» им всё равно нужен, поэтому не редиректим, а прячем лишнее.
    const isSuper = me.role === 'superadmin';
    if (!isSuper) {
        document.querySelectorAll('[data-super]').forEach(function (el) { el.hidden = true; });
    }

    async function loadUsers() {
        if (!isSuper) return;
        const users = await Api.get('/admin/users');
        const tbody = document.querySelector('#usersTable tbody');
        tbody.innerHTML = '';

        users.forEach(function (u) {
            const isMe = u.username === me.username;
            let state = '<span class="badge badge-neutral">активен</span>';
            if (u.locked_until) {
                state = '<span class="badge badge-warn">заблокирован до ' + escapeHtml(formatServerTime(u.locked_until)) + '</span>';
            } else if (u.failed_attempts > 0) {
                state = '<span class="badge badge-neutral">неудачных входов: ' + u.failed_attempts + '</span>';
            }

            const roleSelect = '<select data-role-for="' + u.id + '"' + (isMe ? ' disabled title="Свою роль менять нельзя"' : '') + '>' +
                Object.keys(roleNames).map(function (r) {
                    return '<option value="' + r + '"' + (r === u.role ? ' selected' : '') + '>' + roleNames[r] + '</option>';
                }).join('') + '</select>';

            const tr = document.createElement('tr');
            tr.innerHTML =
                '<td><b>' + escapeHtml(u.username) + '</b>' + (isMe ? ' <span class="muted">(это вы)</span>' : '') + '</td>' +
                '<td>' + roleSelect + '</td>' +
                '<td>' + state + '</td>' +
                '<td>' + escapeHtml(formatServerTime(u.created_at)) + '</td>' +
                '<td style="white-space:nowrap">' +
                    '<button type="button" data-reset="' + u.id + '">Сбросить пароль</button> ' +
                    (u.locked_until ? '<button type="button" data-unlock="' + u.id + '">Разблокировать</button> ' : '') +
                    (isMe ? '' : '<button type="button" data-delete="' + u.id + '" data-name="' + escapeHtml(u.username) + '">Удалить</button>') +
                '</td>';
            tbody.appendChild(tr);
        });
    }

    $('createForm').addEventListener('submit', async function (e) {
        e.preventDefault();
        $('createError').textContent = '';
        $('createSuccess').textContent = '';
        try {
            await Api.post('/admin/users', {
                username: $('newUsername').value,
                password: $('newPassword').value,
                role: $('newRole').value,
            });
            $('createSuccess').textContent = 'Пользователь ' + $('newUsername').value + ' создан.';
            $('createForm').reset();
            await loadUsers();
        } catch (err) {
            $('createError').textContent = 'Не удалось создать: ' + reason(err) + '.';
        }
    });

    document.querySelector('#usersTable').addEventListener('change', async function (e) {
        const id = e.target.getAttribute('data-role-for');
        if (!id) return;
        $('tableError').textContent = '';
        try {
            await Api.request('PUT', '/admin/users/' + id, { role: e.target.value });
        } catch (err) {
            $('tableError').textContent = 'Роль не изменена: ' + reason(err) + '.';
        }
        await loadUsers();
    });

    document.querySelector('#usersTable').addEventListener('click', async function (e) {
        const t = e.target;
        $('tableError').textContent = '';
        try {
            if (t.getAttribute('data-reset')) {
                const pwd = await Ui.prompt('Новый пароль', { title: 'Сбросить пароль', type: 'password', okLabel: 'Сбросить',
                    hint: 'Не короче 8 символов. Блокировка после подбора снимется.',
                    validate: function (v) { return v.length >= 8 ? null : 'Не короче 8 символов.'; } });
                if (pwd === null) return;
                await Api.request('PUT', '/admin/users/' + t.getAttribute('data-reset'), { password: pwd });
            } else if (t.getAttribute('data-unlock')) {
                await Api.post('/admin/users/' + t.getAttribute('data-unlock') + '/unlock');
            } else if (t.getAttribute('data-delete')) {
                if (!await Ui.confirm('Удалить пользователя ' + t.getAttribute('data-name') + '? История его команд останется, но без автора.', { danger: true, okLabel: 'Удалить' })) return;
                await Api.request('DELETE', '/admin/users/' + t.getAttribute('data-delete'));
            } else {
                return;
            }
            await loadUsers();
        } catch (err) {
            $('tableError').textContent = 'Не получилось: ' + reason(err) + '.';
        }
    });

    $('ownPasswordForm').addEventListener('submit', async function (e) {
        e.preventDefault();
        $('ownError').textContent = '';
        $('ownSuccess').textContent = '';
        try {
            await Api.post('/admin/me/password', {
                current_password: $('currentPassword').value,
                new_password: $('ownNewPassword').value,
            });
            $('ownSuccess').textContent = 'Пароль изменён.';
            $('ownPasswordForm').reset();
        } catch (err) {
            $('ownError').textContent = 'Пароль не изменён: ' + reason(err) + '.';
        }
    });

    await loadUsers();
})();
