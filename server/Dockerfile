# Только для тестового запуска (docker compose up) — сам production-деплой по плану
# ручной, на Windows-хосте (см. AGENTS.md, "Деплой"). Этот образ — способ поднимать и
# гонять сервер в изолированной, воспроизводимой среде вместо `php -S` прямо на хосте.
FROM php:8.3-cli-alpine

# zip — для выгрузки конфигов всех касс одним архивом (см. AdminPcsController::exportConfigs).
# На Windows-сервере это расширение идёт в комплекте с PHP, нужно лишь включить в php.ini.
RUN apk add --no-cache sqlite-dev libzip-dev \
    && docker-php-ext-install pdo_sqlite zip

# Лимиты на загрузку файлов для раскатки (POST /admin/files). Умолчание PHP — 2 МБ,
# этого мало даже для одного установщика. На Windows-сервере — те же две строки в php.ini.
RUN printf 'upload_max_filesize = 512M\npost_max_size = 520M\n' > /usr/local/etc/php/conf.d/uploads.ini

WORKDIR /app

COPY . .
RUN cp config.example.php config.php \
    && mkdir -p data logs \
    && chmod +x docker-entrypoint.sh

EXPOSE 8000

ENTRYPOINT ["./docker-entrypoint.sh"]
CMD ["php", "-S", "0.0.0.0:8000", "-t", "public", "public/router.php"]
