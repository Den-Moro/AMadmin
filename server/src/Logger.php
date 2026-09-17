<?php

class Logger
{
    public static function log($message)
    {
        $line = '[' . date('Y-m-d H:i:s') . '] ' . $message . PHP_EOL;
        file_put_contents(__DIR__ . '/../logs/app.log', $line, FILE_APPEND);
    }
}
