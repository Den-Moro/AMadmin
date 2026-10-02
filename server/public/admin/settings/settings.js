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
            if (activeTab === 'client') loadClientRollout();
        });
    });

    let passwordSet = false;

    async function loadSettings() {
        const settings = await Api.get('/admin/settings');
        Object.keys(FIELDS).forEach(function (key) {
            const el = $(key);
            if (!el || settings[key] === undefined) return;
            if (FIELDS[key] === 'bool') el.checked = settings[key] === '1';
            else el.value = settings[key];
        });
        passwordSet = !!settings.client_lock_password_set;
        updateNoPasswordNote();
    }

    // Включённая защита без пароля на кассе ничего не закрывает — предупреждаем сразу.
    function updateNoPasswordNote() {
        $('clientLockNoPassword').hidden = !($('client_lock_enabled').checked && !passwordSet && !$('client_lock_password').value);
    }
    $('client_lock_enabled').addEventListener('change', updateNoPasswordNote);
    $('client_lock_password').addEventListener('input', updateNoPasswordNote);

    // ---- Применено на кассах ------------------------------------------------------------
    // Касса сообщает, какие настройки агента у неё уже действуют; пока кто-то на связи
    // их ещё не применил, обновляем часто — смену пароля видно в течение одного опроса.

    const ROLLOUT_REASONS = {
        waiting: '<span class="badge badge-online">на связи</span> применит на ближайшем опросе',
        offline: '<span class="badge badge-offline">не на связи</span> применит, когда выйдет на связь',
        no_ui: 'окно оповещений не запускалось (в Windows ещё никто не входил)',
        old_agent: 'агент старой версии не сообщает о применении — обновите агента',
    };
    let rolloutHasWaiting = false;

    async function loadClientRollout() {
        let st;
        try { st = await Api.get('/admin/agent-config/status'); } catch (e) { return; }
        rolloutHasWaiting = st.pending.some(function (p) { return p.reason === 'waiting'; });
        const head = st.total === 0 ? 'Касс пока нет.'
            : st.applied === st.total ? 'Все ' + st.total + ' касс(ы) уже работают с текущими настройками.'
            : 'Текущие настройки действуют на <strong>' + st.applied + ' из ' + st.total + '</strong> касс' +
              (rolloutHasWaiting ? ' — обновляется само.' : '.');
        const shown = st.pending.slice(0, 50);
        $('clientRollout').innerHTML = '<p style="margin-top:0">' + head + '</p>' + (shown.length
            ? '<table><thead><tr><th>Магазин</th><th>Хост</th><th>Состояние</th></tr></thead><tbody>' +
                shown.map(function (p) {
                    return '<tr><td>' + Ui.escapeHtml(p.store_name) + '</td>' +
                        '<td><a class="host-link" href="/admin/hosts/host?id=' + p.id + '">' + Ui.escapeHtml(p.display_name || p.hostname) + '</a></td>' +
                        '<td>' + (ROLLOUT_REASONS[p.reason] || '') + '</td></tr>';
                }).join('') + '</tbody></table>' +
                (st.pending.length > shown.length ? '<p class="muted">и ещё ' + (st.pending.length - shown.length) + '</p>' : '')
            : '');
    }

    let lastRollout = 0;
    setInterval(function () {
        if (document.hidden || activeTab !== 'client') return;
        if (rolloutHasWaiting || Date.now() - lastRollout >= 30000) { lastRollout = Date.now(); loadClientRollout(); }
    }, 5000);

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
            if (activeTab === 'client') {
                await loadSettings();
                await loadClientRollout();
                Ui.toast('Сохранено — ход применения на кассах виден ниже', 'success');
            } else {
                Ui.toast(activeTab === 'server' ? 'Настройки сервера сохранены' : 'Сохранено — кассы подхватят при следующем опросе', 'success');
            }
        } catch (err) {
            Ui.toast('Не удалось сохранить: ' + Ui.reason(err, {
                server_settings_require_superadmin: 'настройки сервера может менять только суперадмин',
                invalid_log_level: 'неверный уровень логирования',
            }), 'error');
        }
    });

    await loadSettings();
})();
