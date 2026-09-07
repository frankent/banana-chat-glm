# Banana Chat API — dev/CI image (spec §3.1: PHP 8.3+; 8.4 used locally)
FROM php:8.4-cli-alpine

# ffmpeg: full-profile video pipeline (FR-MEDIA-004, closes DEC-034) —
# poster frames + duration/dimensions in ProcessAttachment. Host dev
# without ffmpeg keeps the lite path (video ready, original only).
RUN apk add --no-cache \
        bash curl git unzip ffmpeg \
        postgresql-dev icu-dev oniguruma-dev libzip-dev zlib-dev \
    && apk add --no-cache --virtual .build-deps $PHPIZE_DEPS \
    && docker-php-ext-install -j$(nproc) pdo_pgsql pgsql intl pcntl zip \
    && pecl install redis && docker-php-ext-enable redis \
    && apk del .build-deps

# Expose real process env to $_ENV/$_SERVER (default GPCS hides it) so the
# compose `environment:` block wins over any bind-mounted .env inside
# `php artisan serve` / reverb workers. Without this, containerized services
# silently fall back to the host .env (e.g. cloud DB) for HTTP requests.
RUN echo 'variables_order = "EGPCS"' > /usr/local/etc/php/conf.d/00-banana-vars.ini

WORKDIR /app

# Bake composer deps first for layer caching; vendor is overlaid by a named
# volume in dev so bind-mounted source doesn't shadow it.
COPY --from=composer:2 /usr/bin/composer /usr/bin/composer
COPY composer.json composer.lock ./
# --no-scripts: app skeleton isn't present in this layer; PackageManifest
# regenerates bootstrap/cache/packages.php on first boot.
RUN COMPOSER_ALLOW_SUPERUSER=1 composer install --no-interaction --prefer-dist --no-scripts

COPY . .

EXPOSE 8000 8080
