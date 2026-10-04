// Боковая панель — одна на все страницы. Рисуется скриптом, а не копируется в каждый
// html: новый раздел добавляется в одном месте, и ни одна страница не отстаёт.
// Пользователь и его роль подставляются из requireAdminAuth() (см. api.js) — по роли
// же скрываются разделы, куда сервер всё равно не пустит (реальная защита — на сервере).
const Nav = (function () {
    // Разделы сгруппированы по задачам: что смотрим, что сообщаем, чем управляем, система.
    const sections = [
        { title: 'Парк', items: [
            { href: '/admin', label: 'Дашборд', icon: 'grid', tip: 'Сводка: сколько касс на связи, что требует внимания' },
            { href: '/admin/hosts', label: 'Хосты', icon: 'monitor', match: '/admin/hosts', tip: 'Все кассы и ПК: поиск, фильтры, профиль каждого хоста' },
            { href: '/admin/groups', label: 'Группы', icon: 'layers', tip: 'Свои наборы хостов («Кассы 1 этажа», «Проблемные») — цель для оповещений и команд' },
        ] },
        { title: 'Оповещения', items: [
            { href: '/admin/notifications', label: 'Оповещения', icon: 'bell', tip: 'Сообщения кассирам о работах: создать, отправить, кто увидел' },
            { href: '/admin/manuals', label: 'Мануалы', icon: 'book', tip: 'Инструкции, которые прикладываются к оповещениям' },
        ] },
        { title: 'Управление', items: [
            { href: '/admin/commands', label: 'Команды', icon: 'terminal', tip: 'Службы, процессы и скрипты на кассах — и результат с каждой' },
            { href: '/admin/files', label: 'Файлы', icon: 'folder', tip: 'Загрузить файл и разложить его по кассам в нужную папку' },
            { href: '/admin/updates', label: 'Обновления', icon: 'download', roles: ['administrator', 'superadmin'], tip: 'Новая версия агента на выбранные кассы' },
        ] },
        { title: 'Система', items: [
            { href: '/admin/stores', label: 'Справочники', icon: 'store', tip: 'Магазины, типы устройств, шаблоны сообщений' },
            { href: '/admin/settings', label: 'Настройки', icon: 'sliders', tip: 'Поведение окна оповещений, пароль клиента, брендинг' },
            { href: '/admin/logs', label: 'Логи', icon: 'scroll', roles: ['administrator', 'superadmin'], tip: 'Журнал сервера: запросы, ошибки, кто что отправил' },
            { href: '/admin/users', label: 'Пользователи', icon: 'users', roles: ['superadmin'], tip: 'Учётки панели и их роли' },
            { href: '/admin/users', label: 'Мой пароль', icon: 'key', roles: ['operator', 'administrator'], tip: 'Сменить свой пароль входа в панель' },
        ] },
    ];

    const roleNames = { operator: 'оператор', administrator: 'администратор', superadmin: 'суперадмин' };

    function render() {
        const host = document.getElementById('sidebar');
        if (!host) return;

        const path = window.location.pathname.replace(/\/$/, '') || '/admin';
        let html = '<a class="brand" href="/admin"><span class="mark">A</span>' +
            '<span><span class="name">AMadmin</span><span class="tag">панель администратора</span></span></a><nav>';
        sections.forEach(function (section) {
            html += '<div class="nav-section"><span class="nav-title">' + section.title + '</span>';
            section.items.forEach(function (item) {
                // match — префикс для разделов из нескольких страниц (список хостов + профиль).
                const active = path === item.href || (item.match && path.indexOf(item.match) === 0);
                html += '<a href="' + item.href + '" class="' + (active ? 'active' : '') + '" data-tip="' + Ui.escapeHtml(item.tip) + '" data-tip-side="right"' +
                    (item.roles ? ' data-roles="' + item.roles.join(',') + '" style="display:none"' : '') + '>' +
                    Ui.icon(item.icon) + '<span>' + item.label + '</span></a>';
            });
            html += '</div>';
        });
        html += '</nav><div class="spacer"></div>' +
            '<div class="user"><div class="avatar" id="navAvatar">·</div>' +
            '<div class="who"><b id="navUser">…</b><span id="navRole"></span></div>' +
            '<button type="button" id="themeBtn" title="Сменить тему">' + Ui.icon('sun') + '</button>' +
            '<button type="button" id="logoutBtn" title="Выйти из панели">' + Ui.icon('logout') + '</button></div>';
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
