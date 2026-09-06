<?php

namespace App\Http\Controllers\Api\V1;

use App\Http\Controllers\Controller;
use Illuminate\Http\JsonResponse;
use Illuminate\Support\Facades\Cache;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Queue;
use Illuminate\Support\Facades\Storage;

/**
 * NFR-OPS-004 — /health checks db, redis, storage, reverb, queue lag.
 */
class HealthController extends Controller
{
    public function index(): JsonResponse
    {
        $checks = [];

        try {
            DB::select('select 1');
            $checks['database'] = 'ok';
        } catch (\Throwable $e) {
            $checks['database'] = 'error: '.$e->getMessage();
        }

        try {
            Cache::store('redis')->put('health:ping', 1, 5);
            $checks['redis'] = ((int) Cache::store('redis')->get('health:ping')) === 1 ? 'ok' : 'error';
        } catch (\Throwable $e) {
            $checks['redis'] = 'error: '.$e->getMessage();
        }

        try {
            $disk = Storage::disk(config('filesystems.default'));
            $disk->put('.health', 'ping');
            $checks['storage'] = $disk->get('.health') === 'ping' ? 'ok' : 'error';
        } catch (\Throwable $e) {
            $checks['storage'] = 'error: '.$e->getMessage();
        }

        try {
            $reverbHost = config('reverb.host') ?: '127.0.0.1';
            $reverbPort = (int) (config('reverb.port') ?: 8080);
            $socket = @fsockopen($reverbHost, $reverbPort, $errorCode, $errorText, 2);
            $checks['reverb'] = $socket !== false ? 'ok' : "error: {$errorText} ({$errorCode})";
            if ($socket !== false) {
                fclose($socket);
            }
        } catch (\Throwable $e) {
            $checks['reverb'] = 'error: '.$e->getMessage();
        }

        try {
            $size = Queue::size();
            $checks['queue'] = $size <= 60 ? "ok (lag={$size})" : "error (lag={$size})";
        } catch (\Throwable $e) {
            $checks['queue'] = 'error: '.$e->getMessage();
        }

        $healthy = ! collect($checks)->contains(fn ($v) => str_starts_with($v, 'error'));

        return response()->json([
            'status' => $healthy ? 'healthy' : 'degraded',
            'checks' => $checks,
            'checked_at' => now()->toIso8601String(),
        ], $healthy ? 200 : 503);
    }

    private function appId(): string
    {
        return (string) config('reverb.apps.apps.0.app_id', 'banana-chat');
    }
}
