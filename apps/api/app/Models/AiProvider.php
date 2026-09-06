<?php

namespace App\Models;

use App\Concerns\HasUlid;
use Illuminate\Database\Eloquent\Model;

/** Schema-only (PH2). Credentials are encrypted by the app layer. */
class AiProvider extends Model
{
    use HasUlid;

    protected $fillable = ['name', 'adapter', 'credentials', 'default_model', 'is_active'];

    protected $hidden = ['credentials'];

    protected function casts(): array
    {
        return [
            'credentials' => 'encrypted:array',
            'is_active' => 'boolean',
        ];
    }
}
