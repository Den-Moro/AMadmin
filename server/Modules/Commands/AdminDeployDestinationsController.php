<?php

// Справочник «Папки назначения» для раскатки файлов (страница «Файлы»). Только папки:
// имя файла подставляется при раскатке. Сама раскатка — обычная команда file_deploy с
// полным путём (папка + имя), агенту этот справочник не нужен и не передаётся.
class AdminDeployDestinationsController
{
    // GET /admin/deploy-destinations
    public static function index()
    {
        AdminAuth::requireLogin();

        $rows = Db::get()->query('
            SELECT id, name, path, description, sort_order
            FROM deploy_destinations
            ORDER BY sort_order, name
        ')->fetchAll();

        echo json_encode($rows);
    }

    // POST /admin/deploy-destinations   body: { name, path, description? }
    public static function store()
    {
        AdminAuth::requireRole(array('administrator', 'superadmin'));

        $checked = self::validate(json_decode(file_get_contents('php://input'), true));
        if (isset($checked['error'])) {
            http_response_code(400);
            echo json_encode($checked);
            return;
        }

        $order = (int) Db::get()->query('SELECT COALESCE(MAX(sort_order), 0) + 10 FROM deploy_destinations')->fetchColumn();
        $stmt = Db::get()->prepare('
            INSERT INTO deploy_destinations (name, path, description, sort_order)
            VALUES (:name, :path, :description, :sort_order)
        ');
        $stmt->execute(array(
            'name'        => $checked['name'],
            'path'        => $checked['path'],
            'description' => $checked['description'],
            'sort_order'  => $order,
        ));
        $id = Db::get()->lastInsertId();

        Logger::info("Папка назначения добавлена: id={$id} '{$checked['name']}' -> '{$checked['path']}' автор='{$_SESSION['admin_username']}'");
        echo json_encode(array('status' => 'ok', 'id' => $id));
    }

    // PUT /admin/deploy-destinations/{id}   body: { name, path, description? }
    public static function update($id)
    {
        AdminAuth::requireRole(array('administrator', 'superadmin'));

        $checked = self::validate(json_decode(file_get_contents('php://input'), true));
        if (isset($checked['error'])) {
            http_response_code(400);
            echo json_encode($checked);
            return;
        }

        $stmt = Db::get()->prepare('
            UPDATE deploy_destinations SET name = :name, path = :path, description = :description WHERE id = :id
        ');
        $stmt->execute(array(
            'name'        => $checked['name'],
            'path'        => $checked['path'],
            'description' => $checked['description'],
            'id'          => (int) $id,
        ));
        if ($stmt->rowCount() === 0) {
            http_response_code(404);
            echo json_encode(array('error' => 'not_found'));
            return;
        }

        Logger::info("Папка назначения изменена: id={$id} '{$checked['name']}' -> '{$checked['path']}' автор='{$_SESSION['admin_username']}'");
        echo json_encode(array('status' => 'ok'));
    }

    // DELETE /admin/deploy-destinations/{id}
    // Уже отправленные команды не затрагивает: в них записан полный путь, а не ссылка сюда.
    public static function destroy($id)
    {
        AdminAuth::requireRole(array('administrator', 'superadmin'));

        $stmt = Db::get()->prepare('DELETE FROM deploy_destinations WHERE id = :id');
        $stmt->execute(array('id' => (int) $id));
        if ($stmt->rowCount() === 0) {
            http_response_code(404);
            echo json_encode(array('error' => 'not_found'));
            return;
        }

        Logger::info("Папка назначения удалена: id={$id} автор='{$_SESSION['admin_username']}'");
        echo json_encode(array('status' => 'ok'));
    }

    // Папка — полный путь Windows (C:\... или \\сервер\шара\...). Хвостовой «\» срезаем
    // (кроме корня диска «C:\»): имя файла потом приклеивается через один «\».
    private static function validate($body)
    {
        $name = isset($body['name']) ? trim($body['name']) : '';
        $path = isset($body['path']) ? trim($body['path']) : '';
        $description = isset($body['description']) ? trim($body['description']) : '';

        if ($name === '') {
            return array('error' => 'name_required');
        }
        $path = self::normalizeFolder($path);
        if ($path === null) {
            return array('error' => 'folder_must_be_absolute_windows_path');
        }

        return array('name' => $name, 'path' => $path, 'description' => $description !== '' ? $description : null);
    }

    // null — не похоже на полный путь к папке Windows.
    public static function normalizeFolder($path)
    {
        $path = str_replace('/', '\\', trim($path));
        if (!preg_match('#^([A-Za-z]:\\\\|\\\\\\\\[^\\\\]+\\\\[^\\\\]+)#', $path)
            || preg_match('#[<>"|?*]#', $path) || strpos(substr($path, 2), ':') !== false) {
            return null;
        }
        if (strlen($path) > 3) {
            $path = rtrim($path, '\\');
        }
        return $path;
    }
}
