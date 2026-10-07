// Простая разметка статей Wiki (подмножество Markdown) -> HTML. Безопасно: весь текст
// сначала экранируется, HTML из статьи не исполняется никогда; ссылки и картинки —
// только http(s) и свои адреса /admin/... .
//   # Заголовок, ## Подзаголовок, ### Мелкий        **жирный**, _курсив_, `код`
//   - пункт / 1. пункт                                > заметка (выделенный блок)
//   ```                                               [текст](https://…)
//   блок кода                                         ![подпись](/admin/media/12)
//   ```                                               [[Название другой статьи]]
//   ---  — разделитель
const WikiMarkdown = (function () {
    function esc(s) {
        return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
    }
    function safeUrl(u) {
        u = u.trim();
        return /^(https?:\/\/|\/admin\/|#|\?)/i.test(u) ? u : null;
    }

    // resolveLink(title) -> {href} | null — для [[ссылок на статьи]].
    function inline(text, resolveLink) {
        // Коды вырезаем первыми, чтобы их содержимое не трогала остальная разметка.
        const codes = [];
        text = text.replace(/`([^`]+)`/g, function (m, c) { codes.push(c); return '\u0000' + (codes.length - 1) + '\u0000'; });
        text = esc(text);
        text = text.replace(/!\[([^\]]*)\]\(([^)\s]+)\)/g, function (m, alt, url) {
            const u = safeUrl(url.replace(/&amp;/g, '&'));
            return u ? '<img src="' + esc(u) + '" alt="' + alt + '" loading="lazy">' : m;
        });
        text = text.replace(/\[\[([^\]]+)\]\]/g, function (m, title) {
            const t = resolveLink ? resolveLink(title.replace(/&amp;/g, '&').replace(/&quot;/g, '"')) : null;
            return t ? '<a href="' + esc(t.href) + '" data-wiki-link>' + title + '</a>'
                : '<a href="#" class="missing" data-missing="' + title + '" title="Такой статьи нет — нажмите, чтобы создать">' + title + '</a>';
        });
        text = text.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, function (m, label, url) {
            const u = safeUrl(url.replace(/&amp;/g, '&'));
            if (!u) return m;
            const ext = /^https?:/i.test(u);
            return '<a href="' + esc(u) + '"' + (ext ? ' target="_blank" rel="noopener"' : '') + '>' + label + '</a>';
        });
        // Голые адреса — ссылками; точка/запятая в конце предложения к адресу не относятся.
        text = text.replace(/(^|[\s(])(https?:\/\/[^\s<]+?)(?=[.,!?:;)]*(?:\s|$))/g, function (m, pre, url) {
            return pre + '<a href="' + url + '" target="_blank" rel="noopener">' + url + '</a>';
        });
        text = text.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
        text = text.replace(/(^|[\s(])_([^_]+)_(?=[\s).,!?:;]|$)/g, '$1<em>$2</em>');
        return text.replace(/\u0000(\d+)\u0000/g, function (m, i) { return '<code>' + esc(codes[+i]) + '</code>'; });
    }

    function render(src, resolveLink) {
        const lines = String(src || '').replace(/\r\n?/g, '\n').split('\n');
        const out = [];
        let para = [], list = null, quote = [];
        function flushPara() { if (para.length) { out.push('<p>' + para.map(function (l) { return inline(l, resolveLink); }).join('<br>') + '</p>'); para = []; } }
        function flushList() { if (list) { out.push('<' + list.tag + '>' + list.items.map(function (i) { return '<li>' + inline(i, resolveLink) + '</li>'; }).join('') + '</' + list.tag + '>'); list = null; } }
        function flushQuote() { if (quote.length) { out.push('<blockquote>' + quote.map(function (l) { return inline(l, resolveLink); }).join('<br>') + '</blockquote>'); quote = []; } }
        function flushAll() { flushPara(); flushList(); flushQuote(); }

        for (let i = 0; i < lines.length; i++) {
            const line = lines[i];
            if (/^```/.test(line)) {
                flushAll();
                const code = [];
                for (i++; i < lines.length && !/^```/.test(lines[i]); i++) code.push(lines[i]);
                out.push('<pre><code>' + esc(code.join('\n')) + '</code></pre>');
                continue;
            }
            let m;
            if ((m = /^(#{1,3})\s+(.*)$/.exec(line))) { flushAll(); out.push('<h' + (m[1].length + 1) + '>' + inline(m[2], resolveLink) + '</h' + (m[1].length + 1) + '>'); continue; }
            if (/^\s*(-{3,}|\*{3,})\s*$/.test(line)) { flushAll(); out.push('<hr>'); continue; }
            if ((m = /^\s*[-*]\s+(.*)$/.exec(line))) { flushPara(); flushQuote(); if (!list || list.tag !== 'ul') { flushList(); list = { tag: 'ul', items: [] }; } list.items.push(m[1]); continue; }
            if ((m = /^\s*\d+[.)]\s+(.*)$/.exec(line))) { flushPara(); flushQuote(); if (!list || list.tag !== 'ol') { flushList(); list = { tag: 'ol', items: [] }; } list.items.push(m[1]); continue; }
            if ((m = /^>\s?(.*)$/.exec(line))) { flushPara(); flushList(); quote.push(m[1]); continue; }
            if (!line.trim()) { flushAll(); continue; }
            flushList(); flushQuote();
            para.push(line);
        }
        flushAll();
        return out.join('\n');
    }

    return { render: render, escape: esc };
})();
