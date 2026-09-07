<?php

namespace App\Jobs;

use App\Models\AiConversation;
use Illuminate\Bus\Queueable;
use Illuminate\Contracts\Queue\ShouldQueue;
use Illuminate\Foundation\Bus\Dispatchable;
use Illuminate\Queue\InteractsWithQueue;
use Illuminate\Queue\SerializesModels;
use Illuminate\Support\Facades\Redis;

/**
 * §4.3 retention — purge AI conversations past their purge_after:
 * hard-delete messages + conversation; extracted memories survive (DEC-017).
 * Also sweeps stale Redis stream buffers (PruneAiRedisBuffers behavior).
 */
class PurgeDeletedAiConversations implements ShouldQueue
{
    use Dispatchable, InteractsWithQueue, Queueable, SerializesModels;

    public function handle(): void
    {
        AiConversation::query()
            ->whereNotNull('purge_after')
            ->where('purge_after', '<', now())
            ->select('id')
            ->chunkById(100, function ($conversations): void {
                foreach ($conversations as $conversation) {
                    \DB::table('ai_messages')->where('conversation_id', $conversation->id)->delete();
                    $conversation->delete();
                }
            });

        // belt-and-braces: clear stream buffers whose message is no longer live
        $keys = Redis::keys('ai:gen:*');
        foreach (array_slice($keys ?? [], 0, 500) as $key) {
            $messageId = substr($key, strlen('ai:gen:'));
            $live = \DB::table('ai_messages')->whereKey($messageId)
                ->whereIn('status', ['pending', 'streaming'])->exists();
            if (! $live) {
                Redis::del($key);
            }
        }
    }
}
