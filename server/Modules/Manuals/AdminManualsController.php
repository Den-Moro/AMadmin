<?php

class AdminManualsController
{
    // GET /admin/manuals
    public static function index()
    {
        AdminAuth::requireLogin();
        echo json_encode(Db::get()->query('SELECT id, title, url_or_text, created_at, updated_at FROM manuals ORDER BY updated_at DESC')->fetchAll());
    }

    // POST /admin/manuals  body: { title, url_or_text }
    public static function store()
    {
        AdminAuth::requireLogin();

        $body = json_decode(file_get_contents('php://input'), true);
        $title = isset($body['title']) ? trim($body['title']) : '';
        $text = isset($body['url_or_text']) ? trim($body['url_or_text']) : '';

        if ($title === '' || $text === '') {
            http_response_code(400);
            echo json_encode(array('error' => 'title_and_text_required'));
            return;
        }

        $stmt = Db::get()->prepare('INSERT INTO manuals (title, url_or_text) VALUES (:title, :text)');
        $stmt->execute(array('title' => $title, 'text' => $text));

        $id = Db::get()->lastInsertId();
        Logger::info("Мануал создан: id={$id} title='{$title}' автор='{$_SESSION['admin_username']}'");

        echo json_encode(array('status' => 'ok', 'id' => $id));
    }

    // PUT /admin/manuals/{id}  body: { title, url_or_text }
    public static function update($id)
    {
        AdminAuth::requireLogin();

        $body = json_decode(file_get_contents('php://input'), true);
        $title = isset($body['title']) ? trim($body['title']) : '';
        $text = isset($body['url_or_text']) ? trim($body['url_or_text']) : '';

        if ($title === '' || $text === '') {
            http_response_code(400);
            echo json_encode(array('error' => 'title_and_text_required'));
            return;
        }

        // Триггер trg_manuals_updated_at (см. миграцию) сам проставит updated_at.
        $stmt = Db::get()->prepare('UPDATE manuals SET title = :title, url_or_text = :text WHERE id = :id');
        $stmt->execute(array('title' => $title, 'text' => $text, 'id' => (int) $id));

        echo json_encode(array('status' => 'ok'));
    }

    // DELETE /admin/manuals/{id}
    // Жёсткое удаление, без архивации — записи оповещений хранят скопированный текст
    // мануала у себя (см. AGENTS.md/TargetMatcher-пояснение про notifications.manual_url),
    // поэтому удаление из библиотеки не портит историю уже отправленных оповещений.
    public static function destroy($id)
    {
        AdminAuth::requireLogin();

        $stmt = Db::get()->prepare('DELETE FROM manuals WHERE id = :id');
        $stmt->execute(array('id' => (int) $id));

        Logger::info("Мануал удалён: id={$id} автор='{$_SESSION['admin_username']}'");

        echo json_encode(array('status' => 'ok'));
    }
}
