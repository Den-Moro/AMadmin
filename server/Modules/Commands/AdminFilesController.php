<?php

// Файлы для команды file_deploy: администратор загружает их сюда один раз, потом
// раздаёт по кассам любым количеством команд. Сам байтовый файл — на диске
// (см. FileStorage), в БД — только описание с хешем.
class AdminFilesController
{
    // GET /admin/files — плюс по каждому файлу: сколько раз его раскатывали, когда в
    // последний раз и куда (полный путь из последней команды) — чтобы по списку сразу
    // было видно, что уже разложено, а что лежит без дела.
    public static function index()
    {
        AdminAuth::requireLogin();

        $deploys = "FROM commands c WHERE c.type = 'file_deploy' AND json_extract(c.payload, '$.file_id') = f.id";
        $rows = Db::get()->query("
            SELECT f.id, f.original_name, f.sha256, f.size, f.created_at, u.username AS uploaded_by_username,
                   (SELECT COUNT(*) {$deploys}) AS deploy_count,
                   (SELECT MAX(c.created_at) {$deploys}) AS last_deployed_at,
                   (SELECT json_extract(c.payload, '$.target_path') {$deploys} ORDER BY c.id DESC LIMIT 1) AS last_target_path
            FROM deploy_files f
            LEFT JOIN admin_users u ON u.id = f.uploaded_by
            ORDER BY f.created_at DESC
        ")->fetchAll();

        echo json_encode($rows);
    }

    // GET /admin/files/recent-folders — папки из последних раскаток (без имени файла),
    // свежие первыми, без повторов. Мастер раскатки предлагает их одним кликом.
    public static function recentFolders()
    {
        AdminAuth::requireLogin();

        $paths = Db::get()->query("
            SELECT json_extract(payload, '$.target_path')
            FROM commands
            WHERE type = 'file_deploy'
            ORDER BY id DESC
            LIMIT 300
        ")->fetchAll(PDO::FETCH_COLUMN);

        $folders = array();
        foreach ($paths as $path) {
            $cut = strrpos((string) $path, '\\');
            if ($cut === false) {
                continue;
            }
            $folder = substr($path, 0, $cut);
            if (strlen($folder) === 2) {
                $folder .= '\\'; // C: -> C:\ (файл в корне диска)
            }
            $key = strtolower($folder);
            if (!isset($folders[$key])) {
                $folders[$key] = $folder;
            }
            if (count($folders) >= 8) {
                break;
            }
        }

        echo json_encode(array_values($folders));
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

        // Тот же файл (имя и содержимое) уже загружен — не плодим дубль в списке, а
        // отдаём существующую запись: мастер раскатки просто выберет её.
        $same = Db::get()->prepare('SELECT id FROM deploy_files WHERE sha256 = :sha256 AND original_name = :name');
        $same->execute(array('sha256' => $sha256, 'name' => $originalName));
        $existingId = $same->fetchColumn();
        if ($existingId) {
            Logger::info("Загрузка файла: '{$originalName}' уже есть (id={$existingId}, тот же хеш) — дубль не создан, автор='{$_SESSION['admin_username']}'");
            echo json_encode(array('status' => 'ok', 'id' => $existingId, 'sha256' => $sha256, 'size' => $size, 'duplicate' => true));
            return;
        }

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
