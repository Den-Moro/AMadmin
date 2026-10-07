// Мини-Wiki: дерево разделов и статей слева, справа — главная Wiki, статья, редактор или
// результаты поиска. Адрес страницы отражает, что открыто (?a=статья, ?s=раздел,
// ?edit=1), поэтому ссылку на статью можно отправить коллеге, а «Назад» в браузере работает.
(async function () {
    const me = await requireAdminAuth();
    const canDelete = me.role === 'administrator' || me.role === 'superadmin';
    const $ = Ui.$, esc = Ui.escapeHtml;

    $('newSectionBtn').innerHTML = Ui.icon('folder') + 'Раздел';
    $('newArticleBtn').innerHTML = Ui.icon('plus') + 'Статья';
    $('searchIcon').outerHTML = Ui.icon('search');

    let sections = [], articles = [];
    let current = null;          // открытая статья {id, …, body}
    let currentSection = null;   // id раздела, если открыт раздел
    let leaveGuard = null;       // редактор с несохранёнными правками: () => true
    const collapsed = new Set(JSON.parse(localStorage.getItem('amadmin-wiki-collapsed') || '[]'));

    // ---- Данные и дерево -------------------------------------------------------------------

    async function loadTree() {
        const d = await Api.get('/admin/wiki');
        sections = d.sections;
        articles = d.articles;
        renderTree();
    }

    function childrenOf(parentId) {
        return sections.filter(function (s) { return String(s.parent_id || '') === String(parentId || ''); });
    }
    function articlesOf(sectionId) {
        return articles.filter(function (a) { return String(a.section_id || '') === String(sectionId || ''); });
    }
    function countDeep(sectionId) {
        return articlesOf(sectionId).length + childrenOf(sectionId).reduce(function (n, c) { return n + countDeep(c.id); }, 0);
    }
    function sectionPath(sectionId) {
        const path = [];
        let s = sections.find(function (x) { return String(x.id) === String(sectionId); });
        while (s) {
            path.unshift(s);
            const pid = s.parent_id;
            s = pid ? sections.find(function (x) { return String(x.id) === String(pid); }) : null;
        }
        return path;
    }

    function renderTree() {
        function sec(s) {
            return '<div class="tree-sec' + (collapsed.has(String(s.id)) ? ' collapsed' : '') + '" data-sec="' + s.id + '">' +
                '<div class="tree-sec-head" data-toggle="' + s.id + '" title="Нажмите, чтобы свернуть или развернуть; двойной клик — открыть раздел">' +
                    '<svg class="icon caret" viewBox="0 0 24 24"><path d="m6 9 6 6 6-6"/></svg>' +
                    '<span class="name">' + esc(s.name) + '</span><span class="cnt">' + countDeep(s.id) + '</span>' +
                    '<button type="button" class="sec-more small" data-sec-more="' + s.id + '" title="Раздел: открыть, статья в разделе, подраздел, переименовать, удалить" aria-label="Действия с разделом">⋯</button>' +
                '</div>' +
                '<div class="tree-children">' + childrenOf(s.id).map(sec).join('') + articlesOf(s.id).map(art).join('') + '</div></div>';
        }
        function art(a) {
            return '<a class="tree-art' + (current && current.id == a.id ? ' active' : '') + '" href="?a=' + a.id + '" data-art="' + a.id + '" title="' + esc(a.title) + '">' + esc(a.title) + '</a>';
        }
        const loose = articlesOf(null);
        $('tree').innerHTML = (childrenOf(null).map(sec).join('') +
            (loose.length ? '<div class="tree-sec" data-sec=""><div class="tree-sec-head"><span class="name muted">Без раздела</span><span class="cnt">' + loose.length + '</span></div>' +
                '<div class="tree-children">' + loose.map(art).join('') + '</div></div>' : '')) ||
            '<p class="muted" style="padding:8px">Пока пусто. Создайте раздел и первую статью.</p>';
    }

    $('tree').addEventListener('click', async function (e) {
        const more = e.target.closest('[data-sec-more]');
        if (more) { e.stopPropagation(); sectionMenu(more, more.dataset.secMore); return; }
        const art = e.target.closest('[data-art]');
        if (art) { e.preventDefault(); go({ a: art.dataset.art }); return; }
        const head = e.target.closest('[data-toggle]');
        if (head) {
            const id = head.dataset.toggle;
            if (collapsed.has(id)) collapsed.delete(id); else collapsed.add(id);
            try { localStorage.setItem('amadmin-wiki-collapsed', JSON.stringify([...collapsed])); } catch (err) { /* — */ }
            head.parentElement.classList.toggle('collapsed');
        }
    });
    $('tree').addEventListener('dblclick', function (e) {
        const head = e.target.closest('[data-toggle]');
        if (head) go({ s: head.dataset.toggle });
    });

    async function sectionMenu(anchor, id) {
        const s = sections.find(function (x) { return String(x.id) === String(id); });
        const act = await Ui.menu(anchor, [
            { label: 'Открыть раздел', value: 'open' },
            { label: 'Новая статья в разделе', value: 'article' },
            { label: 'Подраздел…', value: 'sub' },
            { label: 'Переименовать или переместить…', value: 'edit' },
        ].concat(canDelete ? [{ label: 'Удалить раздел…', value: 'delete', danger: true }] : []));
        if (act === 'open') go({ s: id });
        if (act === 'article') go({ edit: 1, s: id });
        if (act === 'sub') editSection(null, id);
        if (act === 'edit') editSection(s);
        if (act === 'delete') {
            const n = countDeep(id);
            if (!await Ui.confirm('Удалить раздел «' + s.name + '» вместе с подразделами?' + (n ? ' Статьи (' + n + ') не пропадут — переедут в раздел выше.' : ''), { danger: true, okLabel: 'Удалить' })) return;
            try { await Api.request('DELETE', '/admin/wiki/sections/' + id); Ui.toast('Раздел удалён', 'success'); await loadTree(); route(); }
            catch (err) { Ui.toast('Не удалось: ' + Ui.reason(err), 'error'); }
        }
    }

    function sectionOptions(selected, excludeId) {
        const out = ['<option value="">— без раздела —</option>'];
        function walk(parentId, depth) {
            childrenOf(parentId).forEach(function (s) {
                if (excludeId && String(s.id) === String(excludeId)) return; // раздел не может быть внутри себя
                out.push('<option value="' + s.id + '"' + (String(s.id) === String(selected || '') ? ' selected' : '') + '>' + '  '.repeat(depth) + esc(s.name) + '</option>');
                walk(s.id, depth + 1);
            });
        }
        walk(null, 0);
        return out.join('');
    }

    async function editSection(s, parentId) {
        const ok = await Ui.modal({
            title: s ? 'Раздел «' + s.name + '»' : 'Новый раздел',
            body: '<label>Название<input type="text" id="secName" value="' + esc(s ? s.name : '') + '" placeholder="Например: Кассовое оборудование"></label>' +
                '<label>Внутри раздела<span class="hint">Пусто — раздел верхнего уровня. Вложенность любая: «Оборудование → Принтеры чеков».</span>' +
                '<select id="secParent">' + sectionOptions(s ? s.parent_id : parentId, s ? s.id : null) + '</select></label><p class="error modal-error"></p>',
            buttons: [{ label: 'Отмена', value: null }, { label: s ? 'Сохранить' : 'Создать', value: 'submit', kind: 'primary' }],
            errors: { name_required: 'укажите название', section_cycle: 'раздел нельзя вложить в самого себя' },
            onSubmit: async function (root) {
                const body = { name: root.querySelector('#secName').value.trim(), parent_id: root.querySelector('#secParent').value || null };
                if (!body.name) { root.querySelector('.modal-error').textContent = 'Укажите название.'; return false; }
                if (s) { await Api.request('PUT', '/admin/wiki/sections/' + s.id, body); return true; }
                return (await Api.post('/admin/wiki/sections', body)).id;
            },
        });
        if (ok) { Ui.toast('Раздел сохранён', 'success'); await loadTree(); if (ok !== true) go({ s: ok }); }
    }
    $('newSectionBtn').addEventListener('click', function () { editSection(null, currentSection || (current && current.section_id)); });
    $('newArticleBtn').addEventListener('click', function () { go({ edit: 1, s: currentSection || (current && current.section_id) || '' }); });

    // ---- Навигация -------------------------------------------------------------------------

    async function go(params) {
        if (leaveGuard && leaveGuard() && !await Ui.confirm('В статье есть несохранённые изменения. Уйти без сохранения?', { okLabel: 'Уйти', danger: true })) return;
        leaveGuard = null;
        window.onbeforeunload = null;
        const qs = new URLSearchParams();
        Object.keys(params).forEach(function (k) { if (params[k] !== null && params[k] !== undefined && params[k] !== '') qs.set(k, params[k]); });
        history.pushState(null, '', '/admin/wiki' + (qs.toString() ? '?' + qs : ''));
        route();
    }
    window.addEventListener('popstate', route);

    async function route() {
        const qs = new URLSearchParams(location.search);
        currentSection = qs.get('s');
        if (qs.get('q')) { $('search').value = qs.get('q'); return doSearch(qs.get('q')); }
        if (qs.get('edit') && !qs.get('a')) return showEditor(null, qs.get('s'), qs.get('title'));
        if (qs.get('a')) {
            try { current = await Api.get('/admin/wiki/articles/' + qs.get('a')); }
            catch (e) { current = null; $('view').innerHTML = Ui.emptyState({ icon: 'book', title: 'Статья не найдена', text: 'Возможно, её удалили.' }); renderTree(); return; }
            currentSection = current.section_id;
            renderTree();
            return qs.get('edit') ? showEditor(current) : showArticle(current);
        }
        current = null;
        renderTree();
        return qs.get('s') ? showSection(qs.get('s')) : showHome();
    }

    function resolveLink(title) {
        const a = articles.find(function (x) { return x.title.toLowerCase() === title.trim().toLowerCase(); });
        return a ? { href: '?a=' + a.id } : null;
    }

    function crumbs(sectionId) {
        return '<div class="wiki-crumbs"><a href="/admin/wiki" data-go="home">Wiki</a>' + sectionPath(sectionId).map(function (s) {
            return ' / <a href="?s=' + s.id + '" data-go-sec="' + s.id + '">' + esc(s.name) + '</a>';
        }).join('') + '</div>';
    }

    // ---- Главная, раздел, статья ------------------------------------------------------------

    function showHome() {
        const recent = articles.slice().sort(function (a, b) { return String(b.updated_at).localeCompare(String(a.updated_at)); }).slice(0, 8);
        $('view').innerHTML = (articles.length || sections.length
            ? '<div class="section-head" style="margin-top:0"><h2>Разделы</h2></div><div class="home-grid">' +
                childrenOf(null).map(function (s) {
                    const arts = articlesOf(s.id).slice(0, 6);
                    return '<div class="home-sec"><h3><a href="?s=' + s.id + '" data-go-sec="' + s.id + '">' + esc(s.name) + '</a><span class="muted" style="font-weight:400;font-size:12px">' + countDeep(s.id) + '</span></h3>' +
                        (childrenOf(s.id).length ? '<div class="muted" style="font-size:12px;margin-bottom:4px">подразделы: ' + childrenOf(s.id).map(function (c) { return esc(c.name); }).join(', ') + '</div>' : '') +
                        (arts.length ? '<ul>' + arts.map(function (a) { return '<li><a href="?a=' + a.id + '" data-go-art="' + a.id + '">' + esc(a.title) + '</a></li>'; }).join('') + '</ul>' : '<span class="muted" style="font-size:13px">пока пусто</span>') + '</div>';
                }).join('') + '</div>' +
              (recent.length ? '<div class="section-head"><h2>Недавно обновлённые</h2></div><div class="hits">' + recent.map(hitHtml).join('') + '</div>' : '')
            : Ui.emptyState({ icon: 'book', title: 'Wiki пока пустая', text: 'Создайте раздел (например, «Кассовое оборудование») и первую статью — инструкцию, которую сейчас каждый раз объясняете заново.' }));
    }

    function hitHtml(a, q) {
        const path = sectionPath(a.section_id).map(function (s) { return s.name; }).join(' / ') || 'Без раздела';
        return '<a class="hit" href="?a=' + a.id + '" data-go-art="' + a.id + '"><b>' + highlight(a.title, q) + '</b>' +
            '<div class="sec">' + esc(path) + (a.updated_at ? ' · обновлено ' + esc(formatServerTime(a.updated_at)) : '') + '</div>' +
            (a.snippet ? '<div class="snip">' + highlight(a.snippet, q) + '</div>' : '') + '</a>';
    }

    function showSection(id) {
        const s = sections.find(function (x) { return String(x.id) === String(id); });
        if (!s) return showHome();
        const subs = childrenOf(id);
        const arts = articlesOf(id);
        $('view').innerHTML = crumbs(s.parent_id) +
            '<div class="art-head"><h1>' + esc(s.name) + '</h1><div class="actions">' +
                '<button type="button" class="small" data-new-in="' + id + '">' + Ui.icon('plus') + 'Статья в разделе</button>' +
                '<button type="button" class="small ghost icon-only" data-sec-more="' + id + '" title="Действия с разделом">⋯</button></div></div>' +
            '<div class="art-meta">' + countDeep(id) + ' ' + Ui.plural(countDeep(id), 'статья', 'статьи', 'статей') + (subs.length ? ' · ' + subs.length + ' ' + Ui.plural(subs.length, 'подраздел', 'подраздела', 'подразделов') : '') + '</div>' +
            (subs.length ? '<div class="home-grid" style="margin-bottom:16px">' + subs.map(function (c) {
                return '<div class="home-sec"><h3><a href="?s=' + c.id + '" data-go-sec="' + c.id + '">' + esc(c.name) + '</a><span class="muted" style="font-weight:400;font-size:12px">' + countDeep(c.id) + '</span></h3></div>';
            }).join('') + '</div>' : '') +
            (arts.length ? '<div class="hits">' + arts.map(function (a) { return hitHtml(a); }).join('') + '</div>'
                : Ui.emptyState({ icon: 'file', title: 'В разделе пока нет статей', text: 'Нажмите «Статья в разделе».' }));
    }

    function showArticle(a) {
        $('view').innerHTML = crumbs(a.section_id) +
            '<div class="art-head"><h1>' + esc(a.title) + '</h1><div class="actions">' +
                '<button type="button" class="small" id="useInNotifBtn" title="Открыть форму оповещения с этой статьёй как инструкцией для кассира">' + Ui.icon('bell') + 'Приложить к оповещению</button>' +
                '<button type="button" class="small primary" id="editArtBtn">' + Ui.icon('sliders') + 'Изменить</button>' +
                '<button type="button" class="small ghost icon-only" id="artMoreBtn" title="Ссылка, удалить">⋯</button></div></div>' +
            '<div class="art-meta">Обновлено ' + esc(formatServerTime(a.updated_at)) + (a.updated_by_name ? ' · ' + esc(a.updated_by_name) : '') +
                (a.created_by_name && a.created_by_name !== a.updated_by_name ? ' · создал ' + esc(a.created_by_name) : '') + '</div>' +
            '<article class="wiki-body">' + (a.body.trim() ? WikiMarkdown.render(a.body, resolveLink) : '<p class="muted">Статья пока пустая — нажмите «Изменить».</p>') + '</article>';
        $('editArtBtn').addEventListener('click', function () { go({ a: a.id, edit: 1 }); });
        $('useInNotifBtn').addEventListener('click', function () { location.href = '/admin/notifications?wiki=' + a.id; });
        $('artMoreBtn').addEventListener('click', async function () {
            const act = await Ui.menu($('artMoreBtn'), [{ label: 'Скопировать ссылку на статью', value: 'link' }]
                .concat(canDelete ? [{ label: 'Удалить статью', value: 'delete', danger: true }] : []));
            if (act === 'link') {
                try { await navigator.clipboard.writeText(location.origin + '/admin/wiki?a=' + a.id); Ui.toast('Ссылка скопирована', 'success'); }
                catch (e) { Ui.toast('Не удалось скопировать', 'error'); }
            }
            if (act === 'delete') {
                if (!await Ui.confirm('Удалить статью «' + a.title + '»? Уже отправленные с ней оповещения не изменятся.', { danger: true, okLabel: 'Удалить' })) return;
                try { await Api.request('DELETE', '/admin/wiki/articles/' + a.id); Ui.toast('Статья удалена', 'success'); await loadTree(); go(a.section_id ? { s: a.section_id } : {}); }
                catch (err) { Ui.toast('Не удалось: ' + Ui.reason(err), 'error'); }
            }
        });
    }

    $('view').addEventListener('click', function (e) {
        const lk = e.target.closest('[data-go-art], [data-go-sec], [data-go], [data-wiki-link], [data-new-in], [data-missing], [data-sec-more]');
        if (lk && lk.dataset.secMore) { sectionMenu(lk, lk.dataset.secMore); return; }
        if (lk && lk.dataset.newIn) { go({ edit: 1, s: lk.dataset.newIn }); return; }
        if (lk && lk.dataset.missing !== undefined) { e.preventDefault(); go({ edit: 1, s: currentSection || '', title: lk.dataset.missing }); return; }
        if (lk && lk.dataset.goArt) { e.preventDefault(); go({ a: lk.dataset.goArt }); return; }
        if (lk && lk.dataset.goSec) { e.preventDefault(); go({ s: lk.dataset.goSec }); return; }
        if (lk && lk.dataset.go === 'home') { e.preventDefault(); $('search').value = ''; go({}); return; }
        if (lk && lk.hasAttribute('data-wiki-link')) { e.preventDefault(); go({ a: new URLSearchParams(lk.getAttribute('href').slice(1)).get('a') }); return; }
        const img = e.target.closest('.wiki-body img');
        if (img) window.open(img.src, '_blank');
    });

    // ---- Редактор ----------------------------------------------------------------------------

    function showEditor(a, sectionId, presetTitle) {
        const isNew = !a;
        $('view').innerHTML = crumbs(a ? a.section_id : sectionId) +
            '<form id="editForm" class="card" style="margin-bottom:0" novalidate>' +
            '<div class="row"><label style="flex:2">Название<input type="text" id="artTitle" value="' + esc(a ? a.title : (presetTitle || '')) + '" placeholder="Например: Не печатает чековый принтер"></label>' +
            '<label>Раздел<select id="artSection">' + sectionOptions(a ? a.section_id : sectionId) + '</select></label></div>' +
            '<div>' +
            '<div class="md-toolbar" id="mdToolbar">' +
                '<button type="button" data-md="h2" title="Заголовок раздела статьи (## текст)">Заголовок</button>' +
                '<button type="button" data-md="b" title="Жирный (**текст**)"><b>Ж</b></button>' +
                '<button type="button" data-md="i" title="Курсив (_текст_)"><i>К</i></button>' +
                '<button type="button" data-md="ul" title="Маркированный список (- пункт)">• Список</button>' +
                '<button type="button" data-md="ol" title="Нумерованный список (1. шаг) — удобно для пошаговых инструкций">1. Шаги</button>' +
                '<button type="button" data-md="quote" title="Выделенная заметка (> текст) — для важного предупреждения">Заметка</button>' +
                '<button type="button" data-md="code" title="Код или команда (`текст`); блок — между строками ```">Код</button>' +
                '<span class="sep"></span>' +
                '<button type="button" data-md="link" title="Ссылка на сайт ([текст](https://…))">Ссылка</button>' +
                '<button type="button" data-md="wiki" title="Ссылка на другую статью Wiki ([[Название статьи]])">Статья Wiki</button>' +
                '<label class="image-add" style="height:auto;padding:4px 9px;font-size:12.5px" title="Вставить картинку. Можно также перетащить файл в текст или вставить скриншот (Ctrl+V)">' +
                    '<input type="file" id="mdImage" accept="image/png,image/jpeg,image/gif,image/bmp" multiple>' + Ui.icon('plus') + 'Картинка</label>' +
            '</div>' +
            '<div class="editor-grid">' +
                '<textarea id="artBody" spellcheck="true" placeholder="Текст статьи. Пошаговая инструкция, скриншоты (Ctrl+V), ссылки на другие статьи [[вот так]].">' + esc(a ? a.body : '') + '</textarea>' +
                '<div class="wiki-body" id="preview" aria-label="Предпросмотр"></div>' +
            '</div></div>' +
            '<p class="error" id="editError"></p>' +
            '<div class="form-actions"><button type="submit" id="saveArtBtn">' + (isNew ? 'Создать статью' : 'Сохранить') + '</button>' +
            '<button type="button" class="ghost" id="cancelEditBtn">Отмена</button>' +
            '<span class="muted" style="font-size:12px">Ctrl+S — сохранить. Справа — как статья будет выглядеть.</span></div></form>';

        const body = $('artBody');
        const preview = function () { $('preview').innerHTML = body.value.trim() ? WikiMarkdown.render(body.value, resolveLink) : '<p class="muted">Здесь появится предпросмотр.</p>'; };
        body.addEventListener('input', preview);
        preview();
        let dirty = false;
        body.addEventListener('input', function () { dirty = true; });
        $('artTitle').addEventListener('input', function () { dirty = true; });
        (isNew ? $('artTitle') : body).focus();

        function wrap(before, after, placeholder) {
            const s = body.selectionStart, e = body.selectionEnd;
            const sel = body.value.slice(s, e) || placeholder;
            body.setRangeText(before + sel + after, s, e, 'end');
            if (!body.value.slice(s, e).length) body.setSelectionRange(s + before.length, s + before.length + sel.length);
            body.focus();
            preview();
            dirty = true;
        }
        // Оформить строки, на которых стоит курсор или выделение, целиком.
        function linePrefix(prefix, numbered) {
            const s = body.selectionStart, e = body.selectionEnd;
            const start = body.value.lastIndexOf('\n', s - 1) + 1;
            const nl = body.value.indexOf('\n', e);
            const end = nl < 0 ? body.value.length : nl;
            const block = body.value.slice(start, end) || 'текст';
            let n = 0;
            const out = block.split('\n').map(function (l) { return (numbered ? (++n) + '. ' : prefix) + l.replace(/^(\s*([-*>]|\d+\.)\s+|#{1,3}\s+)/, ''); }).join('\n');
            body.setRangeText(out, start, end, 'end');
            body.focus();
            preview();
            dirty = true;
        }
        $('mdToolbar').addEventListener('click', function (e) {
            const b = e.target.closest('[data-md]');
            if (!b) return;
            const k = b.dataset.md;
            if (k === 'b') wrap('**', '**', 'жирный текст');
            if (k === 'i') wrap('_', '_', 'курсив');
            if (k === 'code') wrap('`', '`', 'команда');
            if (k === 'h2') linePrefix('## ');
            if (k === 'ul') linePrefix('- ');
            if (k === 'ol') linePrefix('', true);
            if (k === 'quote') linePrefix('> ');
            if (k === 'link') wrap('[', '](https://)', 'текст ссылки');
            if (k === 'wiki') wrap('[[', ']]', 'Название статьи');
        });

        async function insertImages(files) {
            for (const f of files) {
                if (!/^image\//.test(f.type)) continue;
                const mark = '![Загрузка ' + (f.name || 'картинки') + '…]()';
                const pos = body.selectionStart;
                body.setRangeText('\n' + mark + '\n', pos, body.selectionEnd, 'end');
                try {
                    const res = await Ui.uploadFile(f, null, '/admin/media');
                    body.value = body.value.replace(mark, '![' + (f.name && f.name !== 'image.png' ? f.name.replace(/\.[^.]+$/, '') : 'скриншот') + '](/admin/media/' + res.id + ')');
                } catch (err) {
                    body.value = body.value.replace('\n' + mark + '\n', '\n');
                    Ui.toast('Не удалось загрузить картинку: ' + err.message, 'error');
                }
                preview();
                dirty = true;
            }
        }
        $('mdImage').addEventListener('change', function () { insertImages(Array.from(this.files)); this.value = ''; });
        body.addEventListener('paste', function (e) {
            const files = Array.from((e.clipboardData && e.clipboardData.files) || []).filter(function (f) { return /^image\//.test(f.type); });
            if (files.length) { e.preventDefault(); insertImages(files); }
        });
        ['dragenter', 'dragover'].forEach(function (ev) { body.addEventListener(ev, function (e) { if (e.dataTransfer.types.indexOf('Files') >= 0) { e.preventDefault(); body.classList.add('over'); } }); });
        ['dragleave', 'drop'].forEach(function (ev) { body.addEventListener(ev, function () { body.classList.remove('over'); }); });
        body.addEventListener('drop', function (e) { if (e.dataTransfer.files.length) { e.preventDefault(); insertImages(Array.from(e.dataTransfer.files)); } });
        body.addEventListener('keydown', function (e) {
            if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') { e.preventDefault(); $('editForm').requestSubmit(); }
            if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'b') { e.preventDefault(); wrap('**', '**', 'жирный текст'); }
        });

        $('cancelEditBtn').addEventListener('click', async function () {
            if (dirty && !await Ui.confirm('Выйти без сохранения? Изменения пропадут.', { okLabel: 'Выйти', danger: true })) return;
            dirty = false;
            if (a) go({ a: a.id }); else go(sectionId ? { s: sectionId } : {});
        });
        $('editForm').addEventListener('submit', async function (e) {
            e.preventDefault();
            const payload = { title: $('artTitle').value.trim(), body: body.value, section_id: $('artSection').value || null };
            if (!payload.title) { $('editError').textContent = 'Укажите название статьи.'; $('artTitle').focus(); return; }
            $('saveArtBtn').disabled = true;
            try {
                let id = a && a.id;
                if (a) await Api.request('PUT', '/admin/wiki/articles/' + a.id, payload);
                else id = (await Api.post('/admin/wiki/articles', payload)).id;
                dirty = false;
                Ui.toast('Статья сохранена', 'success');
                await loadTree();
                go({ a: id });
            } catch (err) {
                $('editError').textContent = 'Не удалось сохранить: ' + Ui.reason(err, { title_required: 'укажите название', section_not_found: 'раздел не найден — возможно, его удалили' });
                $('saveArtBtn').disabled = false;
            }
        });
        window.onbeforeunload = function () { return dirty ? 'Есть несохранённые изменения' : undefined; };
        leaveGuard = function () { return dirty; };
    }

    // ---- Поиск -------------------------------------------------------------------------------

    function highlight(text, q) {
        const safe = esc(text);
        if (!q) return safe;
        const words = q.trim().split(/\s+/).filter(function (w) { return w.length > 1; }).map(function (w) { return w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); });
        return words.length ? safe.replace(new RegExp('(' + words.join('|') + ')', 'gi'), '<mark>$1</mark>') : safe;
    }

    let searchTimer = null, searchSeq = 0;
    async function doSearch(q) {
        q = q.trim();
        if (q.length < 2) return route();
        const my = ++searchSeq;
        const hits = await Api.get('/admin/wiki/search?q=' + encodeURIComponent(q));
        if (my !== searchSeq) return;
        current = null;
        renderTree();
        $('view').innerHTML = '<div class="section-head" style="margin-top:0"><h2>Поиск: «' + esc(q) + '»</h2><span class="muted">' + hits.length + ' ' + Ui.plural(hits.length, 'статья', 'статьи', 'статей') + '</span></div>' +
            (hits.length ? '<div class="hits">' + hits.map(function (h) { return hitHtml(h, q); }).join('') + '</div>'
                : Ui.emptyState({ icon: 'search', title: 'Ничего не найдено', text: 'Попробуйте другое слово или создайте статью на эту тему.', action: { label: 'Создать статью «' + q + '»', id: 'createFromSearch' } }));
        const btn = document.getElementById('createFromSearch');
        if (btn) btn.addEventListener('click', function () { go({ edit: 1, title: q }); });
    }
    $('search').addEventListener('input', function () {
        clearTimeout(searchTimer);
        const q = $('search').value;
        searchTimer = setTimeout(function () {
            if (q.trim().length >= 2) { history.replaceState(null, '', '/admin/wiki?q=' + encodeURIComponent(q.trim())); doSearch(q); }
            else if (!q.trim() && new URLSearchParams(location.search).get('q')) go({});
        }, 200);
    });
    $('search').addEventListener('keydown', function (e) {
        if (e.key === 'Escape') { $('search').value = ''; go({}); }
        if (e.key === 'Enter') { const first = document.querySelector('#view .hit'); if (first) first.click(); }
    });
    document.addEventListener('keydown', function (e) {
        if (e.key === '/' && !/INPUT|TEXTAREA|SELECT/.test(document.activeElement.tagName)) { e.preventDefault(); $('search').focus(); $('search').select(); }
    });

    await loadTree();
    await route();
})();
