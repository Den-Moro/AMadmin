// Общие элементы интерфейса: тосты, модальные окна (подтверждение / ввод / форма),
// тема, мелкие помощники. Без библиотек — чтобы панель разворачивалась копированием
// папки и работала в интранете без интернета.
const Ui = (function () {
    function $(id) { return document.getElementById(id); }

    function escapeHtml(s) {
        const div = document.createElement('div');
        div.textContent = s == null ? '' : String(s);
        return div.innerHTML;
    }

    function formatSize(bytes) {
        if (bytes < 1024) return bytes + ' Б';
        if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' КБ';
        return (bytes / 1024 / 1024).toFixed(1) + ' МБ';
    }

    // ---- Тосты: короткие сообщения в углу, сами исчезают ----------------------------

    function toast(text, type) {
        let host = $('toasts');
        if (!host) {
            host = document.createElement('div');
            host.id = 'toasts';
            document.body.appendChild(host);
        }
        const el = document.createElement('div');
        el.className = 'toast toast-' + (type || 'info');
        el.textContent = text;
        host.appendChild(el);
        requestAnimationFrame(function () { el.classList.add('show'); });
        setTimeout(function () {
            el.classList.remove('show');
            setTimeout(function () { el.remove(); }, 250);
        }, type === 'error' ? 6000 : 3500);
    }

    // Код ошибки сервера -> человеческий текст. Общий словарь + словарь страницы.
    const COMMON_ERRORS = {
        auth_required: 'сессия истекла — войдите заново',
        insufficient_role: 'недостаточно прав для этого действия',
        not_found: 'запись не найдена (возможно, уже удалена)',
        has_pcs: 'сначала переведите или удалите ПК, которые сюда привязаны',
        name_required: 'укажите название',
        nothing_to_update: 'нечего сохранять',
        internal_error: 'ошибка сервера — подробности в логе сервера',
    };

    function reason(err, dict) {
        const code = (err && err.data && err.data.error) || (err && err.message) || 'unknown';
        return (dict && dict[code]) || COMMON_ERRORS[code] || code;
    }

    // ---- Модальные окна ---------------------------------------------------------------

    // Открывает окно и возвращает Promise. Разрешается значением кнопки (value) или
    // результатом onSubmit; закрытие по Esc/фону — null.
    //   { title, body (html), buttons: [{label, value, kind:'primary'|'danger'|''}], onSubmit(root) }
    function modal(opts) {
        return new Promise(function (resolve) {
            const back = document.createElement('div');
            back.className = 'modal-back';
            back.innerHTML =
                '<div class="modal" role="dialog" aria-modal="true">' +
                '<div class="modal-head"><h3>' + escapeHtml(opts.title || '') + '</h3>' +
                '<button type="button" class="modal-x" aria-label="Закрыть">×</button></div>' +
                '<div class="modal-body">' + (opts.body || '') + '</div>' +
                '<div class="modal-foot"></div></div>';
            const foot = back.querySelector('.modal-foot');
            const root = back.querySelector('.modal');

            function close(value) {
                document.removeEventListener('keydown', onKey);
                back.classList.remove('show');
                setTimeout(function () { back.remove(); }, 180);
                resolve(value);
            }
            function onKey(e) {
                if (e.key === 'Escape') close(null);
                if (e.key === 'Enter' && opts.submitOnEnter !== false && e.target.tagName !== 'TEXTAREA') {
                    const primary = foot.querySelector('button.primary');
                    if (primary) { e.preventDefault(); primary.click(); }
                }
            }

            (opts.buttons || [{ label: 'Закрыть', value: null }]).forEach(function (b) {
                const btn = document.createElement('button');
                btn.type = 'button';
                btn.textContent = b.label;
                btn.className = b.kind || '';
                btn.addEventListener('click', async function () {
                    if (b.value === 'submit' && opts.onSubmit) {
                        btn.disabled = true;
                        try {
                            const result = await opts.onSubmit(root);
                            if (result === false) { btn.disabled = false; return; } // остаться открытым
                            close(result === undefined ? true : result);
                        } catch (err) {
                            btn.disabled = false;
                            const errEl = root.querySelector('.modal-error');
                            if (errEl) errEl.textContent = reason(err, opts.errors);
                            else toast(reason(err, opts.errors), 'error');
                        }
                        return;
                    }
                    close(b.value);
                });
                foot.appendChild(btn);
            });

            back.querySelector('.modal-x').addEventListener('click', function () { close(null); });
            back.addEventListener('mousedown', function (e) { if (e.target === back) close(null); });
            document.addEventListener('keydown', onKey);

            document.body.appendChild(back);
            requestAnimationFrame(function () {
                back.classList.add('show');
                const first = root.querySelector('input, select, textarea');
                if (first) first.focus();
            });
        });
    }

    function confirm(text, opts) {
        opts = opts || {};
        return modal({
            title: opts.title || 'Подтвердите',
            body: '<p>' + escapeHtml(text) + '</p>',
            buttons: [
                { label: 'Отмена', value: false },
                { label: opts.okLabel || 'Да', value: true, kind: opts.danger ? 'danger' : 'primary' },
            ],
        }).then(function (v) { return v === true; });
    }

    function prompt(label, opts) {
        opts = opts || {};
        return modal({
            title: opts.title || label,
            body: '<label>' + escapeHtml(label) +
                (opts.hint ? '<span class="hint">' + escapeHtml(opts.hint) + '</span>' : '') +
                '<input type="' + (opts.type || 'text') + '" id="promptValue" value="' + escapeHtml(opts.value || '') + '"></label>' +
                '<p class="error modal-error"></p>',
            buttons: [
                { label: 'Отмена', value: null },
                { label: opts.okLabel || 'OK', value: 'submit', kind: 'primary' },
            ],
            onSubmit: function (root) {
                const v = root.querySelector('#promptValue').value;
                if (opts.validate) {
                    const msg = opts.validate(v);
                    if (msg) { root.querySelector('.modal-error').textContent = msg; return false; }
                }
                return v;
            },
        });
    }

    // ---- Выпадающее меню действий у строки таблицы -------------------------------------

    // Показывает меню под кнопкой; разрешается значением выбранного пункта или null.
    //   items: [{label, value, danger}]
    function menu(anchor, items) {
        return new Promise(function (resolve) {
            document.querySelectorAll('.menu').forEach(function (m) { m.remove(); });
            const el = document.createElement('div');
            el.className = 'menu';
            el.innerHTML = items.map(function (it) {
                return '<button type="button" class="' + (it.danger ? 'danger' : '') + '" data-value="' + escapeHtml(it.value) + '">' + escapeHtml(it.label) + '</button>';
            }).join('');
            document.body.appendChild(el);

            const r = anchor.getBoundingClientRect();
            el.style.top = (window.scrollY + r.bottom + 4) + 'px';
            el.style.left = Math.max(8, window.scrollX + r.right - el.offsetWidth) + 'px';

            function close(value) {
                el.remove();
                document.removeEventListener('mousedown', onOutside, true);
                document.removeEventListener('keydown', onKey);
                resolve(value);
            }
            function onOutside(e) { if (!el.contains(e.target)) close(null); }
            function onKey(e) { if (e.key === 'Escape') close(null); }

            el.addEventListener('click', function (e) {
                const b = e.target.closest('button[data-value]');
                if (b) close(b.getAttribute('data-value'));
            });
            setTimeout(function () {
                document.addEventListener('mousedown', onOutside, true);
                document.addEventListener('keydown', onKey);
            }, 0);
        });
    }

    // ---- Тема ---------------------------------------------------------------------------

    function applyTheme(theme) {
        document.documentElement.setAttribute('data-theme', theme);
        try { localStorage.setItem('amadmin-theme', theme); } catch (e) { /* приватный режим */ }
        const btn = $('themeBtn');
        if (btn) btn.title = theme === 'dark' ? 'Светлая тема' : 'Тёмная тема';
    }

    function initTheme() {
        let theme = 'dark';
        try { theme = localStorage.getItem('amadmin-theme') || 'dark'; } catch (e) { /* — */ }
        document.documentElement.setAttribute('data-theme', theme);
    }

    function toggleTheme() {
        applyTheme(document.documentElement.getAttribute('data-theme') === 'dark' ? 'light' : 'dark');
    }

    // ---- Раскрывающиеся строки таблиц ----------------------------------------------------

    // Вставляет под строкой tr строку-деталь с html (или убирает, если уже открыта).
    function toggleDetail(tr, html, colspan) {
        const next = tr.nextElementSibling;
        if (next && next.classList.contains('detail-row')) {
            next.remove();
            tr.classList.remove('open');
            return null;
        }
        const row = document.createElement('tr');
        row.className = 'detail-row';
        row.innerHTML = '<td colspan="' + colspan + '"><div class="detail">' + html + '</div></td>';
        tr.after(row);
        tr.classList.add('open');
        return row;
    }

    initTheme();

    return {
        $: $, escapeHtml: escapeHtml, formatSize: formatSize, toast: toast, reason: reason,
        modal: modal, confirm: confirm, prompt: prompt, menu: menu, toggleTheme: toggleTheme, toggleDetail: toggleDetail,
    };
})();
