(async function () {
    await requireAdminAuth();

    document.getElementById('logoutBtn').addEventListener('click', async function () {
        await Api.post('/admin/logout');
        window.location.href = '/admin/login.html';
    });

    // Все поля настроек: имя ключа в базе -> тип поля. Один список вместо ручного
    // перечисления в двух местах, чтобы добавление новой настройки не требовало
    // править загрузку и сохранение по отдельности.
    const FIELDS = {
        force_mode_default: 'text',
        soft_corner: 'text',
        window_size_default: 'text',
        max_windows_per_poll: 'text',
        close_delay_seconds: 'text',
        close_delay_seconds_important: 'text',
        confirm_close_required: 'bool',
        accidental_tap_guard_ms: 'text',
        catchup_missed_default: 'bool',
        timezone: 'text',
        quiet_hours_enabled: 'bool',
        quiet_hours_from: 'text',
        quiet_hours_to: 'text',
        sound_on_important: 'bool',
        brand_name: 'text',
        brand_contact: 'text',
    };

    async function loadSettings() {
        const settings = await Api.get('/admin/settings');

        Object.keys(FIELDS).forEach(function (key) {
            const el = document.getElementById(key);
            if (!el || settings[key] === undefined) return;

            if (FIELDS[key] === 'bool') {
                el.checked = settings[key] === '1';
            } else {
                el.value = settings[key];
            }
        });
    }

    document.getElementById('settingsForm').addEventListener('submit', async function (e) {
        e.preventDefault();
        const errorEl = document.getElementById('error');
        const successEl = document.getElementById('success');
        errorEl.textContent = '';
        successEl.textContent = '';

        const body = {};
        Object.keys(FIELDS).forEach(function (key) {
            const el = document.getElementById(key);
            if (!el) return;
            body[key] = FIELDS[key] === 'bool' ? (el.checked ? '1' : '0') : el.value;
        });

        try {
            await Api.request('PUT', '/admin/settings', body);
            successEl.textContent = 'Настройки сохранены — кассы подхватят их при следующем опросе.';
        } catch (err) {
            errorEl.textContent = 'Не удалось сохранить настройки (нужна роль administrator).';
        }
    });

    await loadSettings();
})();
