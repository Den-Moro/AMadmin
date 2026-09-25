-- Контроль расхождения часов сервера с NTP — только чтение, сервер никогда сам не
-- трогает системное время (веб-приложению лезть в системные часы небезопасно, а в
-- Docker это и вовсе недоступно без спецправ). Выключено по умолчанию.
INSERT INTO settings (key, value) VALUES
    ('ntp_enabled', '0'),
    ('ntp_server_address', 'pool.ntp.org'),
    ('ntp_drift_threshold_seconds', '5'),
    ('ntp_check_interval_seconds', '300');
