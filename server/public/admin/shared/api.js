// Тонкая обёртка над fetch: JSON туда, JSON обратно, ошибки — как исключение с кодом
// статуса. Сессионная кука уходит сама (same-origin), явно ничего пробрасывать не нужно.
const Api = {
    async request(method, path, body) {
        const options = {
            method: method,
            headers: { 'Content-Type': 'application/json' },
        };
        if (body !== undefined) {
            options.body = JSON.stringify(body);
        }

        const response = await fetch(path, options);
        const data = await response.json().catch(function () { return {}; });

        if (!response.ok) {
            const error = new Error(data.error || ('http_' + response.status));
            error.status = response.status;
            error.data = data;
            throw error;
        }

        return data;
    },

    get: function (path) {
        return this.request('GET', path);
    },

    post: function (path, body) {
        return this.request('POST', path, body);
    },
};

// Сервер хранит и отдаёт время в UTC (так устроен SQLite). Человеку показываем его
// местное время — браузер знает часовой пояс сам, отдельная настройка для этого не нужна.
function formatServerTime(value) {
    if (!value) return '—';

    // "2026-09-19 01:23:45" -> ISO с явной пометкой UTC, иначе браузер посчитает строку
    // локальным временем и покажет ту же цифру, просто перепутав пояс.
    const parsed = new Date(value.replace(' ', 'T') + 'Z');
    if (isNaN(parsed.getTime())) return value;

    return parsed.toLocaleString();
}

// Вызывать первым делом на каждой защищённой странице: если сессии нет — сразу редирект
// на логин, дальше страница не выполняется.
async function requireAdminAuth() {
    try {
        const me = await Api.get('/admin/me');
        // Боковая панель подставляет имя/роль и прячет разделы не по роли (см. nav.js).
        // const из nav.js не попадает в window — проверяем через typeof.
        if (typeof Nav !== 'undefined') Nav.setUser(me);
        return me;
    } catch (e) {
        // Абсолютный путь: api.js общий для страниц на разной глубине (корень admin/ и
        // подпапки модулей вроде admin/notifications/) — относительный 'login' увёл
        // бы со страницы модуля в несуществующий admin/notifications/login.
        window.location.href = '/admin/login';
        throw e;
    }
}
