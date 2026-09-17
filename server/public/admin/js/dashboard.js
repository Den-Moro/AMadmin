(async function () {
    await requireAdminAuth();

    document.getElementById('logoutBtn').addEventListener('click', async function () {
        await Api.post('/admin/logout');
        window.location.href = 'login.html';
    });

    const searchEl = document.getElementById('search');
    const storeEl = document.getElementById('storeFilter');
    const deviceTypeEl = document.getElementById('deviceTypeFilter');
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
            const opt = document.createElement('option');
            opt.value = store.id;
            opt.textContent = store.name + (store.is_pilot ? ' (пилот)' : '');
            storeEl.appendChild(opt);
        });

        deviceTypes.forEach(function (dt) {
            const opt = document.createElement('option');
            opt.value = dt.id;
            opt.textContent = dt.name;
            deviceTypeEl.appendChild(opt);
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
                '<td>' + escapeHtml(formatLastSeen(pc.last_seen)) + '</td>';
            tbody.appendChild(tr);
        });
    }

    searchEl.addEventListener('input', debounce(loadPcs, 300));
    storeEl.addEventListener('change', loadPcs);
    deviceTypeEl.addEventListener('change', loadPcs);

    await loadFilters();
    await loadPcs();
})();
