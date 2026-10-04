// Общие для страниц «Магазины» и «Магазин» окна: создать/изменить магазин и перевести
// кассы в другой магазин. Разрешаются true, если что-то сохранили.
const StoreDialogs = (function () {
    const esc = Ui.escapeHtml;
    const ERRORS = {
        subnets_invalid: 'подсеть — в виде 192.168.5.0/24, несколько — через запятую',
        store_not_found: 'магазин не найден', pc_ids_required: 'не выбрано ни одной кассы',
    };

    function edit(store) {
        return Ui.modal({
            title: store ? 'Магазин «' + store.name + '»' : 'Новый магазин',
            body:
                '<label>Название<input type="text" id="stName" value="' + esc(store ? store.name : '') + '" placeholder="Магазин №12 (Ленина, 5)"></label>' +
                '<label><input type="checkbox" id="stPilot"' + (store && +store.is_pilot ? ' checked' : '') + '> Пилотный магазин' +
                '<span class="hint">Сюда отправляют новое раньше остальных — обкатать оповещение, команду или новую версию агента.</span></label>' +
                '<label>Подсети магазина (необязательно)' +
                '<span class="hint">Локальная сеть касс этого магазина, например 192.168.5.0/24; несколько — через запятую. По IP кассы панель подскажет, ' +
                'какие кассы на самом деле стоят здесь, и разложит их по кнопке. Сама ничего не переносит.</span>' +
                '<input type="text" id="stSubnets" class="mono" value="' + esc(store && store.subnets || '') + '" placeholder="192.168.5.0/24" spellcheck="false"></label>' +
                '<div class="row"><label>Свой бренд в оповещениях<span class="hint">Название компании в окне оповещения у касс этого магазина. Пусто — общее из Настроек.</span>' +
                '<input type="text" id="stBrandName" value="' + esc(store && store.brand_name || '') + '" placeholder="как в Настройках"></label>' +
                '<label>Свой контакт<span class="hint">Телефон поддержки для касс этого магазина. Пусто — общий из Настроек.</span>' +
                '<input type="text" id="stBrandContact" value="' + esc(store && store.brand_contact || '') + '" placeholder="как в Настройках"></label></div>' +
                '<p class="error modal-error"></p>',
            buttons: [{ label: 'Отмена', value: null }, { label: store ? 'Сохранить' : 'Создать', value: 'submit', kind: 'primary' }],
            errors: ERRORS,
            onSubmit: async function (root) {
                const body = {
                    name: root.querySelector('#stName').value.trim(), is_pilot: root.querySelector('#stPilot').checked ? 1 : 0,
                    subnets: root.querySelector('#stSubnets').value.trim(),
                    brand_name: root.querySelector('#stBrandName').value.trim(), brand_contact: root.querySelector('#stBrandContact').value.trim(),
                };
                if (!body.name) { root.querySelector('.modal-error').textContent = 'Введите название.'; return false; }
                if (store) await Api.request('PUT', '/admin/stores/' + store.id, body);
                else return (await Api.post('/admin/stores', body)).id;
                return true;
            },
        });
    }

    // Перевести кассы pcIds в другой магазин (выбор магазина — в окне).
    async function move(pcIds, exceptStoreId) {
        const stores = (await Api.get('/admin/stores')).filter(function (s) { return String(s.id) !== String(exceptStoreId); });
        if (!stores.length) { Ui.toast('Других магазинов нет — сначала создайте магазин', 'error'); return false; }
        const ok = await Ui.modal({
            title: 'Перевести ' + pcIds.length + ' ' + Ui.plural(pcIds.length, 'кассу', 'кассы', 'касс') + ' в магазин',
            body: '<label>Магазин<span class="hint">У кассы меняется только магазин: ключ, группы и история остаются. Оповещения и команды «магазину» она начнёт получать по новому магазину со следующего опроса.</span>' +
                '<select id="mvStore">' + stores.map(function (s) {
                    return '<option value="' + s.id + '">' + esc(s.name) + ' (' + s.pc_count + ' ' + Ui.plural(s.pc_count, 'касса', 'кассы', 'касс') + ')</option>';
                }).join('') + '</select></label><p class="error modal-error"></p>',
            buttons: [{ label: 'Отмена', value: null }, { label: 'Перевести', value: 'submit', kind: 'primary' }],
            errors: ERRORS,
            onSubmit: async function (root) {
                const r = await Api.post('/admin/pcs/move', { pc_ids: pcIds, store_id: root.querySelector('#mvStore').value });
                const name = root.querySelector('#mvStore').selectedOptions[0].textContent.replace(/ \(\d+.*\)$/, '');
                Ui.toast('Переведено в «' + name + '»: ' + r.moved, 'success');
                return true;
            },
        });
        return !!ok;
    }

    return { edit: edit, move: move, ERRORS: ERRORS };
})();
