<?php

namespace App\Console\Commands;

use App\Domain\LinkPreview\ImageStore;
use App\Models\LinkPreview;
use Illuminate\Console\Command;

/** FR-MSG-013 / DEC-100 — delete link-preview rows (and our image copies) untouched for 7 days. */
class PruneLinkPreviews extends Command
{
    public const RETENTION_DAYS = 7;

    protected $signature = 'link-previews:prune';

    protected $description = 'Delete link previews and cached images older than 7 days';

    public function handle(ImageStore $images): int
    {
        $count = 0;
        LinkPreview::query()
            ->where('updated_at', '<', now()->subDays(self::RETENTION_DAYS))
            ->chunkById(200, function ($rows) use ($images, &$count) {
                foreach ($rows as $row) {
                    if ($row->image_key !== null) {
                        $images->delete($row->image_key);
                    }
                    $row->delete();
                    $count++;
                }
            });
        $this->info("pruned {$count}");

        return self::SUCCESS;
    }
}
