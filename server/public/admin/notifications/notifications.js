(async function () {
    await requireAdminAuth();


    const targetTypeEl = document.getElementById('targetType');
    const targetIdWrap = document.getElementById('targetIdWrap');
    const targetIdEl = document.getElementById('targetId');

    const optionsCache = {};

    function escapeHtml(s) {
        const div = document.createElement('div');
        div.textContent = s == null ? '' : String(s);
        return div.innerHTML;
    }

    function optionLabel(item) {
        return item.name || item.display_name || item.hostname;
    }

    async function loadTargetOptions(type) {
        if (type === 'all') {
            targetIdWrap.style.display = 'none';
            return;
        }

        targetIdWrap.style.display = '';
        targetIdEl.innerHTML = '<option value="">Загрузка…</option>';

        if (!optionsCache[type]) {
            const endpoints = {
                store: '/admin/stores',
                group: '/admin/host-groups',
                device_type: '/admin/device-types',
                pc: '/admin/pcs',
            };
            optionsCache[type] = await Api.get(endpoints[type]);
        }

        targetIdEl.innerHTML = '';
        optionsCache[type].forEach(function (item) {
            const opt = document.createElement('option');
            opt.value = item.id;
            opt.textContent = optionLabel(item);
            targetIdEl.appendChild(opt);
        });
    }

    targetTypeEl.addEventListener('change', function () {
        loadTargetOptions(targetTypeEl.value);
    });

    const manualPickerEl = document.getElementById('manualPicker');
    let manuals = [];

    async function loadManualPicker() {
        manuals = await Api.get('/admin/manuals');
        manuals.forEach(function (m) {
            const opt = document.createElement('option');
            opt.value = m.id;
            opt.textContent = m.title;
            manualPickerEl.appendChild(opt);
        });
    }

    // Выбор мануала из библиотеки копирует его текст в поле — не хранит ссылку на
    // mануал (при правке мануала в библиотеке уже отправленные оповещения не меняются
    // задним числом, см. пояснение в миграции у notifications.manual_url).
    manualPickerEl.addEventListener('change', function () {
        const picked = manuals.find(function (m) { return String(m.id) === manualPickerEl.value; });
        if (picked) {
            document.getElementById('manualUrl').value = picked.url_or_text;
        }
    });

    document.getElementById('createForm').addEventListener('submit', async function (e) {
        e.preventDefault();
        const errorEl = document.getElementById('error');
        const successEl = document.getElementById('success');
        errorEl.textContent = '';
        successEl.textContent = '';

        const targetType = targetTypeEl.value;
        const body = {
            text: document.getElementById('text').value,
            priority: document.getElementById('priority').value,
            size: document.getElementById('size').value,
            manual_url: document.getElementById('manualUrl').value,
            target: {
                type: targetType,
                id: targetType === 'all' ? null : targetIdEl.value,
            },
        };

        try {
            await Api.post('/admin/notifications', body);
            successEl.textContent = 'Оповещение отправлено.';
            document.getElementById('createForm').reset();
            targetIdWrap.style.display = 'none';
            await loadNotifications();
        } catch (err) {
            const reason = (err.data && err.data.error) || err.message;
            errorEl.textContent = 'Не удалось создать оповещение (' + reason + ').';
        }
    });

    async function loadNotifications() {
        const rows = await Api.get('/admin/notifications');
        const tbody = document.querySelector('#notificationsTable tbody');
        tbody.innerHTML = '';
        rows.forEach(function (n) {
            const tr = document.createElement('tr');
            tr.innerHTML =
                '<td>' + escapeHtml(formatServerTime(n.created_at)) + '</td>' +
                '<td>' + escapeHtml(n.text) + '</td>' +
                '<td>' + (n.priority === 'important' ? 'Важное' : 'Неважное') + '</td>' +
                '<td>' + n.occurrences_count + '</td>' +
                '<td>' + n.acks_count + '</td>';
            tbody.appendChild(tr);
        });
    }

    await loadNotifications();
    await loadManualPicker();
})();
