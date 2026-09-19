<?php

// Агентская сторона file_deploy: скачивание файла по Bearer-токену ПК.
class FilesController
{
    // Отдаём файл кусками по 256 КБ, а не readfile() целиком — на узком канале это
    // позволяет агенту читать со своей скоростью (дросселирование делает агент, сервер
    // просто не выгребает весь файл в память заранее).
    const CHUNK_BYTES = 262144;

    // GET /files/{id}
    // Скачать может не любой ПК с валидным токеном, а только тот, кому адресована
    // команда file_deploy с этим файлом (уже застолблённая или ещё нет — не важно).
    // Иначе один токен с любой кассы позволял бы вытянуть все файлы, что когда-либо
    // раскатывались, — а среди них могут быть и конфиги с чем-то чувствительным.
    public static function download($fileId)
    {
        $pc = Auth::authenticatePc();
        if (!$pc) {
            Logger::warning('GET /files: неверный или отсутствующий agent_token');
            http_response_code(401);
            echo json_encode(array('error' => 'invalid_token'));
            return;
        }

        $fileId = (int) $fileId;

        $allowed = false;
        foreach (CommandsController::commandsForPc($pc, false, null, 'file_deploy') as $command) {
            $payload = json_decode($command['payload'], true);
            if (isset($payload['file_id']) && (int) $payload['file_id'] === $fileId) {
                $allowed = true;
                break;
            }
        }

        if (!$allowed) {
            Logger::warning("GET /files/{$fileId}: pc_id={$pc['id']} не адресат ни одной команды с этим файлом — отказано");
            http_response_code(403);
            echo json_encode(array('error' => 'file_not_targeted_to_this_pc'));
            return;
        }

        $stmt = Db::get()->prepare('SELECT original_name, sha256, size FROM deploy_files WHERE id = :id');
        $stmt->execute(array('id' => $fileId));
        $file = $stmt->fetch();

        $path = $file ? FileStorage::path($file['sha256']) : null;
        if (!$file || !file_exists($path)) {
            Logger::error("GET /files/{$fileId}: запись или сам файл на диске отсутствует");
            http_response_code(404);
            echo json_encode(array('error' => 'file_not_found'));
            return;
        }

        Logger::info("Отдаю файл id={$fileId} '{$file['original_name']}' ({$file['size']} байт) pc_id={$pc['id']}");

        header('Content-Type: application/octet-stream');
        header('Content-Length: ' . $file['size']);
        header('Content-Disposition: attachment; filename="' . rawurlencode($file['original_name']) . '"');
        // Хеш и в заголовке тоже: агент сверяет скачанное ещё до записи на диск.
        header('X-File-Sha256: ' . $file['sha256']);

        $fh = fopen($path, 'rb');
        while (!feof($fh)) {
            echo fread($fh, self::CHUNK_BYTES);
            flush();
        }
        fclose($fh);
    }
}
