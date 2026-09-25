<?php

// Автоопределение режима развёртывания — используется ServerMetrics, чтобы решить,
// откуда брать цифры ресурсов: cgroup контейнера (Docker) или сама ОС (Native).
// /.dockerenv — стандартный маркер Docker с 2014 года, есть в любом образе вне
// зависимости от того, как его собрали; is_dir('/sys/fs/cgroup') — запасной признак
// на случай контейнерного рантайма без этого файла.
class ServerMode
{
    public static function isDocker()
    {
        return PHP_OS_FAMILY === 'Linux' && (file_exists('/.dockerenv') || is_dir('/sys/fs/cgroup'));
    }

    // 'docker' | 'native-windows' | 'native-linux'
    public static function current()
    {
        if (self::isDocker()) {
            return 'docker';
        }
        return PHP_OS_FAMILY === 'Windows' ? 'native-windows' : 'native-linux';
    }
}
