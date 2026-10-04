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
        if (bytes < 1024 * 1024 * 1024) return (bytes / 1024 / 1024).toFixed(1) + ' МБ';
        return (bytes / 1024 / 1024 / 1024).toFixed(1) + ' ГБ';
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
    //   { title, body (html), buttons: [{label, value, kind:'primary'|'danger'|''}], onSubmit(root), wide }
    function modal(opts) {
        return new Promise(function (resolve) {
            const back = document.createElement('div');
            back.className = 'modal-back';
            back.innerHTML =
                '<div class="modal' + (opts.wide ? ' wide' : '') + '" role="dialog" aria-modal="true">' +
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
            enhanceHints(root);
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

    // ---- Сортировка таблиц по клику на заголовок -----------------------------------------

    // Вешает обработчики на все th.sortable[data-sort] внутри container. При клике меняет
    // sort.key/sort.dir (тот же объект, что возвращён — страница читает его в своей
    // функции рендера) и красит стрелку (.asc/.desc), затем вызывает onSort(). Сам не
    // перерисовывает таблицу — так каждая страница остаётся владельцем своих данных и
    // прочих клиентских фильтров (как уже было в hosts.js, только без copy-paste).
    function makeSortable(container, initial, onSort) {
        const sort = { key: initial.key, dir: initial.dir };
        const ths = container.querySelectorAll('th.sortable');
        ths.forEach(function (th) {
            if (th.dataset.sort === sort.key) th.classList.add(sort.dir);
            th.addEventListener('click', function () {
                if (sort.key === th.dataset.sort) sort.dir = sort.dir === 'asc' ? 'desc' : 'asc';
                else { sort.key = th.dataset.sort; sort.dir = 'asc'; }
                ths.forEach(function (x) { x.classList.remove('asc', 'desc'); });
                th.classList.add(sort.dir);
                onSort();
            });
        });
        return sort;
    }

    // Сравнение двух строк по sort.key/sort.dir — null-ы в конец, строки через localeCompare,
    // числа/даты вычитанием. opts.map(row) — если значение для сравнения не лежит прямо в
    // row[key] (например булево online -> 0/1, как в hosts.js).
    function compareBy(a, b, sort, opts) {
        opts = opts || {};
        const x = opts.map ? opts.map(a) : a[sort.key];
        const y = opts.map ? opts.map(b) : b[sort.key];
        const d = sort.dir === 'asc' ? 1 : -1;
        if (x == null) return 1;
        if (y == null) return -1;
        if (typeof x === 'string') return x.localeCompare(y) * d;
        return (x - y) * d;
    }

    // ---- Поиск/фильтр списка хостов — используется везде, где раньше был голый <select>
    // со всеми ПК (командам/оповещениям — кого выбрать; группам — кого добавить). ------------

    // pcs: [{id, hostname, display_name, store_name, last_ip, ...}]. Возвращает подпись
    // "имя · магазин · ip" — IP виден сразу, без отдельного похода в профиль хоста.
    function pcLabel(pc) {
        const name = pc.display_name || pc.hostname;
        const bits = [name];
        if (pc.store_name) bits.push(pc.store_name);
        if (pc.last_ip) bits.push(pc.last_ip);
        return bits.join(' · ');
    }

    function pcMatches(pc, q) {
        if (!q) return true;
        q = q.toLowerCase();
        return [pc.hostname, pc.display_name, pc.store_name, pc.last_ip].some(function (v) {
            return v && String(v).toLowerCase().indexOf(q) !== -1;
        });
    }

    // Заменяет обычный <select multiple=false> живым текстовым поиском + списком: строит
    // разметку внутри container (должен быть пустым div), фильтрует pcs клиентски (наборы
    // тут не тысячи строк — отдельный API для поиска не нужен). onChange(pc|null).
    function pcPicker(container, pcs, onChange) {
        container.classList.add('pc-picker');
        container.innerHTML =
            '<input type="text" class="pc-picker-search" placeholder="Поиск: имя, магазин, IP…">' +
            '<div class="pc-picker-list" hidden></div>';
        const input = container.querySelector('.pc-picker-search');
        const list = container.querySelector('.pc-picker-list');
        let picked = null;

        function render(q) {
            const rows = pcs.filter(function (pc) { return pcMatches(pc, q); }).slice(0, 50);
            list.innerHTML = rows.length
                ? rows.map(function (pc) { return '<button type="button" data-id="' + pc.id + '">' + escapeHtml(pcLabel(pc)) + '</button>'; }).join('')
                : '<div class="pc-picker-empty">Ничего не найдено</div>';
        }
        input.addEventListener('focus', function () { render(input.value); list.hidden = false; });
        input.addEventListener('input', function () { render(input.value); list.hidden = false; });
        input.addEventListener('blur', function () { setTimeout(function () { list.hidden = true; }, 150); });
        list.addEventListener('mousedown', function (e) {
            const btn = e.target.closest('button[data-id]');
            if (!btn) return;
            picked = pcs.find(function (pc) { return String(pc.id) === btn.dataset.id; }) || null;
            input.value = picked ? pcLabel(picked) : '';
            list.hidden = true;
            onChange(picked);
        });
        return { getPicked: function () { return picked; } };
    }

    // 1 касса, 2 кассы, 5 касс.
    function plural(n, one, few, many) {
        const a = Math.abs(n) % 100, b = a % 10;
        if (a > 10 && a < 20) return many;
        if (b === 1) return one;
        if (b >= 2 && b <= 4) return few;
        return many;
    }

    // ---- Выбор цели «Кому» (все / магазин / группа / тип / один ПК) с живым счётчиком --

    // Строит в container поля «Кому» и «Кто именно» и под ними строку «Попадёт на 12 касс,
    // на связи 9» — пересчитывается при каждом изменении, так что масштаб команды виден
    // до нажатия «Отправить», а не только в окне подтверждения.
    //   opts.onChange({type, id, total, online}) — после каждого пересчёта;
    //   opts.label — подпись первого поля (по умолчанию «Кому»).
    // Возвращает { value(), set(type, id), stats() }.
    function targetPicker(container, opts) {
        opts = opts || {};
        container.classList.add('target-picker');
        container.innerHTML =
            '<div class="row">' +
            '<label>' + escapeHtml(opts.label || 'Кому') + '<span class="hint">Достанется каждой подходящей кассе — и тем, что сейчас выключены: они заберут ' +
            'задание, когда выйдут на связь (в пределах срока жизни команды).</span>' +
            '<select data-tp-type><option value="all">Всем кассам</option><option value="store">Магазину</option>' +
            '<option value="group">Группе хостов</option><option value="device_type">Типу устройства</option>' +
            '<option value="pc">Одному ПК</option></select></label>' +
            '<label data-tp-wrap hidden>Кто именно<select data-tp-id></select><div data-tp-pc hidden></div></label>' +
            '</div><div class="target-count" data-tp-count></div>';
        enhanceHints(container);

        const typeEl = container.querySelector('[data-tp-type]');
        const wrap = container.querySelector('[data-tp-wrap]');
        const idEl = container.querySelector('[data-tp-id]');
        const pcBox = container.querySelector('[data-tp-pc]');
        const countEl = container.querySelector('[data-tp-count]');
        const cache = {};
        let pickedPc = null, last = { total: 0, online: 0 }, seq = 0;

        async function options(type) {
            if (!cache[type]) {
                const endpoints = { store: '/admin/stores', group: '/admin/host-groups', device_type: '/admin/device-types', pc: '/admin/pcs' };
                cache[type] = await Api.get(endpoints[type]);
            }
            return cache[type];
        }

        function value() {
            const type = typeEl.value;
            if (type === 'all') return { type: 'all', id: null };
            if (type === 'pc') return { type: 'pc', id: pickedPc ? String(pickedPc.id) : '' };
            return { type: type, id: idEl.value };
        }

        async function recount() {
            const my = ++seq;
            const v = value();
            if (v.type !== 'all' && !v.id) {
                countEl.innerHTML = '<span class="muted">' + (v.type === 'pc' ? 'Найдите ПК по имени, магазину или IP' : 'Выберите, кому именно') + '</span>';
                last = { total: 0, online: 0 };
                if (opts.onChange) opts.onChange(Object.assign({}, v, last));
                return;
            }
            const params = { all: '', store: 'store_id=', group: 'group_id=', device_type: 'device_type_id=', pc: 'ids=' };
            let pcs = [];
            try { pcs = await Api.get('/admin/pcs' + (v.type === 'all' ? '' : '?' + params[v.type] + encodeURIComponent(v.id))); } catch (e) { /* счётчик не главное */ }
            if (my !== seq) return; // пока ждали ответ, цель уже поменяли
            const online = pcs.filter(function (pc) { return pc.online; }).length;
            last = { total: pcs.length, online: online };
            countEl.innerHTML = pcs.length
                ? icon('target') + '<span>Попадёт на <b>' + pcs.length + '</b> ' + plural(pcs.length, 'кассу', 'кассы', 'касс') +
                  ' <span class="muted">· на связи ' + online + (online < pcs.length ? ', остальные заберут, когда включатся' : '') + '</span></span>'
                : '<span class="warn-text">Под эту цель сейчас не подходит ни одна касса</span>';
            if (opts.onChange) opts.onChange(Object.assign({}, v, last));
        }

        async function showType(type, selectedId) {
            pickedPc = null;
            if (type === 'all') { wrap.hidden = true; return recount(); }
            wrap.hidden = false;
            const items = await options(type);
            if (type === 'pc') {
                idEl.hidden = true;
                pcBox.hidden = false;
                pcPicker(pcBox, items, function (pc) { pickedPc = pc; recount(); });
                const pre = selectedId && items.find(function (pc) { return String(pc.id) === String(selectedId); });
                if (pre) { pickedPc = pre; pcBox.querySelector('.pc-picker-search').value = pcLabel(pre); }
            } else {
                idEl.hidden = false;
                pcBox.hidden = true;
                idEl.innerHTML = items.map(function (it) {
                    return '<option value="' + it.id + '">' + escapeHtml(it.name || it.display_name || it.hostname) + '</option>';
                }).join('');
                if (selectedId) idEl.value = selectedId;
            }
            return recount();
        }

        typeEl.addEventListener('change', function () { showType(typeEl.value); });
        idEl.addEventListener('change', recount);
        recount();

        return {
            value: value,
            stats: function () { return last; },
            set: function (type, id) { typeEl.value = type || 'all'; return showType(typeEl.value, id); },
            describe: function () {
                const v = value();
                if (v.type === 'all') return 'всем кассам';
                if (v.type === 'pc') return pickedPc ? pcLabel(pickedPc) : '—';
                const opt = idEl.options[idEl.selectedIndex];
                const kinds = { store: 'магазин', group: 'группа', device_type: 'тип устройства' };
                return kinds[v.type] + ' «' + (opt ? opt.textContent : '?') + '»';
            },
        };
    }

    // Цель из адреса страницы: ?pc=5 (из профиля хоста) или ?target=group:3 (из «Групп»,
    // «Справочников»). null — цели в адресе нет.
    function targetFromQuery() {
        const qs = new URLSearchParams(window.location.search);
        if (qs.get('pc')) return { type: 'pc', id: qs.get('pc') };
        const m = /^(store|group|device_type|pc|all):?(\d*)$/.exec(qs.get('target') || '');
        return m ? { type: m[1], id: m[2] || null } : null;
    }

    // ---- Загрузка файла на сервер (POST /admin/files) с полоской хода ------------------

    // По одному файлу за запрос, через XHR — у fetch нет прогресса отправки. Разрешается
    // ответом сервера ({id, sha256, size, version, duplicate}), ошибки — текстом.
    function uploadFile(file, onProgress) {
        return new Promise(function (resolve, reject) {
            const form = new FormData();
            form.append('file', file);
            const xhr = new XMLHttpRequest();
            xhr.open('POST', '/admin/files');
            xhr.upload.addEventListener('progress', function (e) {
                if (e.lengthComputable && onProgress) onProgress(e.loaded / e.total);
            });
            xhr.addEventListener('load', function () {
                let data = {};
                try { data = JSON.parse(xhr.responseText); } catch (e) { /* — */ }
                if (xhr.status >= 200 && xhr.status < 300) return resolve(data);
                const code = data.error || ('http_' + xhr.status);
                reject(new Error(code === 'file_required_or_too_large' ? 'больше лимита сервера (' + data.upload_max_filesize + ')'
                    : reason({ data: data, message: code }, { insufficient_role: 'загружать файлы может администратор' })));
            });
            xhr.addEventListener('error', function () { reject(new Error('сеть недоступна')); });
            xhr.send(form);
        });
    }

    // ---- Ход выполнения команды: «3 из 7 готово · 1 с ошибкой» + полоска ----------------

    // c — строка из GET /admin/commands. words — подписи под задачу (файлы «качают»).
    function commandProgressHtml(c, words) {
        words = words || { run: 'в работе', wait: 'ждут' };
        const total = +c.target_count;
        if (!total) return '<span class="muted">нет касс под цель</span>';
        const bits = ['<b>' + c.success_count + '</b> из ' + total + ' готово'];
        if (+c.failed_count) bits.push('<span style="color:var(--danger)">' + c.failed_count + ' с ошибкой</span>');
        if (+c.in_progress_count) bits.push(c.in_progress_count + ' ' + words.run);
        if (+c.pending_count) bits.push(+c.expired ? c.pending_count + ' не получат (срок истёк)' : c.pending_count + ' ' + words.wait);
        return '<span style="font-size:12.5px">' + bits.join(' · ') + '</span>' + progressBar([
            { n: +c.success_count, kind: 'ok', label: 'готово' },
            { n: +c.failed_count, kind: 'bad', label: 'ошибка' },
            { n: +c.in_progress_count, kind: 'run', label: words.run },
            { n: +c.pending_count, kind: 'wait', label: words.wait },
        ], total);
    }

    // ---- Частые команды: одни и те же в форме «Команды» и в профиле хоста ---------------

    // Только то, что безопасно на работающей кассе и работает на Windows 7 (PowerShell 2.0:
    // поэтому Get-WmiObject, а не Get-CimInstance). Перезагрузки и прочее разрушительное
    // сюда намеренно не входит — такое пишется руками, осознанно. readonly — ничего не
    // меняет на кассе (профиль хоста отправляет такие без подтверждения).
    const COMMON_COMMANDS = [
        { key: 'disk', label: 'Свободное место на дисках', readonly: true, tip: 'PowerShell: свободно и всего по каждому локальному диску, в ГБ',
          type: 'script_run', payload: { engine: 'powershell',
            script: "Get-WmiObject Win32_LogicalDisk -Filter 'DriveType=3' |\n    Select-Object DeviceID, @{n='Свободно, ГБ';e={[math]::Round($_.FreeSpace/1GB,1)}}, @{n='Всего, ГБ';e={[math]::Round($_.Size/1GB,1)}} |\n    Format-Table -AutoSize | Out-String" } },
        { key: 'net', label: 'Сеть: ipconfig /all', readonly: true, tip: 'IP-адреса, шлюз, DNS и MAC каждой сетевой карты',
          type: 'script_run', payload: { engine: 'cmd', script: 'ipconfig /all' } },
        { key: 'users', label: 'Кто вошёл в систему', readonly: true, tip: 'Пользователи, вошедшие на кассу, и время входа (query user)',
          type: 'script_run', payload: { engine: 'cmd', script: 'query user' } },
        { key: 'os', label: 'Версия Windows и время работы', readonly: true, tip: 'Выпуск Windows, номер сборки и когда касса последний раз загружалась',
          type: 'script_run', payload: { engine: 'powershell',
            script: "$os = Get-WmiObject Win32_OperatingSystem\n'{0} (сборка {1})' -f $os.Caption, $os.BuildNumber\n'Загружена: ' + $os.ConvertToDateTime($os.LastBootUpTime)" } },
        { key: 'time', label: 'Часы и синхронизация', readonly: true, tip: 'Источник времени и когда часы последний раз сверялись (w32tm /query /status)',
          type: 'script_run', payload: { engine: 'cmd', script: 'w32tm /query /status' } },
        { key: 'procs', label: 'Список процессов', readonly: true, tip: 'Все процессы с PID и памятью — посмотреть перед завершением',
          type: 'process_action', payload: { action: 'list' } },
        { key: 'services', label: 'Список служб', readonly: true, tip: 'Все службы Windows с состоянием',
          type: 'service_control', payload: { action: 'list', service_name: '' } },
        { key: 'spooler', label: 'Перезапустить печать', tip: 'Перезапустить службу диспетчера печати (Spooler) — помогает, когда «завис» принтер чеков или документов',
          type: 'service_control', payload: { action: 'restart', service_name: 'Spooler' } },
        { key: 'queue', label: 'Очистить очередь печати', tip: 'Остановить Spooler, удалить застрявшие задания печати и запустить снова',
          type: 'script_run', payload: { engine: 'powershell',
            script: "Stop-Service Spooler -Force\nRemove-Item \"$env:SystemRoot\\System32\\spool\\PRINTERS\\*\" -Force -ErrorAction SilentlyContinue\nStart-Service Spooler\n'Очередь печати очищена, Spooler: ' + (Get-Service Spooler).Status" } },
    ];

    // ---- Часть глобальных настроек вне страницы «Настройки» -----------------------------

    // Часть ключей из общей таблицы settings удобнее редактировать там, где они реально
    // применяются (например, лимиты раскатки файлов — на странице «Команды»), а не только
    // в общем разделе «Настройки». Сам себя загружает (GET /admin/settings, как и полная
    // страница настроек) и сохраняет по клику на saveBtnId — эта же таблица settings,
    // те же ключи, просто разбросаны по разным страницам панели вместо одной.
    //   fields: { key: 'text'|'bool', ... } — id полей в DOM должны совпадать с ключами.
    function settingsFieldsPanel(fields, saveBtnId) {
        async function load() {
            const settings = await Api.get('/admin/settings');
            Object.keys(fields).forEach(function (key) {
                const el = $(key);
                if (!el || settings[key] === undefined) return;
                if (fields[key] === 'bool') el.checked = settings[key] === '1';
                else el.value = settings[key];
            });
        }
        $(saveBtnId).addEventListener('click', async function () {
            const body = {};
            Object.keys(fields).forEach(function (key) {
                const el = $(key);
                if (el) body[key] = fields[key] === 'bool' ? (el.checked ? '1' : '0') : el.value;
            });
            try {
                await Api.request('PUT', '/admin/settings', body);
                toast('Сохранено', 'success');
            } catch (err) {
                toast('Не удалось сохранить: ' + reason(err, { server_settings_require_superadmin: 'эти настройки может менять только суперадмин' }), 'error');
            }
        });
        load();
    }

    // ---- Drag-n-drop: перетаскивание хоста между узлами (вкладка «Узлы») ----------------

    // Источник перетаскивания — в dataTransfer кладётся value текстом (например, id ПК).
    // Нативный HTML5 DnD, без библиотек.
    function makeDraggable(el, value) {
        el.draggable = true;
        el.addEventListener('dragstart', function (e) {
            e.dataTransfer.setData('text/plain', String(value));
            e.dataTransfer.effectAllowed = 'move';
        });
    }

    // Цель — onDrop(value) вызывается с тем, что положил makeDraggable; hoverClass
    // подсвечивает цель, пока над ней тащат.
    function makeDropTarget(el, onDrop, hoverClass) {
        hoverClass = hoverClass || 'drop-hover';
        el.addEventListener('dragover', function (e) { e.preventDefault(); el.classList.add(hoverClass); });
        el.addEventListener('dragleave', function () { el.classList.remove(hoverClass); });
        el.addEventListener('drop', function (e) {
            e.preventDefault();
            el.classList.remove(hoverClass);
            const value = e.dataTransfer.getData('text/plain');
            if (value) onDrop(value);
        });
    }

    // ---- Иконки: один набор на всю панель (боковое меню, кнопки, пустые состояния) -----

    // Контурные SVG 24×24, цвет — от текста (stroke: currentColor в admin.css).
    const ICONS = {
        grid: '<rect x="3" y="3" width="7" height="7" rx="1.5"/><rect x="14" y="3" width="7" height="7" rx="1.5"/><rect x="3" y="14" width="7" height="7" rx="1.5"/><rect x="14" y="14" width="7" height="7" rx="1.5"/>',
        monitor: '<rect x="3" y="4" width="18" height="12" rx="2"/><path d="M8 20h8M12 16v4"/>',
        bell: '<path d="M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9"/><path d="M10 21a2 2 0 0 0 4 0"/>',
        layers: '<path d="m12 3 9 5-9 5-9-5 9-5z"/><path d="m3 13 9 5 9-5"/>',
        book: '<path d="M4 4.5A2.5 2.5 0 0 1 6.5 2H20v18H6.5A2.5 2.5 0 0 0 4 22z"/><path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20"/>',
        terminal: '<path d="m5 8 5 4-5 4"/><path d="M12 17h7"/><rect x="2" y="3" width="20" height="18" rx="2.5"/>',
        sliders: '<path d="M4 6h10M18 6h2M4 12h2M10 12h10M4 18h8M16 18h4"/><circle cx="16" cy="6" r="2"/><circle cx="8" cy="12" r="2"/><circle cx="14" cy="18" r="2"/>',
        users: '<circle cx="9" cy="8" r="3.5"/><path d="M2.5 20a6.5 6.5 0 0 1 13 0"/><circle cx="17" cy="9" r="2.5"/><path d="M15.5 14.5a5 5 0 0 1 6 4.5"/>',
        store: '<path d="M3 9.5 5 4h14l2 5.5"/><path d="M3 9.5a3 3 0 0 0 6 0 3 3 0 0 0 6 0 3 3 0 0 0 6 0"/><path d="M5 12v8h14v-8"/><path d="M10 20v-5h4v5"/>',
        scroll: '<path d="M8 3h11a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a3 3 0 0 1-3-3V6a3 3 0 0 1 3-3h2z"/><path d="M8 3v15a3 3 0 0 1-3 3"/><path d="M11 8h6M11 12h6M11 16h4"/>',
        sun: '<circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/>',
        key: '<circle cx="8" cy="15" r="4.5"/><path d="m11.5 11.5 8-8"/><path d="m16 7 2.5 2.5"/><path d="m19 4 2 2"/>',
        logout: '<path d="M10 4H6a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h4"/><path d="m15 8 4 4-4 4"/><path d="M9 12h10"/>',
        download: '<path d="M12 3v12"/><path d="m7 10 5 5 5-5"/><path d="M4 20h16"/>',
        upload: '<path d="M12 21V9"/><path d="m7 14 5-5 5 5"/><path d="M4 4h16"/>',
        folder: '<path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/>',
        file: '<path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z"/><path d="M14 3v5h5"/>',
        send: '<path d="m22 2-7 20-4-9-9-4z"/><path d="M22 2 11 13"/>',
        refresh: '<path d="M20 11a8 8 0 0 0-14.7-4.4L3 9"/><path d="M3 4v5h5"/><path d="M4 13a8 8 0 0 0 14.7 4.4L21 15"/><path d="M21 20v-5h-5"/>',
        plus: '<path d="M12 5v14M5 12h14"/>',
        trash: '<path d="M4 7h16"/><path d="M10 11v6M14 11v6"/><path d="M6 7l1 13h10l1-13"/><path d="M9 7V4h6v3"/>',
        copy: '<rect x="8" y="8" width="13" height="13" rx="2"/><path d="M16 8V5a2 2 0 0 0-2-2H5a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h3"/>',
        play: '<path d="M7 4v16l13-8z"/>',
        cog: '<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z"/>',
        cpu: '<rect x="5" y="5" width="14" height="14" rx="2"/><rect x="9" y="9" width="6" height="6"/><path d="M9 2v3M15 2v3M9 19v3M15 19v3M2 9h3M2 15h3M19 9h3M19 15h3"/>',
        list: '<path d="M8 6h13M8 12h13M8 18h13"/><path d="M3 6h.01M3 12h.01M3 18h.01"/>',
        power: '<path d="M12 2v10"/><path d="M18.4 6.6a9 9 0 1 1-12.8 0"/>',
        target: '<circle cx="12" cy="12" r="9"/><circle cx="12" cy="12" r="5"/><circle cx="12" cy="12" r="1"/>',
        check: '<path d="m5 12 5 5L20 7"/>',
        x: '<path d="M18 6 6 18M6 6l12 12"/>',
        info: '<circle cx="12" cy="12" r="9"/><path d="M12 11v5M12 8h.01"/>',
        search: '<circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/>',
        arrow: '<path d="M5 12h14M13 6l6 6-6 6"/>',
        package: '<path d="m12 3 8 4.5v9L12 21l-8-4.5v-9z"/><path d="m12 12 8-4.5M12 12v9M12 12 4 7.5"/>',
        zap: '<path d="M13 2 4 14h7l-1 8 9-12h-7z"/>',
    };

    function icon(name, cls) {
        return '<svg class="icon' + (cls ? ' ' + cls : '') + '" viewBox="0 0 24 24" aria-hidden="true">' + (ICONS[name] || '') + '</svg>';
    }

    // Пустое состояние вместо голого «нет данных»: что это за место и что сделать дальше.
    //   { icon, title, text, action: { label, id } }
    function emptyState(opts) {
        return '<div class="empty-state">' + icon(opts.icon || 'info') +
            '<b>' + escapeHtml(opts.title || '') + '</b>' +
            (opts.text ? '<span>' + escapeHtml(opts.text) + '</span>' : '') +
            (opts.action ? '<button type="button" class="primary" id="' + escapeHtml(opts.action.id) + '">' + escapeHtml(opts.action.label) + '</button>' : '') +
            '</div>';
    }

    // Полоска хода выполнения из нескольких сегментов (ок / ошибка / в работе / ждут).
    //   parts: [{ n, kind: 'ok'|'bad'|'run'|'wait', label }]
    function progressBar(parts, total) {
        if (!total) return '';
        return '<div class="progress-seg" role="img" aria-label="' + escapeHtml(parts.filter(function (p) { return p.n; })
            .map(function (p) { return p.label + ': ' + p.n; }).join(', ')) + '">' +
            parts.filter(function (p) { return p.n > 0; }).map(function (p) {
                return '<span class="seg seg-' + p.kind + '" style="width:' + (p.n / total * 100).toFixed(2) + '%"></span>';
            }).join('') + '</div>';
    }

    // ---- Всплывающие подсказки ---------------------------------------------------------

    // Своё облачко вместо системного title: появляется быстро, со стрелкой, умеет заголовок
    // (data-tip-title) и переносы строк, показывается и с клавиатуры (Tab), не вылезает
    // за край экрана. Любой title="..." на странице — в том числе в строках, которые
    // таблицы дорисовывают позже, — превращается в такую подсказку сам при первом
    // наведении: отдельно размечать старые страницы не нужно.
    const Tip = (function () {
        let el = null, body = null, current = null, timer = null, lastHidden = 0;

        function ensure() {
            if (el) return;
            el = document.createElement('div');
            el.className = 'tip';
            el.id = 'amadminTip';
            el.setAttribute('role', 'tooltip');
            el.innerHTML = '<div class="tip-body"></div><span class="tip-arrow"></span>';
            body = el.firstChild;
            document.body.appendChild(el);
        }

        // title -> data-tip: иначе браузер покажет поверх ещё и своё серое окошко.
        // Кнопке-иконке без текста title был единственным именем — отдаём его в aria-label.
        function adopt(target) {
            const t = target.getAttribute('title');
            if (t === null) return;
            target.removeAttribute('title');
            if (!t) return;
            target.setAttribute('data-tip', t);
            if (!target.getAttribute('aria-label') && !target.textContent.trim()) target.setAttribute('aria-label', t);
        }

        function place(target) {
            const r = target.getBoundingClientRect();
            el.style.left = '0px';
            el.style.top = '0px';
            const w = el.offsetWidth, h = el.offsetHeight, gap = 9;
            // Справа — для бокового меню: облачко сверху закрывало бы соседний пункт.
            if (target.getAttribute('data-tip-side') === 'right' && r.right + gap + w < window.innerWidth - 8) {
                const y = Math.max(8, Math.min(r.top + r.height / 2 - h / 2, window.innerHeight - h - 8));
                el.style.left = Math.round(r.right + gap) + 'px';
                el.style.top = Math.round(y) + 'px';
                el.style.setProperty('--arrow-y', Math.round(r.top + r.height / 2 - y) + 'px');
                el.setAttribute('data-side', 'right');
                return;
            }
            let top = r.top - h - gap, side = 'top';
            if (top < 8) { top = r.bottom + gap; side = 'bottom'; }
            let left = r.left + r.width / 2 - w / 2;
            left = Math.max(8, Math.min(left, window.innerWidth - w - 8));
            el.style.left = Math.round(left) + 'px';
            el.style.top = Math.round(top) + 'px';
            el.style.setProperty('--arrow-x', Math.round(Math.max(12, Math.min(w - 12, r.left + r.width / 2 - left))) + 'px');
            el.setAttribute('data-side', side);
        }

        function show(target) {
            const text = target.getAttribute('data-tip');
            if (!text) return;
            ensure();
            const title = target.getAttribute('data-tip-title');
            body.innerHTML = (title ? '<b>' + escapeHtml(title) + '</b>' : '') +
                escapeHtml(text).replace(/\n/g, '<br>');
            el.classList.toggle('tip-wide', text.length > 90);
            place(target);
            el.classList.add('show');
            current = target;
            target.setAttribute('aria-describedby', 'amadminTip');
        }

        function hide() {
            clearTimeout(timer);
            if (!current) return;
            current.removeAttribute('aria-describedby');
            current = null;
            lastHidden = Date.now();
            if (el) el.classList.remove('show');
        }

        function targetOf(node) {
            return node && node.closest ? node.closest('[data-tip], [title]') : null;
        }

        let pending = null;

        document.addEventListener('mouseover', function (e) {
            const t = targetOf(e.target);
            if (!t || t === current || t === pending) return;
            adopt(t);
            if (!t.getAttribute('data-tip')) return;
            clearTimeout(timer);
            // Уже ведут мышью по соседним подсказкам — показываем сразу, как в Windows.
            const delay = current || Date.now() - lastHidden < 400 ? 0 : 280;
            if (current) hide();
            pending = t;
            timer = setTimeout(function () { pending = null; show(t); }, delay);
        });
        document.addEventListener('mouseout', function (e) {
            const t = targetOf(e.target);
            if (!t || (e.relatedTarget && t.contains(e.relatedTarget))) return;
            if (t === pending) { clearTimeout(timer); pending = null; }
            if (t === current) hide();
        });
        document.addEventListener('focusin', function (e) {
            const t = targetOf(e.target);
            if (!t || t !== e.target) return;
            adopt(t);
            // Только с клавиатуры: при клике мышью подсказка уже показана наведением.
            if (t.matches(':focus-visible') && t.getAttribute('data-tip')) { hide(); show(t); }
        });
        document.addEventListener('focusout', function (e) {
            // Клик по ⓘ сначала показывает подсказку (mousedown), потом уводит фокус с
            // прежнего поля — этот focusout не должен её тут же спрятать.
            if (current && current.classList.contains('help') && e.target !== current) return;
            hide();
        });
        document.addEventListener('keydown', function (e) { if (e.key === 'Escape') hide(); });
        document.addEventListener('mousedown', function (e) {
            // Нажатие на ⓘ подсказку переключает (удобно на сенсорном экране), остальное — прячет.
            const help = e.target.closest && e.target.closest('.help');
            if (help && help === current) { hide(); return; }
            if (help) { clearTimeout(timer); show(help); return; }
            hide();
        });
        window.addEventListener('scroll', hide, true);
        window.addEventListener('resize', hide);

        return { show: show, hide: hide };
    })();

    // Длинные пояснения под полями (<label>Имя <span class="hint">…</span><input>) —
    // в значок ⓘ рядом с названием поля: форма становится вдвое короче, а пояснение
    // по-прежнему в одном наведении (или Tab) от поля. Сам текст остаётся в разметке для
    // экранного диктора (aria-describedby поля). .hint.keep — оставить видимым: так
    // помечены предупреждения, которые нельзя пропустить. Вызывается для всей страницы
    // при загрузке и для каждого модального окна.
    let hintSeq = 0;
    function enhanceHints(root) {
        (root || document).querySelectorAll('label > .hint:not(.keep):not([data-tipped])').forEach(function (hint) {
            const label = hint.parentElement;
            const text = hint.textContent.replace(/\s+/g, ' ').trim();
            if (!text) return;
            hint.setAttribute('data-tipped', '1');
            hint.classList.add('sr-only');
            hint.id = hint.id || 'hint' + (++hintSeq);

            // Подпись поля — текст в начале <label> до первого элемента-поля; у чекбокса
            // подпись идёт после самого чекбокса.
            const line = document.createElement('span');
            line.className = 'label-line';
            let node = label.firstChild;
            while (node && node.nodeType === 3 && !node.textContent.trim()) node = node.nextSibling;
            let box = null;
            if (node && node.nodeType === 1 && node.matches('input[type="checkbox"], input[type="radio"]')) {
                box = node;
                node = node.nextSibling;
            }
            while (node && (node.nodeType === 3 || (node.nodeType === 1 && node.matches('b, i, em, strong, code, small')))) {
                const next = node.nextSibling;
                line.appendChild(node);
                node = next;
            }
            if (box) box.after(line); else label.prepend(line);

            const help = document.createElement('span');
            help.className = 'help';
            help.tabIndex = 0;
            help.setAttribute('role', 'button');
            help.setAttribute('aria-label', 'Подсказка');
            help.setAttribute('data-tip', text);
            help.textContent = '?';
            // Внутри <label> клик по значку иначе переключил бы чекбокс / сфокусировал поле.
            help.addEventListener('click', function (e) { e.preventDefault(); e.stopPropagation(); });
            line.appendChild(help);

            const control = label.querySelector('input, select, textarea');
            if (control) control.setAttribute('aria-describedby', hint.id);
        });
    }

    document.addEventListener('DOMContentLoaded', function () { enhanceHints(document); });

    initTheme();

    // Версия хоста (младшая из службы и окна оповещений) и пометка, если они разошлись:
    // окно подхватывает обновление только при следующем входе пользователя.
    function agentVersionHtml(pc, emptyText) {
        const v = escapeHtml(pc.agent_version || emptyText || '—');
        const m = pc.mgmt_agent_version, u = pc.ui_agent_version;
        if (!m || !u || m === u) return v;
        return v + ' <span class="muted" title="Окно оповещений обновится при следующем входе пользователя">' +
            '(служба ' + escapeHtml(m) + ', окно ' + escapeHtml(u) + ')</span>';
    }

    return {
        $: $, escapeHtml: escapeHtml, formatSize: formatSize, toast: toast, reason: reason, agentVersionHtml: agentVersionHtml,
        modal: modal, confirm: confirm, prompt: prompt, menu: menu, toggleTheme: toggleTheme, toggleDetail: toggleDetail,
        makeSortable: makeSortable, compareBy: compareBy, pcLabel: pcLabel, pcMatches: pcMatches, pcPicker: pcPicker,
        settingsFieldsPanel: settingsFieldsPanel, makeDraggable: makeDraggable, makeDropTarget: makeDropTarget,
        icon: icon, emptyState: emptyState, progressBar: progressBar, enhanceHints: enhanceHints, tip: Tip,
        plural: plural, targetPicker: targetPicker,
        targetFromQuery: targetFromQuery, uploadFile: uploadFile, commandProgressHtml: commandProgressHtml, COMMON_COMMANDS: COMMON_COMMANDS,
    };
})();
