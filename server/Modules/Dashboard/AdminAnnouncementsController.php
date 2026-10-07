<?php

// Доска «Важная информация» вверху дашборда — для всех пользователей панели: «ночью
// обновляем сервер», «в магазине №5 кассы не трогать до понедельника». Читают все роли,
// пишут administrator и superadmin. Объявление с истёкшим сроком на дашборде не
// показывается (в списке «все, включая истёкшие» остаётся, пока его не удалят).
class AdminAnnouncementsController
{
    const LEVELS = array('info', 'warning', 'critical');

    // GET /admin/announcements[?all=1]
    public static function index()
    {
        AdminAuth::requireLogin();
        $all = !empty($_GET['all']);
        echo json_encode(Db::get()->query("
            SELECT a.id, a.text, a.level, a.expires_at, a.created_at, a.updated_at, u.username AS author,
                   (a.expires_at IS NOT NULL AND a.expires_at <= CURRENT_TIMESTAMP) AS expired
            FROM announcements a LEFT JOIN admin_users u ON u.id = a.created_by
            " . ($all ? '' : "WHERE a.expires_at IS NULL OR a.expires_at > CURRENT_TIMESTAMP") . "
            ORDER BY CASE a.level WHEN 'critical' THEN 0 WHEN 'warning' THEN 1 ELSE 2 END, a.created_at DESC
        ")->fetchAll());
    }

    // POST /admin/announcements   body: { text, level, expires_at? (ISO, UTC) }
    public static function store()
    {
        AdminAuth::requireRole(array('administrator', 'superadmin'));
        $a = self::validate(json_decode(file_get_contents('php://input'), true));
        if (isset($a['error'])) {
            http_response_code(400);
            echo json_encode($a);
            return;
        }
        $a['by'] = $_SESSION['admin_id'];
        Db::get()->prepare('INSERT INTO announcements (text, level, expires_at, created_by) VALUES (:text, :level, :expires_at, :by)')->execute($a);
        $id = Db::get()->lastInsertId();
        Logger::info("Объявление на дашборде: id={$id} уровень={$a['level']} до=" . ($a['expires_at'] ?: 'бессрочно') . " автор='{$_SESSION['admin_username']}'");
        echo json_encode(array('status' => 'ok', 'id' => $id));
    }

    // PUT /admin/announcements/{id}
    public static function update($id)
    {
        AdminAuth::requireRole(array('administrator', 'superadmin'));
        $a = self::validate(json_decode(file_get_contents('php://input'), true));
        if (isset($a['error'])) {
            http_response_code(400);
            echo json_encode($a);
            return;
        }
        $a['id'] = (int) $id;
        $stmt = Db::get()->prepare('UPDATE announcements SET text = :text, level = :level, expires_at = :expires_at, updated_at = CURRENT_TIMESTAMP WHERE id = :id');
        $stmt->execute($a);
        if (!$stmt->rowCount()) {
            http_response_code(404);
            echo json_encode(array('error' => 'not_found'));
            return;
        }
        Logger::info("Объявление id={$id} изменено автором='{$_SESSION['admin_username']}'");
        echo json_encode(array('status' => 'ok'));
    }

    // DELETE /admin/announcements/{id}
    public static function destroy($id)
    {
        AdminAuth::requireRole(array('administrator', 'superadmin'));
        $stmt = Db::get()->prepare('DELETE FROM announcements WHERE id = :id');
        $stmt->execute(array('id' => (int) $id));
        if (!$stmt->rowCount()) {
            http_response_code(404);
            echo json_encode(array('error' => 'not_found'));
            return;
        }
        Logger::info("Объявление id={$id} удалено автором='{$_SESSION['admin_username']}'");
        echo json_encode(array('status' => 'ok'));
    }

    private static function validate($b)
    {
        $text = isset($b['text']) ? trim($b['text']) : '';
        $level = isset($b['level']) ? $b['level'] : 'info';
        if ($text === '') {
            return array('error' => 'text_required');
        }
        if (!in_array($level, self::LEVELS, true)) {
            return array('error' => 'invalid_level');
        }
        $expires = null;
        if (!empty($b['expires_at'])) {
            $ts = strtotime((string) $b['expires_at']);
            if ($ts === false) {
                return array('error' => 'invalid_expires_at');
            }
            $expires = gmdate('Y-m-d H:i:s', $ts);
        }
        return array('text' => $text, 'level' => $level, 'expires_at' => $expires);
    }
}
