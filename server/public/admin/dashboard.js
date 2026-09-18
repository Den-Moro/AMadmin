(async function () {
    const me = await requireAdminAuth();

    document.getElementById('roleLabel').textContent = me.username + ' (' + me.role + ')';

    document.getElementById('logoutBtn').addEventListener('click', async function () {
        await Api.post('/admin/logout');
        window.location.href = '/admin/login.html';
    });

    const searchEl = document.getElementById('search');
    const storeEl = document.getElementById('storeFilter');
    const deviceTypeEl = document.getElementById('deviceTypeFilter');
    const pcStoreIdEl = document.getElementById('pcStoreId');
    const pcDeviceTypeIdEl = document.getElementById('pcDeviceTypeId');
    const tbody = document.querySelector('#pcsTable tbody');

    function debounce(fn, ms) {
        let t;
        return function () {
            const args = arguments;
            clearTimeout(t);
            t = setTimeout(function () { fn.apply(null, args); }, ms);
        };
    }

    async function loadFilters() {
        const stores = await Api.get('/admin/stores');
        const deviceTypes = await Api.get('/admin/device-types');

        stores.forEach(function (store) {
            const label = store.name + (store.is_pilot ? ' (пилот)' : '');

            const filterOpt = document.createElement('option');
            filterOpt.value = store.id;
            filterOpt.textContent = label;
            storeEl.appendChild(filterOpt);

            const formOpt = document.createElement('option');
            formOpt.value = store.id;
            formOpt.textContent = label;
            pcStoreIdEl.appendChild(formOpt);
        });

        deviceTypes.forEach(function (dt) {
            const filterOpt = document.createElement('option');
            filterOpt.value = dt.id;
            filterOpt.textContent = dt.name;
            deviceTypeEl.appendChild(filterOpt);

            const formOpt = document.createElement('option');
            formOpt.value = dt.id;
            formOpt.textContent = dt.name;
            pcDeviceTypeIdEl.appendChild(formOpt);
        });
    }

    function formatLastSeen(value) {
        if (!value) {
            return 'никогда';
        }
        return value;
    }

    function escapeHtml(s) {
        const div = document.createElement('div');
        div.textContent = s == null ? '' : String(s);
        return div.innerHTML;
    }

    // Готовый config.json для конкретного ПК — server_url берём из адреса, по которому
    // сейчас открыта сама панель (это и есть реально работающий адрес сервера с точки
    // зрения браузера), а не пытаемся угадывать его на сервере.
    function buildConfigText(token) {
        const config = {
            server_url: window.location.origin,
            agent_token: token,
            poll_interval_seconds: 30,
            log_level: 'debug',
        };
        return JSON.stringify(config, null, 4);
    }

    function showConfig(token) {
        document.getElementById('newPcConfig').style.display = '';
        document.getElementById('newPcConfigText').value = buildConfigText(token);
        document.getElementById('newPcConfig').scrollIntoView({ behavior: 'smooth' });
    }

    document.getElementById('copyConfigBtn').addEventListener('click', function () {
        const textarea = document.getElementById('newPcConfigText');
        textarea.select();
        navigator.clipboard.writeText(textarea.value).catch(function () {
            document.execCommand('copy');
        });
    });

    document.getElementById('createPcForm').addEventListener('submit', async function (e) {
        e.preventDefault();
        const errorEl = document.getElementById('createPcError');
        errorEl.textContent = '';

        const body = {
            store_id: pcStoreIdEl.value,
            device_type_id: pcDeviceTypeIdEl.value,
            hostname: document.getElementById('pcHostname').value,
            display_name: document.getElementById('pcDisplayName').value,
        };

        try {
            const result = await Api.post('/admin/pcs', body);
            document.getElementById('createPcForm').reset();
            showConfig(result.agent_token);
            await loadPcs();
        } catch (err) {
            errorEl.textContent = 'Не удалось создать ПК — проверьте, что все поля заполнены.';
        }
    });

    async function loadPcs() {
        const params = new URLSearchParams();
        if (searchEl.value) params.set('search', searchEl.value);
        if (storeEl.value) params.set('store_id', storeEl.value);
        if (deviceTypeEl.value) params.set('device_type_id', deviceTypeEl.value);

        const pcs = await Api.get('/admin/pcs?' + params.toString());

        tbody.innerHTML = '';
        pcs.forEach(function (pc) {
            const hostUser = pc.display_name
                ? escapeHtml(pc.display_name) + ' <span class="muted">(' + escapeHtml(pc.hostname) + ')</span>'
                : escapeHtml(pc.hostname);
            const userSuffix = pc.username ? '\\' + escapeHtml(pc.username) : '';

            const tr = document.createElement('tr');
            tr.innerHTML =
                '<td><span class="badge ' + (pc.online ? 'badge-online' : 'badge-offline') + '">' +
                (pc.online ? 'онлайн' : 'офлайн') + '</span></td>' +
                '<td>' + escapeHtml(pc.store_name) + '</td>' +
                '<td>' + hostUser + userSuffix + '</td>' +
                '<td>' + escapeHtml(pc.device_type_name) + '</td>' +
                '<td>' + escapeHtml(pc.agent_version || '—') + '</td>' +
                '<td>' + escapeHtml(formatLastSeen(pc.last_seen)) + '</td>' +
                '<td><button type="button" data-token="' + escapeHtml(pc.agent_token) + '">Показать конфиг</button></td>';
            tbody.appendChild(tr);
        });
    }

    tbody.addEventListener('click', function (e) {
        const token = e.target.getAttribute('data-token');
        if (token) {
            showConfig(token);
        }
    });

    searchEl.addEventListener('input', debounce(loadPcs, 300));
    storeEl.addEventListener('change', loadPcs);
    deviceTypeEl.addEventListener('change', loadPcs);

    await loadFilters();
    await loadPcs();
})();
