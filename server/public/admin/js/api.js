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

// Вызывать первым делом на каждой защищённой странице: если сессии нет — сразу редирект
// на логин, дальше страница не выполняется.
async function requireAdminAuth() {
    try {
        return await Api.get('/admin/me');
    } catch (e) {
        window.location.href = 'login.html';
        throw e;
    }
}
