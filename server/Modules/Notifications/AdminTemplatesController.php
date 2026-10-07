<?php

// Шаблоны типовых сообщений (вкладка «Шаблоны» на странице «Оповещения»). Шаблон —
// заготовка формы: текст, важность, размер окна, мануал. Отправляется всегда обычным
// оповещением (POST /admin/notifications) — сюда за шаблоном агент не ходит.
// Как и сами оповещения, доступны любой роли панели: оператор тоже рассылает типовое.
class AdminTemplatesController
{
    // GET /admin/message-templates
    public static function index()
    {
        AdminAuth::requireLogin();
        $rows = Db::get()->query("
            SELECT id, title, text, priority, COALESCE(level, CASE priority WHEN 'important' THEN 'important' ELSE 'warning' END) AS level,
                   size, manual_url, images
            FROM message_templates ORDER BY sort_order, title
        ")->fetchAll();
        foreach ($rows as &$row) {
            $row['images'] = MediaController::listFor($row['images']);
        }
        unset($row);
        echo json_encode($rows);
    }

    // POST /admin/message-templates   body: { title, text, level, size, manual_url?, images? }
    public static function store()
    {
        AdminAuth::requireLogin();
        $t = self::validate(json_decode(file_get_contents('php://input'), true));
        if (isset($t['error'])) {
            http_response_code(400);
            echo json_encode($t);
            return;
        }
        $t['sort_order'] = (int) Db::get()->query('SELECT COALESCE(MAX(sort_order), 0) + 10 FROM message_templates')->fetchColumn();
        Db::get()->prepare('
            INSERT INTO message_templates (title, text, priority, level, images, size, manual_url, sort_order)
            VALUES (:title, :text, :priority, :level, :images, :size, :manual_url, :sort_order)
        ')->execute($t);
        $id = Db::get()->lastInsertId();
        Logger::info("Шаблон сообщения создан: id={$id} '{$t['title']}' автор='{$_SESSION['admin_username']}'");
        echo json_encode(array('status' => 'ok', 'id' => $id));
    }

    // PUT /admin/message-templates/{id}
    public static function update($id)
    {
        AdminAuth::requireLogin();
        $t = self::validate(json_decode(file_get_contents('php://input'), true));
        if (isset($t['error'])) {
            http_response_code(400);
            echo json_encode($t);
            return;
        }
        $t['id'] = (int) $id;
        $stmt = Db::get()->prepare('
            UPDATE message_templates SET title = :title, text = :text, priority = :priority, level = :level, images = :images, size = :size, manual_url = :manual_url
            WHERE id = :id
        ');
        $stmt->execute($t);
        if ($stmt->rowCount() === 0) {
            http_response_code(404);
            echo json_encode(array('error' => 'not_found'));
            return;
        }
        Logger::info("Шаблон сообщения изменён: id={$id} '{$t['title']}' автор='{$_SESSION['admin_username']}'");
        echo json_encode(array('status' => 'ok'));
    }

    // DELETE /admin/message-templates/{id}
    public static function destroy($id)
    {
        AdminAuth::requireLogin();
        $stmt = Db::get()->prepare('DELETE FROM message_templates WHERE id = :id');
        $stmt->execute(array('id' => (int) $id));
        if ($stmt->rowCount() === 0) {
            http_response_code(404);
            echo json_encode(array('error' => 'not_found'));
            return;
        }
        Logger::info("Шаблон сообщения удалён: id={$id} автор='{$_SESSION['admin_username']}'");
        echo json_encode(array('status' => 'ok'));
    }

    private static function validate($b)
    {
        $title = isset($b['title']) ? trim($b['title']) : '';
        $text = isset($b['text']) ? trim($b['text']) : '';
        $level = isset($b['level']) ? $b['level'] : ((isset($b['priority']) && $b['priority'] === 'important') ? 'important' : 'warning');
        $size = isset($b['size']) ? $b['size'] : 'medium';
        $manual = isset($b['manual_url']) ? trim($b['manual_url']) : '';
        if ($title === '') {
            return array('error' => 'name_required');
        }
        if ($text === '') {
            return array('error' => 'text_required');
        }
        if (!in_array($level, AdminNotificationsController::LEVELS, true)) {
            return array('error' => 'invalid_level');
        }
        if (!in_array($size, array('small', 'medium', 'large'), true)) {
            return array('error' => 'invalid_size');
        }
        return array(
            'title' => $title, 'text' => $text, 'level' => $level, 'priority' => AdminNotificationsController::priorityOf($level),
            'images' => MediaController::normalizeIds(isset($b['images']) ? $b['images'] : null),
            'size' => $size, 'manual_url' => $manual !== '' ? $manual : null,
        );
    }
}
