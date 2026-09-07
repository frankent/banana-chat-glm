<?php

namespace App\Jobs;

use App\Domain\Ai\AiProviderException;
use App\Domain\Ai\MemoryExtractionParser;
use App\Domain\Ai\OpenAiCompatibleProvider;
use App\Models\AiConversation;
use App\Models\AiMessage;
use App\Models\AiProvider;
use App\Models\AiUsageDaily;
use App\Models\AiUserMemory;
use App\Models\User;
use App\Services\SettingsService;
use Illuminate\Bus\Queueable;
use Illuminate\Contracts\Queue\ShouldBeUnique;
use Illuminate\Contracts\Queue\ShouldQueue;
use Illuminate\Foundation\Bus\Dispatchable;
use Illuminate\Queue\InteractsWithQueue;
use Illuminate\Queue\SerializesModels;
use Illuminate\Support\Facades\DB;

/**
 * FR-AI-006 — after an assistant turn completes, ask the memory model to
 * propose {add, update, delete} memory diffs, then post-process them
 * (fence-tolerant parse, trgm dedupe ≥ 0.85, cap + eviction).
 * Unique per conversation so consecutive turns collapse into one run.
 */
class ExtractMemories implements ShouldBeUnique, ShouldQueue
{
    use Dispatchable, InteractsWithQueue, Queueable, SerializesModels;

    public int $tries = 2;

    public function __construct(
        public readonly string $conversationId,
        public readonly string $messageId,
    ) {}

    public function uniqueId(): string
    {
        return $this->conversationId;
    }

    public function handle(MemoryExtractionParser $parser, SettingsService $settings): void
    {
        $conversation = AiConversation::query()->findOrFail($this->conversationId);
        $user = User::query()->findOrFail($conversation->user_id);

        if (! $user->ai_memory_enabled || ! $settings->bool('ai.memory.enabled')) {
            return; // memories frozen, not deleted (FR-AI-006 AC)
        }

        $providerRow = AiProvider::defaultProvider();
        if ($providerRow === null) {
            return;
        }

        $recent = AiMessage::query()
            ->where('conversation_id', $conversation->id)
            ->whereIn('status', ['completed', 'cancelled'])
            ->whereNull('superseded_at')
            ->orderByDesc('seq')
            ->limit(6)
            ->get()
            ->reverse()
            ->values();

        if ($recent->isEmpty()) {
            return;
        }

        $memories = AiUserMemory::query()->active()->where('user_id', $user->id)->get();
        $forced = $recent->contains(fn (AiMessage $m) => $m->role === 'user'
            && preg_match('/^\s*(จำไว้ว่า|remember that)/iu', (string) $m->content) === 1);

        $roster = $memories->map(fn (AiUserMemory $m) => ['id' => $m->id, 'content' => $m->content])->values()->all();
        $transcript = $recent->map(fn (AiMessage $m) => "{$m->role}: {$m->content}")->implode("\n");

        $prompt = <<<'PROMPT'
คุณคือระบบจำความจำของแอปแชท วิเคราะห์บทสนทนาแล้วตอบ **JSON เท่านั้น** (ไม่มีคำอธิบาย) รูปแบบ:
{"add":[{"content":"...","category":"profile|preference|project|other","importance":1-5}],"update":[{"id":"...","content":"..."}],"delete":["id"]}

กติกา:
- เก็บเฉพาะข้อเท็จจริง/ความชอบ/บริบทงานที่ผู้ใช้บอกเองและมีประโยชน์ระยะยาว (ชื่อเล่น บทบาท โปรเจกต์ สไตล์คำตอบที่ชอบ ภาษา)
- ห้ามเก็บ รหัสผ่าน/คีย์/เลขบัตร/ข้อมูลการเงิน/สุขภาพ/ศาสนา/การเมือง/ข้อมูลบุคคลที่สาม เว้นแต่ผู้ใช้สั่ง "จำไว้ว่า…" ชัดเจน
- แต่ละ memory ≤ 300 ตัวอักษร ภาษาเดียวกับผู้ใช้
- ถ้าไม่มีอะไรควรเก็บ ตอบ {"add":[],"update":[],"delete":[]}
PROMPT;

        if ($forced) {
            $prompt .= "\n- ผู้ใช้สั่ง \"จำไว้ว่า…\" ชัดเจน: จะต้องมีรายการใน add เสมอ";
        }

        $reply = $this->chat($providerRow, [
            ['role' => 'system', 'content' => $prompt],
            ['role' => 'user', 'content' => "## memories ปัจจุบัน\n".json_encode($roster, JSON_UNESCAPED_UNICODE)."\n\n## บทสนทนาล่าสุด\n".$transcript],
        ]);

        $diff = $parser->parse($reply);
        if ($diff === ['add' => [], 'update' => [], 'delete' => []] && ! $forced) {
            return;
        }

        $touched = 0;

        foreach ($diff['delete'] as $id) {
            $touched += AiUserMemory::query()->where('user_id', $user->id)->whereKey($id)->delete();
        }

        foreach ($diff['update'] as $upd) {
            $touched += AiUserMemory::query()
                ->where('user_id', $user->id)->whereKey($upd['id'])
                ->update(['content' => $upd['content']]);
        }

        foreach ($diff['add'] as $add) {
            // trgm dedupe ≥ 0.85 → update the near-duplicate instead
            $near = DB::selectOne(
                'SELECT id FROM ai_user_memories WHERE user_id = ? AND deleted_at IS NULL AND similarity(content, ?) >= 0.85 LIMIT 1',
                [$user->id, $add['content']],
            );

            if ($near !== null) {
                AiUserMemory::query()->whereKey($near->id)->update([
                    'content' => $add['content'], 'category' => $add['category'], 'importance' => $add['importance'],
                ]);
                $touched++;

                continue;
            }

            AiUserMemory::create([
                'user_id' => $user->id,
                'content' => $add['content'],
                'category' => $add['category'],
                'importance' => $add['importance'],
                'source' => 'extracted',
                'source_conversation_id' => $conversation->id,
                'source_message_id' => $this->messageId,
            ]);
            $touched++;
        }

        if ($touched > 0) {
            $this->evictOverCap($user->id, $settings->int('ai.memory.max_per_user'));
            AiUsageDaily::bump($user->id, null, tokensMemory: 1);
        }
    }

    private function chat(AiProvider $providerRow, array $messages): string
    {
        $client = OpenAiCompatibleProvider::make($providerRow);

        try {
            $reply = $client->chat($messages, $providerRow->memory_model);
        } catch (AiProviderException) {
            return '';
        }

        return $reply;
    }

    /**
     * cap memories at max_per_user — evict lowest importance, then oldest last_used_at.
     */
    private function evictOverCap(string $userId, int $cap): void
    {
        $count = AiUserMemory::query()->active()->where('user_id', $userId)->count();
        if ($count <= $cap) {
            return;
        }

        AiUserMemory::query()->active()
            ->where('user_id', $userId)
            ->orderBy('importance')
            ->orderBy('last_used_at')
            ->limit($count - $cap)
            ->delete();
    }
}
