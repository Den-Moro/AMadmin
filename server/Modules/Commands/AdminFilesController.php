<?php

// Файлы для команды file_deploy: администратор загружает их сюда один раз, потом
// раздаёт по кассам любым количеством команд. Сам байтовый файл — на диске
// (см. FileStorage), в БД — только описание с хешем.
class AdminFilesController
{
    // GET /admin/files
    public static function index()
    {
        AdminAuth::requireLogin();

        $rows = Db::get()->query('
            SELECT f.id, f.original_name, f.sha256, f.size, f.created_at, u.username AS uploaded_by_username
            FROM deploy_files f
            LEFT JOIN admin_users u ON u.id = f.uploaded_by
            ORDER BY f.created_at DESC
        ')->fetchAll();

        echo json_encode($rows);
    }

    // POST /admin/files   multipart/form-data, поле "file"
    // Один запрос — один файл. Размер ограничен настройками PHP (upload_max_filesize,
    // post_max_size) — на Windows-сервере их надо поднять в php.ini, см. ADMIN.md.
    public static function store()
    {
        // Файл, который потом разложится по кассам, — тот же уровень риска, что и команда.
        AdminAuth::requireRole(array('administrator', 'superadmin'));

        if (empty($_FILES['file']) || !is_uploaded_file($_FILES['file']['tmp_name'])) {
            // Самая частая причина — файл больше лимита PHP: тогда $_FILES пустой, а
            // PHP молча обрезает запрос. Подсказываем это прямо в ответе.
            $limit = ini_get('upload_max_filesize');
            http_response_code(400);
            echo json_encode(array('error' => 'file_required_or_too_large', 'upload_max_filesize' => $limit));
            Logger::warning("Загрузка файла: пустой \$_FILES (нет файла или больше лимита {$limit}) автор='{$_SESSION['admin_username']}'");
            return;
        }

        $upload = $_FILES['file'];
        if ($upload['error'] !== UPLOAD_ERR_OK) {
            http_response_code(400);
            echo json_encode(array('error' => 'upload_error_' . $upload['error']));
            return;
        }

        $sha256 = hash_file('sha256', $upload['tmp_name']);
        $size = (int) $upload['size'];
        $originalName = basename($upload['name']);

        $dest = FileStorage::path($sha256);
        if (!file_exists($dest) && !move_uploaded_file($upload['tmp_name'], $dest)) {
            Logger::error("Не удалось сохранить загруженный файл в {$dest}");
            http_response_code(500);
            echo json_encode(array('error' => 'cannot_store_file'));
            return;
        }

        $stmt = Db::get()->prepare('
            INSERT INTO deploy_files (original_name, sha256, size, uploaded_by)
            VALUES (:name, :sha256, :size, :uploaded_by)
        ');
        $stmt->execute(array(
            'name'        => $originalName,
            'sha256'      => $sha256,
            'size'        => $size,
            'uploaded_by' => $_SESSION['admin_id'],
        ));
        $id = Db::get()->lastInsertId();

        Logger::info("Файл загружен: id={$id} имя='{$originalName}' размер={$size} sha256={$sha256} автор='{$_SESSION['admin_username']}'");

        echo json_encode(array('status' => 'ok', 'id' => $id, 'sha256' => $sha256, 'size' => $size));
    }

    // DELETE /admin/files/{id}
    // Байты с диска убираем, только если на тот же хеш больше никто не ссылается.
    // Команды, которые уже ссылаются на этот файл и ещё не выполнены, после удаления
    // завершатся с ошибкой на агенте — панель предупреждает об этом в подсказке.
    public static function destroy($id)
    {
        AdminAuth::requireRole(array('administrator', 'superadmin'));

        $id = (int) $id;
        $stmt = Db::get()->prepare('SELECT sha256, original_name FROM deploy_files WHERE id = :id');
        $stmt->execute(array('id' => $id));
        $file = $stmt->fetch();
        if (!$file) {
            http_response_code(404);
            echo json_encode(array('error' => 'not_found'));
            return;
        }

        Db::get()->prepare('DELETE FROM deploy_files WHERE id = :id')->execute(array('id' => $id));

        $others = Db::get()->prepare('SELECT COUNT(*) FROM deploy_files WHERE sha256 = :sha256');
        $others->execute(array('sha256' => $file['sha256']));
        if ((int) $others->fetchColumn() === 0) {
            $path = FileStorage::path($file['sha256']);
            if (file_exists($path)) {
                unlink($path);
            }
        }

        Logger::info("Файл удалён: id={$id} имя='{$file['original_name']}' автор='{$_SESSION['admin_username']}'");

        echo json_encode(array('status' => 'ok'));
    }
}
