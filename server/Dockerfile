# Образ сервера AMadmin — и для теста, и для прода. Внутри Apache + PHP 8.3:
# несколько рабочих процессов (в отличие от встроенного `php -S`, который на Windows
# обслуживает по одному запросу за раз и на 3000 касс не годится), mod_rewrite для
# маршрутов панели, всё настроено. Снаружи нужен только Docker.
FROM php:8.3-apache

# pdo_sqlite — база; zip — выгрузка конфигов касс архивом.
RUN apt-get update \
    && apt-get install -y --no-install-recommends libsqlite3-dev libzip-dev \
    && docker-php-ext-install pdo_sqlite zip \
    && a2enmod rewrite headers \
    && rm -rf /var/lib/apt/lists/*

# Лимиты на загрузку файлов для раскатки (POST /admin/files). Умолчание PHP — 2 МБ,
# этого мало даже для одного установщика.
RUN printf 'upload_max_filesize = 512M\npost_max_size = 520M\nmax_execution_time = 300\n' > /usr/local/etc/php/conf.d/uploads.ini \
    && mv "$PHP_INI_DIR/php.ini-production" "$PHP_INI_DIR/php.ini"

# DocumentRoot — public/, всё остальное (Core, Modules, data, logs) снаружи веб-корня.
ENV APACHE_DOCUMENT_ROOT=/app/public
RUN sed -ri 's!/var/www/html!${APACHE_DOCUMENT_ROOT}!g' /etc/apache2/sites-available/*.conf \
    && sed -ri 's!/var/www/!${APACHE_DOCUMENT_ROOT}/!g' /etc/apache2/apache2.conf \
    && sed -ri 's/AllowOverride None/AllowOverride All/g' /etc/apache2/apache2.conf \
    && echo 'ServerName amadmin' >> /etc/apache2/apache2.conf

WORKDIR /app

COPY . .
RUN cp config.example.php config.php \
    && mkdir -p data logs \
    && chmod +x docker-entrypoint.sh

EXPOSE 80

ENTRYPOINT ["./docker-entrypoint.sh"]
CMD ["apache2-foreground"]
