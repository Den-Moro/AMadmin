(async function () {
    await requireAdminAuth();


    function escapeHtml(s) {
        const div = document.createElement('div');
        div.textContent = s == null ? '' : String(s);
        return div.innerHTML;
    }

    function truncate(s, n) {
        return s.length > n ? s.slice(0, n) + '…' : s;
    }

    async function loadManuals() {
        const rows = await Api.get('/admin/manuals');
        const tbody = document.querySelector('#manualsTable tbody');
        tbody.innerHTML = '';
        rows.forEach(function (m) {
            const tr = document.createElement('tr');
            tr.innerHTML =
                '<td>' + escapeHtml(m.title) + '</td>' +
                '<td>' + escapeHtml(truncate(m.url_or_text, 60)) + '</td>' +
                '<td>' + escapeHtml(formatServerTime(m.updated_at)) + '</td>' +
                '<td>' +
                '<button type="button" data-edit="' + m.id + '">Редактировать</button> ' +
                '<button type="button" data-delete="' + m.id + '">Удалить</button>' +
                '</td>';
            tr.dataset.title = m.title;
            tr.dataset.text = m.url_or_text;
            tbody.appendChild(tr);
        });
    }

    document.querySelector('#manualsTable').addEventListener('click', async function (e) {
        const editId = e.target.getAttribute('data-edit');
        const deleteId = e.target.getAttribute('data-delete');

        if (editId) {
            const tr = e.target.closest('tr');
            document.getElementById('editId').value = editId;
            document.getElementById('title').value = tr.dataset.title;
            document.getElementById('urlOrText').value = tr.dataset.text;
            document.getElementById('formTitle').textContent = 'Редактирование мануала';
            document.getElementById('submitBtn').textContent = 'Сохранить изменения';
            document.getElementById('cancelEditBtn').style.display = '';
        }

        if (deleteId) {
            if (!confirm('Удалить мануал из библиотеки?')) {
                return;
            }
            await Api.request('DELETE', '/admin/manuals/' + deleteId);
            await loadManuals();
        }
    });

    function resetForm() {
        document.getElementById('manualForm').reset();
        document.getElementById('editId').value = '';
        document.getElementById('formTitle').textContent = 'Новый мануал';
        document.getElementById('submitBtn').textContent = 'Сохранить';
        document.getElementById('cancelEditBtn').style.display = 'none';
    }

    document.getElementById('cancelEditBtn').addEventListener('click', resetForm);

    document.getElementById('manualForm').addEventListener('submit', async function (e) {
        e.preventDefault();
        const errorEl = document.getElementById('error');
        errorEl.textContent = '';

        const editId = document.getElementById('editId').value;
        const body = {
            title: document.getElementById('title').value,
            url_or_text: document.getElementById('urlOrText').value,
        };

        try {
            if (editId) {
                await Api.request('PUT', '/admin/manuals/' + editId, body);
            } else {
                await Api.post('/admin/manuals', body);
            }
            resetForm();
            await loadManuals();
        } catch (err) {
            errorEl.textContent = 'Не удалось сохранить мануал.';
        }
    });

    await loadManuals();
})();
