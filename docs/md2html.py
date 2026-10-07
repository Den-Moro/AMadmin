"""Пересобирает HTML-версии документации из Markdown.

Каждый docs/<ИМЯ>.html — готовая страница со своим оформлением (шапка, стили); скрипт
заменяет в ней только тело (между '<div class="card">' и '</div></main>') на свежий
рендер docs/<ИМЯ>.md. Оформление правится в самом .html, текст — только в .md.

Запуск (нужен Python 3 и пакет markdown: pip install markdown):
    python docs/md2html.py              # все три: ADMIN, INSTALL, INSTRUCTIONS
    python docs/md2html.py ADMIN        # одну
"""
import os
import re
import sys

import markdown

DOCS = os.path.dirname(os.path.abspath(__file__))
NAMES = ('ADMIN', 'INSTALL', 'INSTRUCTIONS')
START = '    <div class="card">\n'
END = '    </div>\n</main>'


def render(md_text):
    html = markdown.markdown(md_text, extensions=['tables', 'fenced_code'])
    # Соседние документы опубликованы как .html; текст ссылки на файл выше — без "../".
    html = re.sub(r'href="(INSTALL|ADMIN|INSTRUCTIONS)\.md(#[^"]*)?"', r'href="\1.html\2"', html)
    html = re.sub(r'>\.\./([A-Za-z_]+\.md)</a>', r'>\1</a>', html)
    return html + '\n'


def rebuild(name):
    md_path = os.path.join(DOCS, name + '.md')
    html_path = os.path.join(DOCS, name + '.html')
    with open(html_path, encoding='utf-8', newline='') as f:
        html_text = f.read()
    crlf = '\r\n' in html_text
    html_text = html_text.replace('\r\n', '\n')
    i = html_text.index(START) + len(START)
    j = html_text.index(END)
    with open(md_path, encoding='utf-8') as f:
        body = render(f.read())
    out = html_text[:i] + body + html_text[j:]
    if crlf:
        out = out.replace('\n', '\r\n')
    with open(html_path, 'w', encoding='utf-8', newline='') as f:
        f.write(out)
    print('written', os.path.relpath(html_path))


if __name__ == '__main__':
    for n in (sys.argv[1:] or NAMES):
        rebuild(n.upper())
