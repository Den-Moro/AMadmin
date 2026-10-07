<?php

// Мини-Wiki: разделы (с вложенностью) и статьи с простой разметкой и картинками.
// Заменяет «Мануалы»: статью можно приложить к оповещению как инструкцию для кассира.
// Читать и писать могут все пользователи панели (база знаний команды поддержки),
// удалять — administrator и superadmin.
class AdminWikiController
{
    // GET /admin/wiki — дерево: разделы и заголовки статей (без текста), для боковой
    // панели и поиска по названиям.
    public static function index()
    {
        AdminAuth::requireLogin();
        $db = Db::get();
        echo json_encode(array(
            'sections' => $db->query('SELECT id, name, parent_id, sort_order FROM wiki_sections ORDER BY sort_order, name')->fetchAll(),
            'articles' => $db->query("
                SELECT a.id, a.section_id, a.title, a.updated_at, u.username AS updated_by
                FROM wiki_articles a LEFT JOIN admin_users u ON u.id = COALESCE(a.updated_by, a.created_by)
                ORDER BY a.title
            ")->fetchAll(),
        ));
    }

    // GET /admin/wiki/search?q=... — по названию и тексту, с отрывком вокруг совпадения.
    // Ищем в PHP (mb_stripos), а не LIKE: в SQLite LIKE не различает регистр только для
    // латиницы — «касса» не нашла бы «Касса». Статей в мини-Wiki сотни, не миллионы.
    // Несколько слов — должны встретиться все (в любом порядке).
    public static function search()
    {
        AdminAuth::requireLogin();
        $q = isset($_GET['q']) ? trim($_GET['q']) : '';
        if (mb_strlen($q) < 2) {
            echo json_encode(array());
            return;
        }
        $words = preg_split('/\s+/u', $q);
        $hits = array();
        foreach (Db::get()->query('SELECT id, section_id, title, body, updated_at FROM wiki_articles')->fetchAll() as $r) {
            $hay = $r['title'] . "\n" . $r['body'];
            $ok = true;
            foreach ($words as $w) {
                if (mb_stripos($hay, $w) === false) {
                    $ok = false;
                    break;
                }
            }
            if (!$ok) {
                continue;
            }
            $hits[] = array(
                'id' => (int) $r['id'], 'section_id' => $r['section_id'], 'title' => $r['title'],
                'snippet' => self::snippet($r['body'], $words[0]),
                'rank' => (mb_stripos($r['title'], $q) !== false ? 0 : (mb_stripos($r['title'], $words[0]) !== false ? 1 : 2)),
                'updated_at' => $r['updated_at'],
            );
        }
        usort($hits, function ($a, $b) { return $a['rank'] - $b['rank'] ?: strcmp($b['updated_at'], $a['updated_at']); });
        echo json_encode(array_slice($hits, 0, 30));
    }

    // GET /admin/wiki/articles/{id}
    public static function show($id)
    {
        AdminAuth::requireLogin();
        $stmt = Db::get()->prepare("
            SELECT a.*, cu.username AS created_by_name, uu.username AS updated_by_name
            FROM wiki_articles a
            LEFT JOIN admin_users cu ON cu.id = a.created_by
            LEFT JOIN admin_users uu ON uu.id = a.updated_by
            WHERE a.id = :id
        ");
        $stmt->execute(array('id' => (int) $id));
        $a = $stmt->fetch();
        if (!$a) {
            http_response_code(404);
            echo json_encode(array('error' => 'not_found'));
            return;
        }
        echo json_encode($a);
    }

    // POST /admin/wiki/articles   body: { title, body, section_id? }
    public static function storeArticle()
    {
        AdminAuth::requireLogin();
        $a = self::validateArticle(json_decode(file_get_contents('php://input'), true));
        if (isset($a['error'])) {
            http_response_code(400);
            echo json_encode($a);
            return;
        }
        $a['by'] = $_SESSION['admin_id'];
        $a['by2'] = $_SESSION['admin_id'];
        Db::get()->prepare('INSERT INTO wiki_articles (title, body, section_id, created_by, updated_by) VALUES (:title, :body, :section_id, :by, :by2)')->execute($a);
        $id = Db::get()->lastInsertId();
        Logger::info("Wiki: статья создана id={$id} '{$a['title']}' автор='{$_SESSION['admin_username']}'");
        echo json_encode(array('status' => 'ok', 'id' => $id));
    }

    // PUT /admin/wiki/articles/{id}
    public static function updateArticle($id)
    {
        AdminAuth::requireLogin();
        $a = self::validateArticle(json_decode(file_get_contents('php://input'), true));
        if (isset($a['error'])) {
            http_response_code(400);
            echo json_encode($a);
            return;
        }
        $a['id'] = (int) $id;
        $a['by'] = $_SESSION['admin_id'];
        $stmt = Db::get()->prepare('UPDATE wiki_articles SET title = :title, body = :body, section_id = :section_id, updated_by = :by, updated_at = CURRENT_TIMESTAMP WHERE id = :id');
        $stmt->execute($a);
        if (!$stmt->rowCount()) {
            http_response_code(404);
            echo json_encode(array('error' => 'not_found'));
            return;
        }
        Logger::info("Wiki: статья id={$id} '{$a['title']}' изменена автором='{$_SESSION['admin_username']}'");
        echo json_encode(array('status' => 'ok'));
    }

    // DELETE /admin/wiki/articles/{id}
    public static function destroyArticle($id)
    {
        AdminAuth::requireRole(array('administrator', 'superadmin'));
        $stmt = Db::get()->prepare('DELETE FROM wiki_articles WHERE id = :id');
        $stmt->execute(array('id' => (int) $id));
        if (!$stmt->rowCount()) {
            http_response_code(404);
            echo json_encode(array('error' => 'not_found'));
            return;
        }
        Logger::info("Wiki: статья id={$id} удалена автором='{$_SESSION['admin_username']}'");
        echo json_encode(array('status' => 'ok'));
    }

    // POST /admin/wiki/sections   body: { name, parent_id? }
    public static function storeSection()
    {
        AdminAuth::requireLogin();
        $s = self::validateSection(json_decode(file_get_contents('php://input'), true), null);
        if (isset($s['error'])) {
            http_response_code(400);
            echo json_encode($s);
            return;
        }
        $s['sort_order'] = (int) Db::get()->query('SELECT COALESCE(MAX(sort_order), 0) + 10 FROM wiki_sections')->fetchColumn();
        Db::get()->prepare('INSERT INTO wiki_sections (name, parent_id, sort_order) VALUES (:name, :parent_id, :sort_order)')->execute($s);
        $id = Db::get()->lastInsertId();
        Logger::info("Wiki: раздел создан id={$id} '{$s['name']}' автор='{$_SESSION['admin_username']}'");
        echo json_encode(array('status' => 'ok', 'id' => $id));
    }

    // PUT /admin/wiki/sections/{id}   body: { name, parent_id? }
    public static function updateSection($id)
    {
        AdminAuth::requireLogin();
        $s = self::validateSection(json_decode(file_get_contents('php://input'), true), (int) $id);
        if (isset($s['error'])) {
            http_response_code(400);
            echo json_encode($s);
            return;
        }
        $s['id'] = (int) $id;
        Db::get()->prepare('UPDATE wiki_sections SET name = :name, parent_id = :parent_id WHERE id = :id')->execute($s);
        Logger::info("Wiki: раздел id={$id} изменён автором='{$_SESSION['admin_username']}'");
        echo json_encode(array('status' => 'ok'));
    }

    // DELETE /admin/wiki/sections/{id} — подразделы удаляются вместе с ним, статьи не
    // пропадают: переезжают в раздел-родитель (или в «Без раздела»).
    public static function destroySection($id)
    {
        AdminAuth::requireRole(array('administrator', 'superadmin'));
        $db = Db::get();
        $stmt = $db->prepare('SELECT parent_id FROM wiki_sections WHERE id = :id');
        $stmt->execute(array('id' => (int) $id));
        $row = $stmt->fetch();
        if (!$row) {
            http_response_code(404);
            echo json_encode(array('error' => 'not_found'));
            return;
        }
        $ids = self::descendants((int) $id);
        $ids[] = (int) $id;
        $in = implode(',', $ids);
        $parent = $row['parent_id'] !== null ? (int) $row['parent_id'] : 'NULL';
        $db->beginTransaction();
        $moved = $db->exec("UPDATE wiki_articles SET section_id = {$parent} WHERE section_id IN ({$in})");
        $db->exec("DELETE FROM wiki_sections WHERE id IN ({$in})");
        $db->commit();
        Logger::info("Wiki: раздел id={$id} удалён (с подразделами), статей перенесено: {$moved}, автор='{$_SESSION['admin_username']}'");
        echo json_encode(array('status' => 'ok', 'moved_articles' => $moved));
    }

    // ---- Помощники ----------------------------------------------------------------

    private static function validateArticle($b)
    {
        $title = isset($b['title']) ? trim($b['title']) : '';
        if ($title === '') {
            return array('error' => 'title_required');
        }
        $section = !empty($b['section_id']) ? (int) $b['section_id'] : null;
        if ($section !== null) {
            $chk = Db::get()->prepare('SELECT 1 FROM wiki_sections WHERE id = :id');
            $chk->execute(array('id' => $section));
            if (!$chk->fetchColumn()) {
                return array('error' => 'section_not_found');
            }
        }
        return array('title' => $title, 'body' => isset($b['body']) ? (string) $b['body'] : '', 'section_id' => $section);
    }

    private static function validateSection($b, $selfId)
    {
        $name = isset($b['name']) ? trim($b['name']) : '';
        if ($name === '') {
            return array('error' => 'name_required');
        }
        $parent = !empty($b['parent_id']) ? (int) $b['parent_id'] : null;
        if ($parent !== null && $selfId !== null && ($parent === $selfId || in_array($parent, self::descendants($selfId), true))) {
            return array('error' => 'section_cycle');
        }
        return array('name' => $name, 'parent_id' => $parent);
    }

    private static function descendants($id)
    {
        $all = Db::get()->query('SELECT id, parent_id FROM wiki_sections')->fetchAll();
        $out = array();
        $queue = array($id);
        while ($queue) {
            $cur = array_shift($queue);
            foreach ($all as $s) {
                if ($s['parent_id'] !== null && (int) $s['parent_id'] === $cur && !in_array((int) $s['id'], $out, true)) {
                    $out[] = (int) $s['id'];
                    $queue[] = (int) $s['id'];
                }
            }
        }
        return $out;
    }

    // ~160 символов вокруг первого совпадения, без разметки.
    private static function snippet($body, $q)
    {
        $plain = trim(preg_replace('/\s+/u', ' ', preg_replace('/!\[[^\]]*\]\([^)]*\)|[#*`>_\[\]]|\([^)]*\)/u', ' ', (string) $body)));
        $pos = mb_stripos($plain, $q);
        if ($pos === false) {
            return mb_substr($plain, 0, 160) . (mb_strlen($plain) > 160 ? '…' : '');
        }
        $start = max(0, $pos - 60);
        return ($start > 0 ? '…' : '') . mb_substr($plain, $start, 160) . ($start + 160 < mb_strlen($plain) ? '…' : '');
    }
}
