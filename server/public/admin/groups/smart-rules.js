// Конструктор условий смарт-группы (бета, только суперадмин). Те же поля и операции, что
// проверяет сервер (Core/SmartGroups.php). Правила:
//   { match: 'all' | 'any', conditions: [{ field, op, value, name? }] }
const SmartRules = (function () {
    const esc = Ui.escapeHtml;

    const TEXT_OPS = { contains: 'содержит', not_contains: 'не содержит', equals: 'равно', not_equals: 'не равно',
        starts_with: 'начинается с', ends_with: 'заканчивается на', wildcard: 'по маске (* и ?)' };

    // input: что вводить в значение — select из справочника, текст, число, да/нет, переменная.
    const FIELDS = {
        store: { label: 'Магазин', ops: { is: 'это', is_not: 'не' }, input: 'stores' },
        device_type: { label: 'Тип устройства', ops: { is: 'это', is_not: 'не' }, input: 'deviceTypes' },
        group: { label: 'Обычная группа', ops: { in: 'состоит в', not_in: 'не состоит в' }, input: 'groups' },
        hostname: { label: 'Hostname', ops: TEXT_OPS, input: 'text', placeholder: 'KASSA-' },
        display_name: { label: 'Понятное имя', ops: TEXT_OPS, input: 'text', placeholder: 'Касса 1' },
        username: { label: 'Пользователь Windows', ops: TEXT_OPS, input: 'text', placeholder: 'kassir' },
        ip: { label: 'IP-адрес', ops: { in_subnet: 'в подсети', not_in_subnet: 'не в подсети' }, input: 'text', placeholder: '192.168.5.0/24, 10.1.0.0/16' },
        agent_version: { label: 'Версия агента', ops: { lt: 'ниже', lte: 'не выше', eq: 'равна', gte: 'не ниже', gt: 'выше', unknown: 'неизвестна' }, input: 'text', placeholder: '0.2.0' },
        status: { label: 'Состояние', ops: { is: 'сейчас', is_not: 'сейчас не' }, input: 'status' },
        silent_days: { label: 'Молчит, дней', ops: { gte: 'не меньше' }, input: 'number', placeholder: '3' },
        pilot: { label: 'Магазин пилотный', ops: { is: '—' }, input: 'yesno' },
        excluded: { label: 'Исключена из статистики', ops: { is: '—' }, input: 'yesno' },
        variable: { label: 'Переменная хоста', ops: { equals: 'равна', not_equals: 'не равна', contains: 'содержит', set: 'задана', not_set: 'не задана' }, input: 'variable' },
    };
    const STATUS = { online: 'на связи', offline: 'не на связи', never: 'ни разу не выходила' };

    const ERRORS = {
        conditions_required: 'добавьте хотя бы одно условие', too_many_conditions: 'не больше 20 условий',
        invalid_condition: 'условие заполнено неверно', condition_value_required: 'в условии не заполнено значение',
        invalid_subnet: 'подсеть — как 192.168.5.0/24, несколько через запятую', invalid_version: 'версия — числа через точку, например 0.2.0',
        invalid_variable_name: 'имя переменной — латиница, цифры и _', condition_group_must_be_static: 'в условии можно указать только обычную группу',
        name_required: 'укажите название', rules_required: 'добавьте условия',
    };

    // lookups: { stores: [], deviceTypes: [], groups: [] (обычные) }
    function valueControl(field, cond, lookups) {
        const def = FIELDS[field];
        const v = cond.value !== undefined ? String(cond.value) : '';
        const options = function (items) {
            return '<select data-v>' + items.map(function (it) {
                return '<option value="' + it.id + '"' + (String(it.id) === v ? ' selected' : '') + '>' + esc(it.name) + '</option>';
            }).join('') + '</select>';
        };
        switch (def.input) {
            case 'stores': return options(lookups.stores);
            case 'deviceTypes': return options(lookups.deviceTypes);
            case 'groups': return lookups.groups.length ? options(lookups.groups) : '<span class="muted">обычных групп нет</span>';
            case 'status': return '<select data-v>' + Object.keys(STATUS).map(function (k) {
                return '<option value="' + k + '"' + (k === v ? ' selected' : '') + '>' + STATUS[k] + '</option>'; }).join('') + '</select>';
            case 'yesno': return '<select data-v><option value="1"' + (v !== '0' ? ' selected' : '') + '>да</option><option value="0"' + (v === '0' ? ' selected' : '') + '>нет</option></select>';
            case 'number': return '<input type="number" min="1" data-v value="' + esc(v || '') + '" placeholder="' + esc(def.placeholder) + '">';
            case 'variable': return '<input type="text" data-n class="mono" value="' + esc(cond.name || '') + '" placeholder="ИМЯ" spellcheck="false">' +
                '<input type="text" data-v value="' + esc(v) + '" placeholder="значение">';
            default: return '<input type="text" data-v value="' + esc(v) + '" placeholder="' + esc(def.placeholder || '') + '" spellcheck="false">';
        }
    }

    function rowHtml(cond, lookups) {
        const field = FIELDS[cond.field] ? cond.field : 'store';
        const def = FIELDS[field];
        const op = def.ops[cond.op] ? cond.op : Object.keys(def.ops)[0];
        return '<div class="rule-row">' +
            '<select data-f>' + Object.keys(FIELDS).map(function (k) {
                return '<option value="' + k + '"' + (k === field ? ' selected' : '') + '>' + FIELDS[k].label + '</option>'; }).join('') + '</select>' +
            '<select data-o>' + Object.keys(def.ops).map(function (k) {
                return '<option value="' + k + '"' + (k === op ? ' selected' : '') + '>' + def.ops[k] + '</option>'; }).join('') + '</select>' +
            '<div class="rule-value">' + valueControl(field, cond, lookups) + '</div>' +
            '<button type="button" class="small ghost icon-only" data-del title="Убрать условие">' + Ui.icon('x') + '</button></div>';
    }

    // Нужен ли ввод значения при этой операции (у «задана», «неизвестна» — нет).
    function syncRow(row) {
        const op = row.querySelector('[data-o]').value;
        const v = row.querySelector('[data-v]');
        if (v) v.hidden = op === 'set' || op === 'not_set' || op === 'unknown';
    }

    // Редактор в контейнере. Возвращает { rules(), onChange(fn) }.
    function editor(box, rules, lookups) {
        rules = rules || { match: 'all', conditions: [{ field: 'store', op: 'is' }] };
        box.innerHTML =
            '<label style="margin-bottom:4px">В группу попадают кассы, у которых выполняются' +
            '<select data-match style="margin-top:4px"><option value="all">все условия (И)</option><option value="any">хотя бы одно условие (ИЛИ)</option></select></label>' +
            '<div class="rules-list"></div>' +
            '<button type="button" class="small" data-add>' + Ui.icon('plus') + 'Условие</button>';
        const list = box.querySelector('.rules-list');
        box.querySelector('[data-match]').value = rules.match === 'any' ? 'any' : 'all';
        list.innerHTML = rules.conditions.map(function (c) { return rowHtml(c, lookups); }).join('');
        list.querySelectorAll('.rule-row').forEach(syncRow);

        let listener = null;
        function changed() { if (listener) listener(); }

        box.addEventListener('change', function (e) {
            const row = e.target.closest('.rule-row');
            if (row && e.target.matches('[data-f]')) {
                const tmp = document.createElement('div');
                tmp.innerHTML = rowHtml({ field: e.target.value }, lookups);
                row.replaceWith(tmp.firstChild);
                list.querySelectorAll('.rule-row').forEach(syncRow);
            } else if (row) {
                syncRow(row);
            }
            changed();
        });
        box.addEventListener('input', function (e) { if (e.target.matches('input')) changed(); });
        box.addEventListener('click', function (e) {
            if (e.target.closest('[data-add]')) {
                list.insertAdjacentHTML('beforeend', rowHtml({ field: 'hostname', op: 'contains' }, lookups));
                list.querySelectorAll('.rule-row').forEach(syncRow);
                changed();
            }
            const del = e.target.closest('[data-del]');
            if (del) { del.closest('.rule-row').remove(); changed(); }
        });

        return {
            rules: function () {
                return {
                    match: box.querySelector('[data-match]').value,
                    conditions: [...list.querySelectorAll('.rule-row')].map(function (row) {
                        const c = { field: row.querySelector('[data-f]').value, op: row.querySelector('[data-o]').value };
                        const v = row.querySelector('[data-v]');
                        const n = row.querySelector('[data-n]');
                        c.value = v ? v.value.trim() : '';
                        if (n) c.name = n.value.trim();
                        return c;
                    }),
                };
            },
            onChange: function (fn) { listener = fn; },
        };
    }

    // Правила словами: «Магазин это «Центральный» И версия агента ниже 0.2.0».
    function describe(rules, lookups) {
        if (!rules || !rules.conditions) return '—';
        const name = function (items, id) {
            const it = (items || []).find(function (x) { return String(x.id) === String(id); });
            return it ? '«' + it.name + '»' : '#' + id;
        };
        return rules.conditions.map(function (c) {
            const def = FIELDS[c.field];
            if (!def) return '?';
            const op = def.ops[c.op] || c.op;
            let value = c.value;
            if (def.input === 'stores') value = name(lookups.stores, c.value);
            if (def.input === 'deviceTypes') value = name(lookups.deviceTypes, c.value);
            if (def.input === 'groups') value = name(lookups.groups, c.value);
            if (def.input === 'status') value = STATUS[c.value] || c.value;
            if (def.input === 'yesno') return def.label.toLowerCase() + ': ' + (c.value === '0' ? 'нет' : 'да');
            if (def.input === 'variable') return 'переменная ' + c.name + ' ' + op + (c.op === 'set' || c.op === 'not_set' ? '' : ' «' + c.value + '»');
            if (c.op === 'unknown') return def.label.toLowerCase() + ' ' + op;
            return def.label.toLowerCase() + ' ' + (op === '—' ? '' : op + ' ') + (def.input === 'text' ? '«' + value + '»' : value);
        }).join(rules.match === 'any' ? ' ИЛИ ' : ' И ');
    }

    return { editor: editor, describe: describe, ERRORS: ERRORS };
})();
