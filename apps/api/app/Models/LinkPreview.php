<?php

namespace App\Models;

use App\Concerns\HasUlid;
use Illuminate\Database\Eloquent\Model;

/** FR-MSG-013 / DEC-100 — cached external link preview (global, public-page metadata only). */
class LinkPreview extends Model
{
    use HasUlid;

    public const PENDING = 'pending';

    public const READY = 'ready';

    public const NONE = 'none';

    public const TTL_READY_HOURS = 24;

    public const TTL_NONE_MINUTES = 60;

    public const TTL_PENDING_SECONDS = 60;

    protected $table = 'link_previews';

    protected $fillable = [
        'url_hash', 'url', 'final_host', 'status', 'title', 'description', 'site_name',
        'image_key', 'fetched_at', 'expires_at',
    ];

    protected function casts(): array
    {
        return ['fetched_at' => 'immutable_datetime', 'expires_at' => 'immutable_datetime'];
    }

    public function isFresh(): bool
    {
        return $this->expires_at !== null && $this->expires_at->isFuture();
    }
}
