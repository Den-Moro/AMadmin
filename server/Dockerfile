# Только для тестового запуска (docker compose up) — сам production-деплой по плану
# ручной, на Windows-хосте (см. AGENTS.md, "Деплой"). Этот образ — способ поднимать и
# гонять сервер в изолированной, воспроизводимой среде вместо `php -S` прямо на хосте.
FROM php:8.3-cli-alpine

RUN apk add --no-cache sqlite-dev \
    && docker-php-ext-install pdo_sqlite

WORKDIR /app

COPY . .
RUN cp config.example.php config.php \
    && mkdir -p data logs \
    && chmod +x docker-entrypoint.sh

EXPOSE 8000

ENTRYPOINT ["./docker-entrypoint.sh"]
CMD ["php", "-S", "0.0.0.0:8000", "-t", "public", "public/router.php"]
