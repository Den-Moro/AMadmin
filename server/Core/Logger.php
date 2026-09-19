<?php

// Уровни логирования, минимальный уровень берётся из config.php ('log_level').
// По умолчанию — debug: пока приложение в бете, лучше больше сигнала в логах, чем
// меньше, когда баги ещё ловятся на реальных кассах, а не в проде.
class Logger
{
    const MAX_BYTES = 20971520; // 20 МБ

    private static $levels = array(
        'debug'   => 10,
        'info'    => 20,
        'warning' => 30,
        'error'   => 40,
    );

    private static $minLevel = null;

    public static function debug($message)
    {
        self::write('debug', $message);
    }

    public static function info($message)
    {
        self::write('info', $message);
    }

    public static function warning($message)
    {
        self::write('warning', $message);
    }

    public static function error($message)
    {
        self::write('error', $message);
    }

    private static function write($level, $message)
    {
        if (self::$levels[$level] < self::minLevel()) {
            return;
        }

        $line = '[' . date('Y-m-d H:i:s') . '] [' . strtoupper($level) . '] ' . $message . PHP_EOL;
        $path = __DIR__ . '/../logs/app.log';

        // Ротация по размеру: на 3000 касс debug-лог растёт на десятки мегабайт в час,
        // без ротации диск сервера кончится за пару недель. Храним текущий + один .old.
        if (file_exists($path) && filesize($path) > self::MAX_BYTES) {
            @rename($path, $path . '.old');
        }

        file_put_contents($path, $line, FILE_APPEND | LOCK_EX);
    }

    private static function minLevel()
    {
        if (self::$minLevel === null) {
            $configured = strtolower((string) Config::get('log_level'));
            self::$minLevel = isset(self::$levels[$configured]) ? self::$levels[$configured] : self::$levels['debug'];
        }

        return self::$minLevel;
    }
}
