(async function () {
    await requireAdminAuth();

    document.getElementById('logoutBtn').addEventListener('click', async function () {
        await Api.post('/admin/logout');
        window.location.href = '/admin/login.html';
    });

    async function loadSettings() {
        const settings = await Api.get('/admin/settings');
        document.getElementById('force_mode_default').value = settings.force_mode_default;
        document.getElementById('catchup_missed_default').checked = settings.catchup_missed_default === '1';
        document.getElementById('close_delay_seconds').value = settings.close_delay_seconds;
        document.getElementById('window_size_default').value = settings.window_size_default;
        document.getElementById('brand_name').value = settings.brand_name;
        document.getElementById('brand_contact').value = settings.brand_contact;
    }

    document.getElementById('settingsForm').addEventListener('submit', async function (e) {
        e.preventDefault();
        const errorEl = document.getElementById('error');
        const successEl = document.getElementById('success');
        errorEl.textContent = '';
        successEl.textContent = '';

        const body = {
            force_mode_default: document.getElementById('force_mode_default').value,
            catchup_missed_default: document.getElementById('catchup_missed_default').checked ? '1' : '0',
            close_delay_seconds: document.getElementById('close_delay_seconds').value,
            window_size_default: document.getElementById('window_size_default').value,
            brand_name: document.getElementById('brand_name').value,
            brand_contact: document.getElementById('brand_contact').value,
        };

        try {
            await Api.request('PUT', '/admin/settings', body);
            successEl.textContent = 'Настройки сохранены.';
        } catch (err) {
            errorEl.textContent = 'Не удалось сохранить настройки (нужна роль administrator).';
        }
    });

    await loadSettings();
})();
