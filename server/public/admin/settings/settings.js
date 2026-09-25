(async function () {
    const me = await requireAdminAuth();
    const $ = Ui.$;

    // Ключ в базе -> тип поля. Один список вместо перечисления в двух местах.
    const FIELDS = {
        force_mode_default: 'text', soft_corner: 'text', window_size_default: 'text', max_windows_per_poll: 'text',
        close_delay_seconds: 'text', close_delay_seconds_important: 'text', confirm_close_required: 'bool',
        accidental_tap_guard_ms: 'text', catchup_missed_default: 'bool', timezone: 'text',
        quiet_hours_enabled: 'bool', quiet_hours_from: 'text', quiet_hours_to: 'text', sound_on_important: 'bool',
        brand_name: 'text', brand_contact: 'text', client_lock_enabled: 'bool',
        log_level: 'text', login_max_attempts: 'text', login_lockout_minutes: 'text', session_lifetime_hours: 'text',
    };

    const canEdit = me.role === 'administrator' || me.role === 'superadmin';
    if (me.role === 'superadmin') $('serverTab').hidden = false;
    if (!canEdit) {
        $('saveBar').hidden = true;
        document.querySelectorAll('#settingsForm input, #settingsForm select').forEach(function (el) { el.disabled = true; });
    }

    let activeTab = 'notifications';
    document.querySelectorAll('.tabs button').forEach(function (b) {
        b.addEventListener('click', function () {
            activeTab = b.dataset.tab;
            document.querySelectorAll('.tabs button').forEach(function (x) { x.classList.toggle('active', x === b); });
            document.querySelectorAll('.tab-panel').forEach(function (p) { p.hidden = p.dataset.panel !== activeTab; });
        });
    });

    async function loadSettings() {
        const settings = await Api.get('/admin/settings');
        Object.keys(FIELDS).forEach(function (key) {
            const el = $(key);
            if (!el || settings[key] === undefined) return;
            if (FIELDS[key] === 'bool') el.checked = settings[key] === '1';
            else el.value = settings[key];
        });
    }

    $('settingsForm').addEventListener('submit', async function (e) {
        e.preventDefault();
        // Только поля открытой вкладки: оператор с ролью administrator не должен случайно
        // отправить серверные ключи и получить 403 на всё сразу.
        const panel = document.querySelector('.tab-panel[data-panel="' + activeTab + '"]');
        const body = {};
        Object.keys(FIELDS).forEach(function (key) {
            const el = $(key);
            if (!el || !panel.contains(el)) return;
            body[key] = FIELDS[key] === 'bool' ? (el.checked ? '1' : '0') : el.value;
        });
        // client_lock_password — не обычное поле settings (сервер хранит только его хеш,
        // см. AdminSettingsController::update), поэтому его нет в FIELDS. Шлём, только если
        // реально ввели новый пароль — пустое значит «не менять».
        const pwEl = $('client_lock_password');
        if (pwEl && panel.contains(pwEl) && pwEl.value) body.client_lock_password = pwEl.value;
        try {
            await Api.request('PUT', '/admin/settings', body);
            if (pwEl) pwEl.value = '';
            Ui.toast(activeTab === 'server' ? 'Настройки сервера сохранены' : 'Сохранено — кассы подхватят при следующем опросе', 'success');
        } catch (err) {
            Ui.toast('Не удалось сохранить: ' + Ui.reason(err, {
                server_settings_require_superadmin: 'настройки сервера может менять только суперадмин',
                invalid_log_level: 'неверный уровень логирования',
            }), 'error');
        }
    });

    await loadSettings();
})();
