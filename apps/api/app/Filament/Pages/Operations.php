<?php

namespace App\Filament\Pages;

use App\Domain\Admin\ModerationService;
use App\Http\Controllers\Api\V1\HealthController;
use App\Jobs\PurgeExpiredUploads;
use App\Models\Attachment;
use App\Services\AuditLogger;
use App\Services\SettingsService;
use Filament\Actions\Action;
use Filament\Forms\Components\Select;
use Filament\Pages\Page;
use Illuminate\Support\Facades\Artisan;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Queue;

/** FR-ADM-010/013 — live health, queues, storage, explicit retry. */
class Operations extends Page
{
    protected static ?string $navigationIcon = 'heroicon-o-server-stack';

    protected static ?string $navigationGroup = 'System';

    protected static string $view = 'filament.pages.operations';

    public function health(): array
    {
        return app(HealthController::class)->index()->getData(true);
    }

    public function storage(): array
    {
        $quota = app(SettingsService::class)->get('storage.quota_per_workspace_gb');
        $rows = DB::table('attachments')->join('workspaces', 'workspaces.id', '=', 'attachments.workspace_id')->whereNull('attachments.deleted_at')->groupBy('workspaces.id', 'workspaces.name', 'attachments.kind')->selectRaw('workspaces.id, workspaces.name, attachments.kind, SUM(size_bytes) AS bytes, COUNT(*) AS files')->orderByDesc('bytes')->get()->map(fn ($r) => ['id' => $r->id, 'name' => $r->name, 'kind' => $r->kind, 'bytes' => (int) $r->bytes, 'files' => (int) $r->files, 'quota' => $quota])->all();
        $totals = [];
        foreach ($rows as $r) {
            $totals[$r['id']] = ($totals[$r['id']] ?? 0) + $r['bytes'];
        }

        return array_map(fn ($r) => [...$r, 'percent' => $quota ? round($totals[$r['id']] / ($quota * 1073741824) * 100, 1) : null], $rows);
    }

    public function largest()
    {
        return Attachment::whereNull('deleted_at')->orderByDesc('size_bytes')->limit(100)->get(['id', 'original_name', 'size_bytes']);
    }

    public function failures()
    {
        return DB::table('failed_jobs')->orderByDesc('failed_at')->limit(20)->get(['uuid', 'queue', 'failed_at']);
    }

    public function queues(): array
    {
        $out = [];
        foreach (['default', 'media', 'push', 'retention', 'ai'] as $q) {
            try {
                $out[$q] = Queue::size($q);
            } catch (\Throwable) {
                $out[$q] = 'Unavailable';
            }
        }

        return $out;
    }

    protected function getHeaderActions(): array
    {
        return [
            Action::make('horizon')->label('Queue dashboard')->url('/horizon')->openUrlInNewTab(),
            Action::make('retryJob')->label('Retry failed job')->form([Select::make('uuid')->label('Failed job')->options(fn () => DB::table('failed_jobs')->orderByDesc('failed_at')->limit(100)->get()->mapWithKeys(fn ($r) => [$r->uuid => $r->queue.' · '.$r->failed_at.' · '.$r->uuid]))->required()])->requiresConfirmation()->action(function (array $data) {
                app(ModerationService::class)->authorize(auth('admin')->user());
                abort_unless(DB::table('failed_jobs')->where('uuid', $data['uuid'])->exists(), 404);
                Artisan::call('queue:retry', ['id' => [$data['uuid']]]);
                app(AuditLogger::class)->log('queue.retry_admin', auth('admin')->user(), 'job', null, ['uuid' => $data['uuid']]);
            }),
            Action::make('purgeExpiredUploads')->label('Clean expired uploads')->requiresConfirmation()->modalDescription('Queue cleanup of expired, unused uploads according to the existing retention policy.')->action(function () {
                app(ModerationService::class)->authorize(auth('admin')->user());
                PurgeExpiredUploads::dispatch();
                app(AuditLogger::class)->log('storage.purge_requested', auth('admin')->user());
            }),
        ];
    }
}
