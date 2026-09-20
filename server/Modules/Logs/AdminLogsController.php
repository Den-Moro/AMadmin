<?php

// Просмотр серверного лога прямо из панели, «живой хвост»: панель запоминает смещение
// в файле и раз в пару секунд просит только то, что дописалось. Файловый менеджер
// сервера для этого больше не нужен.
class AdminLogsController
{
    const TAIL_BYTES = 262144;     // сколько показать при первом открытии (256 КБ)
    const MAX_CHUNK_BYTES = 1048576; // потолок на один ответ, чтобы не выгрузить весь лог разом

    // GET /admin/logs?offset=<байт>&file=current|old
    //   без offset — хвост файла; с offset — всё, что появилось после него.
    // Ответ: { lines: [...], offset: <новое смещение>, size: <размер файла>, reset: bool }
    public static function index()
    {
        // Лог содержит hostname'ы, тексты команд и имена администраторов —
        // не для роли operator.
        AdminAuth::requireRole(array('administrator', 'superadmin'));

        $which = isset($_GET['file']) && $_GET['file'] === 'old' ? '.old' : '';
        $path = __DIR__ . '/../../logs/app.log' . $which;

        if (!file_exists($path)) {
            echo json_encode(array('lines' => array(), 'offset' => 0, 'size' => 0, 'reset' => false, 'exists' => false));
            return;
        }

        clearstatcache(true, $path);
        $size = filesize($path);
        $offset = isset($_GET['offset']) && $_GET['offset'] !== '' ? (int) $_GET['offset'] : null;
        $reset = false;

        if ($offset === null) {
            $offset = max(0, $size - self::TAIL_BYTES);
        } elseif ($offset > $size) {
            // Файл стал меньше — его ротировали (см. Logger::MAX_BYTES). Начинаем сначала.
            $offset = 0;
            $reset = true;
        }

        $lines = array();
        $fh = fopen($path, 'rb');
        if ($offset > 0) {
            // Не рвать строку посередине: доматываем до конца текущей.
            fseek($fh, $offset);
            fgets($fh);
            $offset = ftell($fh);
        }

        $read = 0;
        while (!feof($fh) && $read < self::MAX_CHUNK_BYTES) {
            $line = fgets($fh);
            if ($line === false) {
                break;
            }
            $read += strlen($line);
            $line = rtrim($line, "\r\n");
            if ($line === '') {
                continue;
            }
            $lines[] = self::parse($line);
        }
        $newOffset = ftell($fh);
        fclose($fh);

        echo json_encode(array(
            'lines'  => $lines,
            'offset' => $newOffset,
            'size'   => $size,
            'reset'  => $reset,
            'exists' => true,
            'more'   => $newOffset < $size,
        ), JSON_UNESCAPED_UNICODE | JSON_INVALID_UTF8_SUBSTITUTE);
    }

    // "[2026-09-19 21:09:33] [INFO] текст" -> {ts, level, text}
    private static function parse($line)
    {
        if (preg_match('/^\[(\d{4}-\d\d-\d\d \d\d:\d\d:\d\d)\] \[([A-Z]+)\] (.*)$/s', $line, $m)) {
            return array('ts' => $m[1], 'level' => strtolower($m[2]), 'text' => $m[3]);
        }
        return array('ts' => null, 'level' => 'raw', 'text' => $line);
    }

    // GET /admin/logs/download — весь текущий файл как есть, для отправки в поддержку.
    public static function download()
    {
        AdminAuth::requireRole(array('administrator', 'superadmin'));

        $path = __DIR__ . '/../../logs/app.log';
        if (!file_exists($path)) {
            http_response_code(404);
            echo json_encode(array('error' => 'not_found'));
            return;
        }
        header('Content-Type: text/plain; charset=utf-8');
        header('Content-Disposition: attachment; filename="amadmin-' . gmdate('Ymd-His') . '.log"');
        header('Content-Length: ' . filesize($path));
        readfile($path);
    }
}
