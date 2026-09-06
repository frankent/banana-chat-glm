<?php

namespace App\Concerns;

use Illuminate\Support\Str;

/**
 * ULID primary keys per spec §4.1 (D2 — hand-rolled, no package).
 */
trait HasUlid
{
    public function getIncrementing(): bool
    {
        return false;
    }

    public function getKeyType(): string
    {
        return 'string';
    }

    public static function bootHasUlid(): void
    {
        static::creating(function ($model) {
            $key = $model->getKeyName();

            if ($key !== null && $key !== '' && empty($model->{$key})) {
                $model->{$key} = strtolower((string) Str::ulid());
            }
        });
    }
}
