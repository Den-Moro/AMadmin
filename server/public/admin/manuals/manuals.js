(async function () {
    await requireAdminAuth();
    const $ = Ui.$, esc = Ui.escapeHtml;
    let manuals = [];

    function truncate(s, n) { return s.length > n ? s.slice(0, n) + '…' : s; }

    function manualForm(m) {
        return Ui.modal({
            title: m ? 'Мануал «' + m.title + '»' : 'Новый мануал',
            body:
                '<label>Название<input type="text" id="mTitle" value="' + esc(m ? m.title : '') + '" placeholder="например, Перезагрузка кассы"></label>' +
                '<label>Текст или ссылка<span class="hint">Шаги по пунктам простым языком — или ссылка, она откроется в браузере на кассе.</span>' +
                '<textarea id="mText" rows="7">' + esc(m ? m.url_or_text : '') + '</textarea></label>' +
                '<p class="error modal-error"></p>',
            buttons: [{ label: 'Отмена', value: null }, { label: 'Сохранить', value: 'submit', kind: 'primary' }],
            submitOnEnter: false,
            onSubmit: async function (root) {
                const body = { title: root.querySelector('#mTitle').value.trim(), url_or_text: root.querySelector('#mText').value.trim() };
                if (!body.title || !body.url_or_text) { root.querySelector('.modal-error').textContent = 'Заполните название и текст.'; return false; }
                if (m) await Api.request('PUT', '/admin/manuals/' + m.id, body);
                else await Api.post('/admin/manuals', body);
            },
        }).then(function (v) { if (v) { Ui.toast('Сохранено', 'success'); loadManuals(); } });
    }

    async function loadManuals() {
        manuals = await Api.get('/admin/manuals');
        const q = $('search').value.toLowerCase();
        const tbody = document.querySelector('#manualsTable tbody');
        tbody.innerHTML = '';
        const visible = manuals.filter(function (m) { return !q || (m.title + ' ' + m.url_or_text).toLowerCase().indexOf(q) >= 0; });
        if (!visible.length) {
            tbody.innerHTML = '<tr><td colspan="4" class="empty">Мануалов пока нет.</td></tr>';
            return;
        }
        visible.forEach(function (m) {
            const tr = document.createElement('tr');
            tr.dataset.id = m.id;
            tr.innerHTML =
                '<td><b>' + esc(m.title) + '</b></td>' +
                '<td class="muted">' + esc(truncate(m.url_or_text, 90)) + '</td>' +
                '<td class="muted" style="white-space:nowrap">' + esc(formatServerTime(m.updated_at)) + '</td>' +
                '<td><div class="actions"><button type="button" data-act="edit">Изменить</button>' +
                '<button type="button" data-act="delete" class="danger">Удалить</button></div></td>';
            tbody.appendChild(tr);
        });
    }

    document.querySelector('#manualsTable').addEventListener('click', async function (e) {
        const btn = e.target.closest('button[data-act]');
        if (!btn) return;
        const m = manuals.find(function (x) { return String(x.id) === btn.closest('tr').dataset.id; });
        if (btn.dataset.act === 'edit') manualForm(m);
        if (btn.dataset.act === 'delete') {
            if (!await Ui.confirm('Удалить мануал «' + m.title + '»? Уже отправленные оповещения не изменятся.', { danger: true, okLabel: 'Удалить' })) return;
            try { await Api.request('DELETE', '/admin/manuals/' + m.id); Ui.toast('Удалено', 'success'); loadManuals(); }
            catch (err) { Ui.toast('Не удалось: ' + Ui.reason(err), 'error'); }
        }
    });

    $('addBtn').addEventListener('click', function () { manualForm(null); });
    $('search').addEventListener('input', loadManuals);

    await loadManuals();
    setInterval(function () { if (!document.hidden) loadManuals(); }, 30000);
})();
