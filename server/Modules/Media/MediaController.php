<?php

// Картинки: в оповещениях (касса показывает их в окне), шаблонах и статьях Wiki.
// Байты — в общем хранилище по SHA-256 (FileStorage), описание — в таблице media.
// Формат проверяется по содержимому (getimagesize), а не по расширению; принимаются
// только то, что умеет показать окно агента на Windows 7: PNG, JPEG, GIF, BMP.
class MediaController
{
    const MIMES = array('image/png', 'image/jpeg', 'image/gif', 'image/bmp', 'image/x-ms-bmp');

    // POST /admin/media   multipart/form-data, поле "file"
    public static function store()
    {
        AdminAuth::requireLogin();

        if (empty($_FILES['file']) || !is_uploaded_file($_FILES['file']['tmp_name']) || $_FILES['file']['error'] !== UPLOAD_ERR_OK) {
            http_response_code(400);
            echo json_encode(array('error' => 'file_required_or_too_large', 'upload_max_filesize' => ini_get('upload_max_filesize')));
            return;
        }
        $upload = $_FILES['file'];
        $maxBytes = max(1, Settings::int('media_max_mb', 5)) * 1048576;
        if ($upload['size'] > $maxBytes) {
            http_response_code(400);
            echo json_encode(array('error' => 'image_too_large', 'max_mb' => $maxBytes / 1048576));
            return;
        }
        $info = @getimagesize($upload['tmp_name']);
        if (!$info || !in_array($info['mime'], self::MIMES, true)) {
            http_response_code(400);
            echo json_encode(array('error' => 'not_an_image'));
            return;
        }

        $sha256 = hash_file('sha256', $upload['tmp_name']);
        $existing = Db::get()->prepare('SELECT id, mime, size, width, height FROM media WHERE sha256 = :sha LIMIT 1');
        $existing->execute(array('sha' => $sha256));
        $row = $existing->fetch();
        if ($row) {
            echo json_encode(self::describe($row));
            return;
        }

        $dest = FileStorage::path($sha256);
        if (!file_exists($dest) && !move_uploaded_file($upload['tmp_name'], $dest)) {
            Logger::error("Картинка: не удалось сохранить в {$dest}");
            http_response_code(500);
            echo json_encode(array('error' => 'cannot_store_file'));
            return;
        }

        Db::get()->prepare('
            INSERT INTO media (sha256, original_name, mime, size, width, height, uploaded_by)
            VALUES (:sha, :name, :mime, :size, :w, :h, :by)
        ')->execute(array(
            'sha' => $sha256, 'name' => basename($upload['name']), 'mime' => $info['mime'], 'size' => (int) $upload['size'],
            'w' => (int) $info[0], 'h' => (int) $info[1], 'by' => $_SESSION['admin_id'],
        ));
        $id = (int) Db::get()->lastInsertId();
        Logger::info("Картинка загружена: id={$id} '{$upload['name']}' {$info[0]}x{$info[1]} {$info['mime']} автор='{$_SESSION['admin_username']}'");
        echo json_encode(self::describe(array('id' => $id, 'mime' => $info['mime'], 'size' => (int) $upload['size'], 'width' => (int) $info[0], 'height' => (int) $info[1])));
    }

    // GET /admin/media/{id} — для панели (превью в форме оповещения, картинки в Wiki).
    public static function adminShow($id)
    {
        AdminAuth::requireLogin();
        self::stream((int) $id);
    }

    // GET /media/{id} — для агента. Отдаём только картинку из оповещения, адресованного
    // этой кассе (то же условие таргетинга, что у самих оповещений, TargetMatcher):
    // токен одной кассы не должен открывать всё, что когда-либо загружали.
    public static function agentShow($id)
    {
        $pc = Auth::authenticatePc();
        if (!$pc) {
            http_response_code(401);
            echo json_encode(array('error' => 'invalid_token'));
            return;
        }
        $id = (int) $id;
        $sql = "
            SELECT 1
            FROM notifications n
            JOIN json_each(n.images) j
            JOIN notification_targets t ON t.notification_id = n.id
            " . TargetMatcher::JOIN . "
            WHERE n.images IS NOT NULL AND CAST(j.value AS INTEGER) = CAST(:media_id AS INTEGER) AND " . TargetMatcher::CONDITION . "
            LIMIT 1
        ";
        $params = TargetMatcher::params($pc);
        $params['media_id'] = $id;
        $stmt = Db::get()->prepare($sql);
        $stmt->execute($params);
        if (!$stmt->fetchColumn()) {
            Logger::warning("GET /media/{$id}: pc_id={$pc['id']} — картинка не из адресованного ей оповещения, отказано");
            http_response_code(403);
            echo json_encode(array('error' => 'media_not_targeted_to_this_pc'));
            return;
        }
        self::stream($id);
    }

    // Список id картинок из тела запроса -> проверенный JSON для колонки images (или null).
    public static function normalizeIds($ids)
    {
        if (!is_array($ids) || !$ids) {
            return null;
        }
        $ids = array_values(array_unique(array_filter(array_map('intval', $ids))));
        if (!$ids) {
            return null;
        }
        $in = implode(',', $ids);
        $found = Db::get()->query("SELECT id FROM media WHERE id IN ({$in})")->fetchAll(PDO::FETCH_COLUMN);
        $ids = array_values(array_filter($ids, function ($id) use ($found) { return in_array($id, array_map('intval', $found), true); }));
        return $ids ? json_encode(array_slice($ids, 0, 6)) : null;
    }

    // Описание картинок по JSON из колонки images: [{id, width, height}] для агента и панели.
    public static function listFor($imagesJson)
    {
        $ids = json_decode((string) $imagesJson, true);
        if (!is_array($ids) || !$ids) {
            return array();
        }
        $ids = array_map('intval', $ids);
        $rows = array();
        foreach (Db::get()->query('SELECT id, width, height FROM media WHERE id IN (' . implode(',', $ids) . ')')->fetchAll() as $r) {
            $rows[(int) $r['id']] = array('id' => (int) $r['id'], 'width' => (int) $r['width'], 'height' => (int) $r['height']);
        }
        $out = array();
        foreach ($ids as $id) {
            if (isset($rows[$id])) {
                $out[] = $rows[$id];
            }
        }
        return $out;
    }

    private static function describe($row)
    {
        return array(
            'id' => (int) $row['id'], 'mime' => $row['mime'], 'size' => (int) $row['size'],
            'width' => (int) $row['width'], 'height' => (int) $row['height'], 'url' => '/admin/media/' . (int) $row['id'],
        );
    }

    private static function stream($id)
    {
        $stmt = Db::get()->prepare('SELECT sha256, mime, size FROM media WHERE id = :id');
        $stmt->execute(array('id' => $id));
        $m = $stmt->fetch();
        $path = $m ? FileStorage::path($m['sha256']) : null;
        if (!$m || !file_exists($path)) {
            http_response_code(404);
            echo json_encode(array('error' => 'not_found'));
            return;
        }
        // Содержимое по id не меняется (новая картинка — новый id), кэшировать можно смело.
        header('Content-Type: ' . $m['mime']);
        header('Content-Length: ' . filesize($path));
        header('Cache-Control: private, max-age=604800');
        readfile($path);
    }
}
