# Banana Chat API — dev/CI image (spec §3.1: PHP 8.3+; 8.4 used locally)
FROM php:8.4-cli-alpine

RUN apk add --no-cache \
        bash curl git unzip \
        postgresql-dev icu-dev oniguruma-dev libzip-dev zlib-dev \
    && apk add --no-cache --virtual .build-deps $PHPIZE_DEPS \
    && docker-php-ext-install -j$(nproc) pdo_pgsql pgsql intl pcntl zip \
    && pecl install redis && docker-php-ext-enable redis \
    && apk del .build-deps

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
