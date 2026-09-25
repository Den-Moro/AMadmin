<?php

// Минимальный SNTP-клиент (упрощённо по RFC 4330) — только чтение времени с
// NTP-сервера для сравнения с локальным, без запроса синхронизации самой ОС:
// веб-приложению лезть в системные часы небезопасно, а внутри Docker-контейнера
// это и вовсе недоступно без спецправ. Возвращает расхождение, не более того.
class NtpClient
{
    // $host:123 (UDP). Возвращает array('ok', 'drift_seconds', 'error') —
    // drift_seconds > 0 значит локальные часы сервера спешат относительно NTP.
    public static function checkDrift($host, $timeoutSeconds = 2)
    {
        $errno = 0;
        $errstr = '';
        $socket = @stream_socket_client('udp://' . $host . ':123', $errno, $errstr, $timeoutSeconds);
        if ($socket === false) {
            return array('ok' => false, 'drift_seconds' => null, 'error' => $errstr !== '' ? $errstr : 'connection_failed');
        }
        stream_set_timeout($socket, $timeoutSeconds);

        // 48-байтный запрос: LI=0, VN=3, Mode=3 (client) = 0x1B, остальные 47 байт — нули.
        $packet = chr(0x1B) . str_repeat(chr(0), 47);
        if (@fwrite($socket, $packet) === false) {
            fclose($socket);
            return array('ok' => false, 'drift_seconds' => null, 'error' => 'send_failed');
        }

        $response = @fread($socket, 48);
        $receivedAt = microtime(true);
        $meta = stream_get_meta_data($socket);
        fclose($socket);

        if ($response === false || strlen($response) < 48) {
            return array('ok' => false, 'drift_seconds' => null, 'error' => !empty($meta['timed_out']) ? 'timeout' : 'short_response');
        }

        // Transmit Timestamp — байты 40..47: 4 байта целых секунд (с 1900-01-01) +
        // 4 байта дробной части, оба big-endian.
        $t = unpack('N2', substr($response, 40, 8));
        $ntpUnixTime = $t[1] - 2208988800 + ($t[2] / 4294967296.0); // 1900 -> 1970 эпоха

        return array('ok' => true, 'drift_seconds' => round($receivedAt - $ntpUnixTime, 3), 'error' => null);
    }
}
