<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\Schema;

/**
 * FR-MSG-013 / DEC-100 / API-241 — cache of external link previews. Global (not
 * per workspace): the content is public-page metadata fetched anonymously.
 * TTLs live in App\Models\LinkPreview; rows older than 7 days are pruned daily.
 * Portable column types only (Postgres in prod, also run on CI).
 */
return new class extends Migration
{
    public function up(): void
    {
        Schema::create('link_previews', function (Blueprint $table) {
            $table->ulid('id')->primary();
            $table->char('url_hash', 64)->unique();
            $table->text('url');
            $table->string('final_host', 255)->nullable();
            $table->string('status', 10); // pending | ready | none
            $table->string('title', 200)->nullable();
            $table->string('description', 400)->nullable();
            $table->string('site_name', 100)->nullable();
            $table->string('image_key', 255)->nullable();
            $table->timestampTz('fetched_at')->nullable();
            $table->timestampTz('expires_at')->nullable();
            $table->timestampsTz();

            $table->index('updated_at'); // daily prune
        });
    }

    public function down(): void
    {
        Schema::dropIfExists('link_previews');
    }
};
