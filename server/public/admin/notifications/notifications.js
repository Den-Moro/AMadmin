// Страница «Оповещения»: форма (шаблоны, когда показать, кому — со счётчиком касс),
// история с «подтвердили N из M» и вкладка «Шаблоны». Отправка — POST /admin/notifications;
// время показа уходит в UTC (fire_at), агент покажет оповещение, когда оно наступит.
(async function () {
    await requireAdminAuth();
    const $ = Ui.$, esc = Ui.escapeHtml;

    $('newBtn').innerHTML = Ui.icon('plus') + 'Новое оповещение';
    $('closeNewBtn').innerHTML = Ui.icon('x');
    $('searchIcon').outerHTML = Ui.icon('search');
    $('addTplBtn').innerHTML = Ui.icon('plus') + 'Шаблон';

    const SIZES = { small: 'маленькое', medium: 'среднее', large: 'крупное' };
    const ERRORS = {
        text_required: 'введите текст', target_id_required: 'выберите, кому именно', target_not_found: 'получатель не найден',
        invalid_fire_at: 'неверное время показа', name_required: 'укажите название шаблона', invalid_level: 'неверный уровень важности',
        invalid_repeat: 'неверное правило повтора', invalid_repeat_hours: 'интервал повтора — от 1 до 168 часов', invalid_repeat_time: 'укажите время повтора',
        invalid_repeat_days: 'отметьте дни недели', invalid_repeat_until: 'неверная дата окончания повторов',
        repeat_never_fires: 'с такими условиями не будет ни одного показа — проверьте дату «до»',
        smart_group_requires_superadmin: 'смарт-группы — только для суперадмина', not_repeating: 'повторы уже остановлены',
    };

    // ---- Вкладки --------------------------------------------------------------------------

    function showTab(name) {
        document.querySelectorAll('.tabs button').forEach(function (x) { x.classList.toggle('active', x.dataset.tab === name); });
        document.querySelectorAll('.tab-panel').forEach(function (p) { p.hidden = p.dataset.panel !== name; });
    }
    document.querySelectorAll('.tabs button').forEach(function (b) { b.addEventListener('click', function () { showTab(b.dataset.tab); }); });

    // ---- Форма ------------------------------------------------------------------------------

    let targetState = { type: 'all', id: null, total: 0, online: 0 };
    const target = Ui.targetPicker($('targetBox'), { onChange: function (s) { targetState = s; renderSendBtn(); } });
    const images = Ui.imagePicker($('imagePicker'), { pasteTarget: $('createForm') });

    function openForm() {
        $('createForm').hidden = false;
        $('formError').textContent = '';
        $('createForm').scrollIntoView({ behavior: 'smooth', block: 'start' });
        setTimeout(function () { $('text').focus(); }, 300);
    }
    function closeForm() { $('createForm').hidden = true; }
    $('newBtn').addEventListener('click', function () { if ($('createForm').hidden) openForm(); else closeForm(); });
    $('cancelNewBtn').addEventListener('click', closeForm);
    $('closeNewBtn').addEventListener('click', closeForm);

    function fill(src) {
        $('text').value = src.text || '';
        $('level').value = src.level || 'warning';
        images.set(src.images || []);
        $('size').value = src.size || 'medium';
        $('manualUrl').value = src.manual_url || '';
        $('manualPicker').value = '';
        renderSendBtn();
    }

    // Когда показать: «сейчас» или время по часам этого компьютера (уходит на сервер в UTC).
    function pad(n) { return String(n).padStart(2, '0'); }
    function localInputValue(d) {
        return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()) + 'T' + pad(d.getHours()) + ':' + pad(d.getMinutes());
    }
    $('whenMode').addEventListener('change', function () {
        const at = this.value === 'at';
        $('fireAt').hidden = !at;
        $('repeatBox').hidden = this.value !== 'repeat';
        renderRepeatHint();
        if (at && !$('fireAt').value) {
            // По умолчанию — начало ближайшего часа, но не раньше чем через полчаса.
            const d = new Date(Date.now() + 30 * 60 * 1000);
            if (d.getMinutes() || d.getSeconds()) d.setHours(d.getHours() + 1, 0, 0, 0);
            $('fireAt').value = localInputValue(d);
        }
        renderWhenHint();
        renderSendBtn();
    });
    $('fireAt').addEventListener('input', function () { renderWhenHint(); renderSendBtn(); });
    function fireAtDate() {
        if ($('whenMode').value !== 'at' || !$('fireAt').value) return null;
        const d = new Date($('fireAt').value);
        return isNaN(d.getTime()) ? null : d;
    }
    function renderWhenHint() {
        const d = fireAtDate();
        $('fireAtHint').textContent = $('whenMode').value !== 'at' ? ''
            : !d ? 'укажите дату и время'
            : d.getTime() <= Date.now() ? 'это время уже прошло — оповещение уйдёт сразу'
            : 'через ' + humanSpan(d.getTime() - Date.now());
    }
    function humanSpan(ms) {
        const min = Math.round(ms / 60000);
        if (min < 60) return min + ' мин';
        if (min < 48 * 60) return Math.floor(min / 60) + ' ч ' + (min % 60 ? min % 60 + ' мин' : '');
        return Math.round(min / 1440) + ' дн';
    }

    function renderSendBtn() {
        const total = targetState.total;
        const at = fireAtDate();
        const later = at && at.getTime() > Date.now();
        const repeat = $('whenMode').value === 'repeat';
        $('sendBtn').innerHTML = Ui.icon(later || repeat ? 'bell' : 'send') + (repeat ? 'Запланировать повторы' : later ? 'Запланировать' : 'Отправить') +
            (total ? ' на ' + total + ' ' + Ui.plural(total, 'кассу', 'кассы', 'касс') : '');
    }

    // ---- Повторы (ТЗ: регулярные напоминания вроде плановой сверки) -----------------------
    // Время повтора — по часам магазинов (часовой пояс в Настройках), как и тихие часы:
    // сервер считает показы сам, браузер администратора может быть в другом поясе.
    let storeTz = '';
    Api.get('/admin/settings').then(function (s) { storeTz = s.timezone || ''; renderRepeatHint(); }).catch(function () { /* не важно */ });
    const DAY_NAMES = { 1: 'пн', 2: 'вт', 3: 'ср', 4: 'чт', 5: 'пт', 6: 'сб', 7: 'вс' };

    function repeatRule() {
        if ($('whenMode').value !== 'repeat') return null;
        const every = $('repeatEvery').value;
        if (every === 'hours') return { every: 'hours', hours: parseInt($('repeatHours').value, 10) || 0 };
        const rule = { every: every, time: $('repeatTime').value };
        if (every === 'week') rule.days = [...document.querySelectorAll('#repeatDays input:checked')].map(function (i) { return +i.value; });
        return rule;
    }
    function describeRepeat(rule) {
        if (!rule) return '';
        if (rule.every === 'hours') return 'каждые ' + rule.hours + ' ч';
        const when = ' в ' + rule.time;
        if (rule.every === 'day') return 'каждый день' + when;
        if (rule.every === 'weekdays') return 'по будням' + when;
        return (rule.days || []).map(function (d) { return DAY_NAMES[d]; }).join(', ') + when;
    }
    function repeatProblem() {
        const rule = repeatRule();
        if (!rule) return '';
        if (rule.every === 'hours' && (rule.hours < 1 || rule.hours > 168)) return 'интервал повтора — от 1 до 168 часов';
        if (rule.every !== 'hours' && !/^\d\d:\d\d$/.test(rule.time || '')) return 'укажите время повтора';
        if (rule.every === 'week' && !rule.days.length) return 'отметьте хотя бы один день недели';
        return '';
    }
    function renderRepeatHint() {
        const every = $('repeatEvery').value;
        $('repeatTimeWrap').hidden = every === 'hours';
        $('repeatHoursWrap').hidden = every !== 'hours';
        $('repeatDays').hidden = every !== 'week';
        const rule = repeatRule();
        const problem = repeatProblem();
        $('repeatHint').textContent = !rule ? '' : problem ? problem
            : 'Показ ' + describeRepeat(rule) + (rule.every === 'hours' ? ', первый — сразу' : ' по часам магазинов' + (storeTz ? ' (' + storeTz + ')' : '') + ', первый — в ближайшее такое время') +
              ($('repeatUntil').value ? ', последний день — ' + new Date($('repeatUntil').value + 'T00:00').toLocaleDateString() : ', пока не остановите') +
              '. Каждый показ подтверждается отдельно; касса, которая была выключена, получит только последний.';
        renderSendBtn();
    }
    ['repeatEvery', 'repeatTime', 'repeatHours', 'repeatUntil'].forEach(function (id) {
        $(id).addEventListener('input', renderRepeatHint);
        $(id).addEventListener('change', renderRepeatHint);
    });
    $('repeatDays').addEventListener('change', renderRepeatHint);

    // Статья Wiki копирует свой текст в поле — не ссылку на статью (правка статьи в Wiki
    // не меняет уже отправленные оповещения задним числом). Окно на кассе показывает
    // инструкцию простым текстом, поэтому разметку Wiki убираем; если статья — одна
    // ссылка, уходит ссылка (касса откроет её в браузере).
    async function loadManualPicker() {
        const wiki = await Api.get('/admin/wiki');
        const sections = {};
        wiki.sections.forEach(function (s) { sections[s.id] = s.name; });
        const groups = {};
        wiki.articles.forEach(function (a) { (groups[a.section_id || 0] = groups[a.section_id || 0] || []).push(a); });
        $('manualPicker').innerHTML = '<option value="">— не выбирать —</option>' + Object.keys(groups).map(function (sid) {
            return '<optgroup label="' + esc(sections[sid] || 'Без раздела') + '">' + groups[sid].map(function (a) {
                return '<option value="' + a.id + '">' + esc(a.title) + '</option>';
            }).join('') + '</optgroup>';
        }).join('');
    }
    function wikiPlain(body) {
        const t = String(body || '').trim();
        if (/^https?:\/\/\S+$/.test(t)) return t;
        return t.replace(/!\[[^\]]*\]\([^)]*\)/g, '')
            .replace(/\[([^\]]+)\]\(([^)]+)\)/g, '$1 ($2)')
            .replace(/^#{1,6}\s*/gm, '').replace(/\*\*([^*]+)\*\*/g, '$1').replace(/`([^`]+)`/g, '$1')
            .replace(/^\s*[-*]\s+/gm, '• ').replace(/\n{3,}/g, '\n\n').trim();
    }
    $('manualPicker').addEventListener('change', async function () {
        if (!$('manualPicker').value) return;
        try {
            const a = await Api.get('/admin/wiki/articles/' + $('manualPicker').value);
            $('manualUrl').value = wikiPlain(a.body) || a.title;
        } catch (err) { Ui.toast('Не удалось открыть статью: ' + Ui.reason(err), 'error'); }
    });

    function formProblems() {
        const problems = [];
        const text = $('text').value.trim();
        if (!text) problems.push('введите текст');
        const holes = text.match(/\[[^\]\n]{1,40}\]/g);
        if (holes) problems.push('заполните в тексте ' + holes.join(', '));
        if ($('whenMode').value === 'at' && !fireAtDate()) problems.push('укажите дату и время показа');
        if (repeatProblem()) problems.push(repeatProblem());
        if (targetState.type !== 'all' && !targetState.id) problems.push('выберите, кому именно');
        else if (!targetState.total) problems.push('под выбранную цель не подходит ни одна касса');
        return problems;
    }

    $('createForm').addEventListener('submit', async function (e) {
        e.preventDefault();
        const problems = formProblems();
        if (problems.length) { $('formError').textContent = 'Проверьте: ' + problems.join('; ') + '.'; return; }
        $('formError').textContent = '';
        const total = targetState.total;
        const at = fireAtDate();
        const later = at && at.getTime() > Date.now();
        const lvl = $('level').value;
        const rule = repeatRule();
        // Массовое важное оповещение перебивает работу каждого кассира — переспросить.
        if (total > 1 && !await Ui.confirm((rule ? 'Запланировать повторяющееся ' : later ? 'Запланировать ' : 'Отправить ') + 'оповещение «' + Ui.LEVELS[lvl].label + '» на ' + total + ' ' +
            Ui.plural(total, 'кассу', 'кассы', 'касс') + ' (' + target.describe() + ')' + (rule ? ': ' + describeRepeat(rule) : later ? ' на ' + at.toLocaleString() : '') + '?',
            { okLabel: rule || later ? 'Запланировать' : 'Отправить', title: 'Оповещение' })) return;

        $('sendBtn').disabled = true;
        try {
            await Api.post('/admin/notifications', {
                text: $('text').value.trim(), level: $('level').value, size: $('size').value, images: images.get(),
                manual_url: $('manualUrl').value, target: target.value(),
                fire_at: later ? at.toISOString() : null,
                repeat: rule,
                // «До» — последний день включительно, по часам этого компьютера.
                repeat_until: rule && $('repeatUntil').value ? new Date($('repeatUntil').value + 'T23:59:59').toISOString() : null,
            });
            Ui.toast(rule ? 'Повторяющееся оповещение запланировано: ' + describeRepeat(rule) + '. Остановить — в истории, меню ⋯'
                : later ? 'Запланировано на ' + at.toLocaleString() + ' — до этого его можно отозвать' : 'Отправлено — кассы покажут его на ближайшем опросе', 'success');
            $('createForm').reset();
            images.set([]);
            $('fireAt').hidden = true;
            $('repeatBox').hidden = true;
            renderWhenHint();
            closeForm();
            await loadNotifications();
        } catch (err) {
            $('formError').textContent = 'Не удалось отправить: ' + Ui.reason(err, ERRORS);
        } finally {
            $('sendBtn').disabled = false;
        }
    });

    // ---- Шаблоны -----------------------------------------------------------------------------

    let templates = [];

    async function loadTemplates() {
        templates = await Api.get('/admin/message-templates');
        $('tplCount').textContent = templates.length;
        $('templateChips').innerHTML = templates.length ? templates.map(function (t) {
            return '<button type="button" class="chip link" style="font-family:inherit" data-tpl="' + t.id + '" title="' + esc(t.text) + '">' +
                (t.level === 'critical' || t.level === 'important' ? '⚠ ' : '') + esc(t.title) + (t.images && t.images.length ? ' 🖼' : '') + '</button>';
        }).join('') : '<span class="muted">Шаблонов нет — создайте на вкладке «Шаблоны» или кнопкой «Сохранить как шаблон».</span>';

        const tbody = document.querySelector('#templatesTable tbody');
        tbody.innerHTML = templates.length ? templates.map(function (t) {
            return '<tr data-id="' + t.id + '"><td><b>' + esc(t.title) + '</b></td>' +
                '<td><div class="tpl-text">' + esc(t.text) + '</div>' + (t.manual_url ? '<span class="muted" style="font-size:12px">+ инструкция</span>' : '') + Ui.imageThumbs(t.images) + '</td>' +
                '<td>' + Ui.levelBadge(t.level) + ' <span class="muted" style="font-size:12px">' + SIZES[t.size] + '</span></td>' +
                '<td><div class="actions" style="flex-wrap:nowrap">' +
                    '<button type="button" class="small primary" data-use title="Открыть форму с этим шаблоном">' + Ui.icon('send') + 'Использовать</button>' +
                    '<button type="button" class="small" data-edit title="Изменить шаблон">Изменить</button>' +
                    '<button type="button" class="small" data-delete title="Удалить шаблон (отправленные оповещения не затронет)">Удалить</button>' +
                '</div></td></tr>';
        }).join('') : '<tr><td colspan="4">' + Ui.emptyState({ icon: 'bell', title: 'Шаблонов пока нет',
            text: 'Шаблон — заготовка типового сообщения: «плановые работы», «работы завершены». Нажмите «Шаблон».' }) + '</td></tr>';
    }

    function useTemplate(t) {
        fill(t);
        openForm();
        Ui.toast('Шаблон «' + t.title + '» подставлен' + (/\[[^\]]+\]/.test(t.text) ? ' — заполните места в [скобках]' : '') + ' и выберите, кому.', 'info');
    }

    $('templateChips').addEventListener('click', function (e) {
        const b = e.target.closest('[data-tpl]');
        if (b) useTemplate(templates.find(function (t) { return String(t.id) === b.dataset.tpl; }));
    });

    async function editTemplate(t, preset) {
        const src = t || preset || {};
        let tplImages = null;
        const opened = Ui.modal({
            title: t ? 'Шаблон «' + t.title + '»' : 'Новый шаблон',
            body: '<label>Название<span class="hint">Как шаблон подписан над формой, например «Плановые работы».</span>' +
                '<input type="text" id="tTitle" value="' + esc(src.title || '') + '" placeholder="Плановые работы"></label>' +
                '<label>Текст<span class="hint">Места, которые надо заполнять при каждой отправке, возьмите в [квадратные скобки] — например [время]. Панель не даст отправить, пока они не заполнены.</span>' +
                '<textarea id="tText" rows="4">' + esc(src.text || '') + '</textarea></label>' +
                '<div class="row"><label>Уровень<select id="tLevel">' + options({ info: 'Информация', warning: 'Внимание', important: 'Важно', critical: 'Критично' }, src.level || 'warning') + '</select></label>' +
                '<label>Размер окна<select id="tSize">' + options({ small: 'Маленькое', medium: 'Среднее', large: 'Крупное' }, src.size || 'medium') + '</select></label></div>' +
                '<label>Ссылка или текст инструкции (необязательно)<textarea id="tManual" rows="2">' + esc(src.manual_url || '') + '</textarea></label>' +
                '<label>Картинки</label><div id="tImages"></div>' +
                '<p class="error modal-error"></p>',
            buttons: [{ label: 'Отмена', value: null }, { label: t ? 'Сохранить' : 'Создать', value: 'submit', kind: 'primary' }],
            submitOnEnter: false, errors: ERRORS,
            onSubmit: async function (root) {
                const body = {
                    title: root.querySelector('#tTitle').value.trim(), text: root.querySelector('#tText').value.trim(),
                    level: root.querySelector('#tLevel').value, size: root.querySelector('#tSize').value, images: tplImages.get(),
                    manual_url: root.querySelector('#tManual').value.trim(),
                };
                if (!body.title || !body.text) { root.querySelector('.modal-error').textContent = 'Укажите название и текст.'; return false; }
                if (t) await Api.request('PUT', '/admin/message-templates/' + t.id, body);
                else await Api.post('/admin/message-templates', body);
                return true;
            },
        });
        // Ui.modal вставляет окно сразу — выбор картинок подключаем к уже вставленному блоку.
        tplImages = Ui.imagePicker(document.getElementById('tImages'), { pasteTarget: document.getElementById('tImages').closest('.modal') });
        tplImages.set(src.images || []);
        const ok = await opened;
        if (ok) { Ui.toast('Шаблон сохранён', 'success'); await loadTemplates(); }
    }
    function options(map, selected) {
        return Object.keys(map).map(function (k) { return '<option value="' + k + '"' + (k === selected ? ' selected' : '') + '>' + map[k] + '</option>'; }).join('');
    }

    $('addTplBtn').addEventListener('click', function () { editTemplate(null); });
    $('saveTplBtn').addEventListener('click', function () {
        if (!$('text').value.trim()) { $('formError').textContent = 'Сначала введите текст — его и сохраним как шаблон.'; return; }
        editTemplate(null, { title: '', text: $('text').value.trim(), level: $('level').value, size: $('size').value, manual_url: $('manualUrl').value, images: images.get().map(function (id) { return { id: id }; }) });
    });
    document.querySelector('#templatesTable').addEventListener('click', async function (e) {
        const tr = e.target.closest('tr[data-id]');
        if (!tr) return;
        const t = templates.find(function (x) { return String(x.id) === tr.dataset.id; });
        if (e.target.closest('[data-use]')) { useTemplate(t); return; }
        if (e.target.closest('[data-edit]')) { editTemplate(t); return; }
        if (e.target.closest('[data-delete]')) {
            if (!await Ui.confirm('Удалить шаблон «' + t.title + '»? Уже отправленные оповещения это не затронет.', { danger: true, okLabel: 'Удалить' })) return;
            try { await Api.request('DELETE', '/admin/message-templates/' + t.id); Ui.toast('Шаблон удалён', 'success'); await loadTemplates(); }
            catch (err) { Ui.toast('Не удалось: ' + Ui.reason(err), 'error'); }
        }
    });

    // ---- История --------------------------------------------------------------------------

    let rows = [];
    const targetNames = { all: 'Всем кассам', store: 'Магазин', group: 'Группа', device_type: 'Тип', pc: 'ПК' };
    function describeTarget(n) {
        if (!n.target_type) return '—';
        if (n.target_type === 'all') return targetNames.all;
        return (targetNames[n.target_type] || n.target_type) + ' «' + (n.target_name || '#' + n.target_id) + '»';
    }

    async function loadNotifications() {
        rows = await Api.get('/admin/notifications');
        const q = $('search').value.toLowerCase();
        const tbody = document.querySelector('#notificationsTable tbody');
        const open = new Set([...tbody.querySelectorAll('tr.open')].map(function (tr) { return tr.dataset.id; }));
        const lf = $('levelFilter').value;
        const visible = rows.filter(function (n) {
            return (!lf || n.level === lf) && (!q || (n.text + ' ' + describeTarget(n)).toLowerCase().indexOf(q) >= 0);
        });
        if (!visible.length) {
            tbody.innerHTML = '<tr><td colspan="6">' + (rows.length ? '<div class="empty">Ничего не найдено.</div>'
                : Ui.emptyState({ icon: 'bell', title: 'Оповещений ещё не было', text: 'Нажмите «Новое оповещение» и выберите шаблон — например, «Плановые работы».' })) + '</td></tr>';
            return;
        }
        tbody.innerHTML = visible.map(function (n) {
            const total = +n.target_count;
            const scheduled = +n.scheduled;
            // У повторяющегося — подтверждения последнего показа: «все ли увидели сегодняшнее».
            const repeating = !!n.repeat_rule;
            const acks = repeating ? +n.last_acks_count : +n.acks_count;
            const whenCell = repeating
                ? '<span class="badge badge-info" title="Повторяющееся: каждый показ подтверждается отдельно">повторяется</span>' +
                  '<span style="display:block;margin-top:3px">' + esc(describeRepeat(n.repeat_rule)) + '</span>' +
                  '<span style="display:block;font-size:12px">' + (n.next_fire_at ? 'следующий: ' + esc(formatServerTime(n.next_fire_at))
                    : n.repeat_stopped_at ? 'остановлено ' + esc(formatServerTime(n.repeat_stopped_at)) : 'повторы закончились') + '</span>'
                : scheduled
                ? '<span class="badge badge-info" title="Ещё не показано — кассы получат его в это время. До этого можно отозвать">запланировано</span><span style="display:block;margin-top:3px">' + esc(formatServerTime(n.fire_at)) + '</span>'
                : esc(formatServerTime(n.fire_at || n.created_at));
            return '<tr class="clickable" data-id="' + n.id + '">' +
                '<td class="muted nowrap">' + whenCell + '</td>' +
                '<td><div class="text-short">' + esc(n.text) + '</div>' + (n.manual_url ? '<span class="muted" style="font-size:12px">+ инструкция</span>' : '') + Ui.imageThumbs(n.images) + '</td>' +
                '<td>' + esc(describeTarget(n)) + '</td>' +
                '<td>' + Ui.levelBadge(n.level) + '</td>' +
                '<td class="acks-cell">' + (scheduled || (repeating && !n.last_shown_at) ? '<span class="muted">ещё не показано</span>'
                    : total ? '<span style="font-size:12.5px">' + (repeating ? '<span class="muted" title="' + esc(formatServerTime(n.last_shown_at)) + '">последний показ: </span>' : '') +
                        '<b>' + acks + '</b> из ' + total + '</span>' +
                        Ui.progressBar([{ n: Math.min(acks, total), kind: 'ok', label: 'подтвердили' }, { n: Math.max(0, total - acks), kind: 'wait', label: 'ещё нет' }], total)
                    : '<span class="muted">' + acks + '</span>') + '</td>' +
                '<td><div class="actions" style="flex-wrap:nowrap">' +
                    '<button type="button" class="small" data-act="repeat" title="Открыть форму с этим текстом, важностью и получателем — например, чтобы отправить другому магазину">Повторить</button>' +
                    '<button type="button" class="small ghost icon-only" data-act="more" title="Отозвать, сохранить как шаблон">⋯</button>' +
                '</div></td></tr>';
        }).join('');
        open.forEach(function (id) {
            const tr = tbody.querySelector('tr[data-id="' + id + '"]');
            const n = rows.find(function (x) { return String(x.id) === id; });
            if (tr && n) showAcks(tr, n, true);
        });
    }

    async function showAcks(tr, n, keepOpen) {
        if (!keepOpen && tr.classList.contains('open')) { Ui.toggleDetail(tr, '', 6); return; }
        const acks = await Api.get('/admin/notifications/' + n.id + '/acks');
        let html = '<p class="muted" style="margin:0 0 8px;white-space:pre-line">' + esc(n.text) + '</p>' +
            (n.images && n.images.length ? '<div style="margin:0 0 10px">' + Ui.imageThumbs(n.images) + '</div>' : '');
        if (!acks.length) {
            html += '<p class="muted" style="margin:0">' + (+n.scheduled ? 'Ещё не показано — запланировано на ' + esc(formatServerTime(n.fire_at)) + '.'
                : 'Пока никто не подтвердил — кассы ещё не опрашивали сервер, или окно ещё на экране.') + '</p>';
        } else {
            html += '<table><thead><tr><th>Магазин</th><th>Хост</th><th>Когда</th><th>Открыл инструкцию</th></tr></thead><tbody>' +
                acks.map(function (a) {
                    return '<tr><td>' + esc(a.store_name) + '</td><td><a class="host-link" href="/admin/hosts/host?id=' + a.pc_id + '">' + esc(a.display_name || a.hostname) + '</a></td>' +
                        '<td class="muted">' + esc(formatServerTime(a.acked_at)) + '</td>' +
                        '<td>' + (a.reacted ? '<span class="badge badge-success">да</span>' : '<span class="muted">—</span>') + '</td></tr>';
                }).join('') + '</tbody></table>';
        }
        if (tr.classList.contains('open')) Ui.toggleDetail(tr, '', 6);
        Ui.toggleDetail(tr, html, 6);
    }

    async function repeat(n) {
        fill(n);
        $('whenMode').value = 'now';
        $('fireAt').hidden = true;
        renderWhenHint();
        openForm();
        await target.set(n.target_type || 'all', n.target_id);
        Ui.toast('Форма заполнена из оповещения — проверьте и отправьте', 'info');
    }

    document.querySelector('#notificationsTable').addEventListener('click', async function (e) {
        if (e.target.closest('a')) return;
        const tr = e.target.closest('tr[data-id]');
        if (!tr) return;
        const n = rows.find(function (x) { return String(x.id) === tr.dataset.id; });
        const btn = e.target.closest('button[data-act]');
        if (btn && btn.dataset.act === 'repeat') { repeat(n); return; }
        if (btn && btn.dataset.act === 'more') {
            const act = await Ui.menu(btn, [
                { label: 'Сохранить как шаблон…', value: 'tpl' },
            ].concat(n.repeat_rule && !n.repeat_stopped_at && n.next_fire_at ? [
                { label: 'Остановить повторы', value: 'stop' },
            ] : []).concat([
                { label: +n.scheduled ? 'Отменить (ещё не показано)' : 'Отозвать', value: 'recall', danger: true },
            ]));
            if (act === 'tpl') editTemplate(null, { title: '', text: n.text, level: n.level, size: n.size, manual_url: n.manual_url, images: n.images });
            if (act === 'stop') {
                if (!await Ui.confirm('Остановить повторы «' + n.text.slice(0, 60) + '»? Уже показанные останутся в истории с подтверждениями, новых показов не будет.', { okLabel: 'Остановить' })) return;
                try { await Api.post('/admin/notifications/' + n.id + '/stop'); Ui.toast('Повторы остановлены', 'success'); await loadNotifications(); }
                catch (err) { Ui.toast('Не удалось: ' + Ui.reason(err, ERRORS), 'error'); }
                return;
            }
            if (act === 'recall') {
                if (!await Ui.confirm('Отозвать оповещение «' + n.text.slice(0, 60) + '»? Кассы, которые его ещё не показали, уже не покажут.', { danger: true, okLabel: 'Отозвать' })) return;
                try { await Api.request('DELETE', '/admin/notifications/' + n.id); Ui.toast('Отозвано', 'success'); loadNotifications(); }
                catch (err) { Ui.toast('Не удалось: ' + Ui.reason(err), 'error'); }
            }
            return;
        }
        showAcks(tr, n);
    });

    $('search').addEventListener('input', loadNotifications);
    $('levelFilter').addEventListener('change', loadNotifications);

    // ---- Старт ------------------------------------------------------------------------------

    await Promise.all([loadNotifications(), loadTemplates(), loadManualPicker()]);
    renderSendBtn();

    // Пришли из профиля хоста (?pc=ID) или из «Групп»/«Магазинов» (?target=group:3).
    const preset = Ui.targetFromQuery();
    if (preset) {
        openForm();
        await target.set(preset.type, preset.id);
    }
    // «Приложить к оповещению» из Wiki (?wiki=ID): форма с этой статьёй как инструкцией.
    const wikiId = new URLSearchParams(location.search).get('wiki');
    if (wikiId) {
        openForm();
        $('manualPicker').value = wikiId;
        $('manualPicker').dispatchEvent(new Event('change'));
    }

    // ---- Выгрузка статистики (ТЗ: CSV/Excel по ПК и магазинам) -------------------------------
    $('statsBtn').innerHTML = Ui.icon('download') + 'Статистика (CSV)';
    $('statsBtn').addEventListener('click', function () {
        const today = new Date();
        const monthAgo = new Date(Date.now() - 30 * 86400000);
        const day = function (d) { return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()); };
        Ui.modal({
            title: 'Статистика оповещений',
            body: '<p class="muted" style="margin-top:0">Файл для Excel: сколько показов оповещений адресовано каждой кассе (или магазину) за период, ' +
                'сколько подтверждено, открыли ли инструкцию и за сколько минут в среднем закрыли окно. Для отчётности и разбора проблемных точек.</p>' +
                '<div class="row"><label>С<input type="date" id="stFrom" value="' + day(monthAgo) + '"></label>' +
                '<label>По (включительно)<input type="date" id="stTo" value="' + day(today) + '"></label></div>' +
                '<label>Разрез<select id="stBy"><option value="pc">по кассам</option><option value="store">по магазинам</option></select></label>' +
                '<p class="error modal-error"></p>',
            buttons: [{ label: 'Отмена', value: null }, { label: 'Скачать', value: 'submit', kind: 'primary' }],
            onSubmit: function (root) {
                const from = root.querySelector('#stFrom').value, to = root.querySelector('#stTo').value;
                if (!from || !to || from > to) { root.querySelector('.modal-error').textContent = 'Проверьте даты периода.'; return false; }
                // Границы — по часам этого компьютера, на сервер уходят в UTC.
                const url = '/admin/notifications/stats.csv?from=' + encodeURIComponent(new Date(from + 'T00:00:00').toISOString()) +
                    '&to=' + encodeURIComponent(new Date(to + 'T23:59:59').toISOString()) + '&by=' + root.querySelector('#stBy').value;
                window.location.href = url;
            },
        });
    });

    setInterval(function () { if (!document.hidden) loadNotifications(); }, 30000);
})();
