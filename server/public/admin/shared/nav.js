// Боковая панель — одна на все страницы. Рисуется скриптом, а не копируется в каждый
// html: новый раздел добавляется в одном месте, и ни одна страница не отстаёт.
// Пользователь и его роль подставляются из requireAdminAuth() (см. api.js) — по роли
// же скрываются разделы, куда сервер всё равно не пустит (реальная защита — на сервере).
const Nav = (function () {
    const icons = {
        grid: '<svg viewBox="0 0 24 24"><rect x="3" y="3" width="7" height="7" rx="1.5"/><rect x="14" y="3" width="7" height="7" rx="1.5"/><rect x="3" y="14" width="7" height="7" rx="1.5"/><rect x="14" y="14" width="7" height="7" rx="1.5"/></svg>',
        monitor: '<svg viewBox="0 0 24 24"><rect x="3" y="4" width="18" height="12" rx="2"/><path d="M8 20h8M12 16v4"/></svg>',
        bell: '<svg viewBox="0 0 24 24"><path d="M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9"/><path d="M10 21a2 2 0 0 0 4 0"/></svg>',
        layers: '<svg viewBox="0 0 24 24"><path d="m12 3 9 5-9 5-9-5 9-5z"/><path d="m3 13 9 5 9-5"/></svg>',
        book: '<svg viewBox="0 0 24 24"><path d="M4 4.5A2.5 2.5 0 0 1 6.5 2H20v18H6.5A2.5 2.5 0 0 0 4 22z"/><path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20"/></svg>',
        terminal: '<svg viewBox="0 0 24 24"><path d="m5 8 5 4-5 4"/><path d="M12 17h7"/><rect x="2" y="3" width="20" height="18" rx="2.5"/></svg>',
        sliders: '<svg viewBox="0 0 24 24"><path d="M4 6h10M18 6h2M4 12h2M10 12h10M4 18h8M16 18h4"/><circle cx="16" cy="6" r="2"/><circle cx="8" cy="12" r="2"/><circle cx="14" cy="18" r="2"/></svg>',
        users: '<svg viewBox="0 0 24 24"><circle cx="9" cy="8" r="3.5"/><path d="M2.5 20a6.5 6.5 0 0 1 13 0"/><circle cx="17" cy="9" r="2.5"/><path d="M15.5 14.5a5 5 0 0 1 6 4.5"/></svg>',
        store: '<svg viewBox="0 0 24 24"><path d="M3 9.5 5 4h14l2 5.5"/><path d="M3 9.5a3 3 0 0 0 6 0 3 3 0 0 0 6 0 3 3 0 0 0 6 0"/><path d="M5 12v8h14v-8"/><path d="M10 20v-5h4v5"/></svg>',
        scroll: '<svg viewBox="0 0 24 24"><path d="M8 3h11a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a3 3 0 0 1-3-3V6a3 3 0 0 1 3-3h2z"/><path d="M8 3v15a3 3 0 0 1-3 3"/><path d="M11 8h6M11 12h6M11 16h4"/></svg>',
        sun: '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/></svg>',
        key: '<svg viewBox="0 0 24 24"><circle cx="8" cy="15" r="4.5"/><path d="m11.5 11.5 8-8"/><path d="m16 7 2.5 2.5"/><path d="m19 4 2 2"/></svg>',
        logout: '<svg viewBox="0 0 24 24"><path d="M10 4H6a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h4"/><path d="m15 8 4 4-4 4"/><path d="M9 12h10"/></svg>',
    };

    const items = [
        { href: '/admin', label: 'Дашборд', icon: 'grid' },
        { href: '/admin/hosts', label: 'Хосты', icon: 'monitor', match: '/admin/hosts' },
        { href: '/admin/notifications', label: 'Оповещения', icon: 'bell' },
        { href: '/admin/groups', label: 'Группы', icon: 'layers' },
        { href: '/admin/manuals', label: 'Мануалы', icon: 'book' },
        { href: '/admin/commands', label: 'Команды', icon: 'terminal' },
        { href: '/admin/stores', label: 'Справочники', icon: 'store' },
        { href: '/admin/logs', label: 'Логи', icon: 'scroll', roles: ['administrator', 'superadmin'] },
        { href: '/admin/settings', label: 'Настройки', icon: 'sliders' },
        { href: '/admin/users', label: 'Пользователи', icon: 'users', roles: ['superadmin'] },
        { href: '/admin/users', label: 'Мой пароль', icon: 'key', roles: ['operator', 'administrator'] },
    ];

    const roleNames = { operator: 'оператор', administrator: 'администратор', superadmin: 'суперадмин' };

    function render() {
        const host = document.getElementById('sidebar');
        if (!host) return;

        const path = window.location.pathname.replace(/\/$/, '') || '/admin';
        let html = '<a class="brand" href="/admin"><span class="mark">A</span>' +
            '<span><span class="name">AMadmin</span><span class="tag">панель администратора</span></span></a><nav>';
        items.forEach(function (item) {
            // match — префикс для разделов из нескольких страниц (список хостов + профиль).
            const active = path === item.href || (item.match && path.indexOf(item.match) === 0);
            html += '<a href="' + item.href + '" class="' + (active ? 'active' : '') + '"' +
                (item.roles ? ' data-roles="' + item.roles.join(',') + '" style="display:none"' : '') + '>' +
                icons[item.icon] + '<span>' + item.label + '</span></a>';
        });
        html += '</nav><div class="spacer"></div>' +
            '<div class="user"><div class="avatar" id="navAvatar">·</div>' +
            '<div class="who"><b id="navUser">…</b><span id="navRole"></span></div>' +
            '<button type="button" id="themeBtn" title="Сменить тему">' + icons.sun + '</button>' +
            '<button type="button" id="logoutBtn" title="Выйти">' + icons.logout + '</button></div>';
        host.innerHTML = html;

        document.getElementById('themeBtn').addEventListener('click', function () { Ui.toggleTheme(); });
        document.getElementById('logoutBtn').addEventListener('click', async function () {
            try { await Api.post('/admin/logout'); } catch (e) { /* сессии уже нет — всё равно на логин */ }
            window.location.href = '/admin/login';
        });
    }

    function setUser(me) {
        const userEl = document.getElementById('navUser');
        if (!userEl) return;
        userEl.textContent = me.username;
        document.getElementById('navRole').textContent = roleNames[me.role] || me.role;
        document.getElementById('navAvatar').textContent = me.username.slice(0, 2);
        document.querySelectorAll('#sidebar nav a[data-roles]').forEach(function (a) {
            a.style.display = a.getAttribute('data-roles').split(',').indexOf(me.role) >= 0 ? '' : 'none';
        });
    }

    render();
    return { setUser: setUser };
})();
