# Образ сервера AMadmin — и для теста, и для прода. Внутри nginx + PHP-FPM 8.3:
# несколько рабочих процессов (в отличие от встроенного `php -S`, который на Windows
# обслуживает по одному запросу за раз и на 3000 касс не годится), маршруты панели —
# в nginx.conf (аналог mod_rewrite). Снаружи нужен только Docker.
FROM php:8.3-fpm

# pdo_sqlite — база; zip — выгрузка конфигов касс архивом; nginx — веб-сервер
# (у php-fpm своего HTTP-сервера нет).
RUN apt-get update \
    && apt-get install -y --no-install-recommends libsqlite3-dev libzip-dev nginx \
    && docker-php-ext-install pdo_sqlite zip \
    && rm -rf /var/lib/apt/lists/*

# Лимиты на загрузку файлов для раскатки (POST /admin/files). Умолчание PHP — 2 МБ,
# этого мало даже для одного установщика. nginx.conf несёт тот же лимит (client_max_body_size).
RUN printf 'upload_max_filesize = 512M\npost_max_size = 520M\nmax_execution_time = 300\n' > /usr/local/etc/php/conf.d/uploads.ini \
    && mv "$PHP_INI_DIR/php.ini-production" "$PHP_INI_DIR/php.ini"

WORKDIR /app

COPY . .
RUN cp config.example.php config.php \
    && mkdir -p data logs \
    && chmod +x docker-entrypoint.sh

# DocumentRoot — public/, всё остальное (Core, Modules, data, logs) снаружи веб-корня.
COPY docker/nginx.conf /etc/nginx/sites-available/default

EXPOSE 80

ENTRYPOINT ["./docker-entrypoint.sh"]
CMD ["nginx", "-g", "daemon off;"]
