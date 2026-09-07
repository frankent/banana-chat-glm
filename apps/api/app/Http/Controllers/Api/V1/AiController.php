<?php

namespace App\Http\Controllers\Api\V1;

use App\Domain\Ai\AiBroadcast;
use App\Domain\Ai\AiCircuitBreaker;
use App\Domain\Ai\AiGate;
use App\Domain\Ai\ContextBuilder;
use App\Domain\Ai\TokenEstimator;
use App\Http\Controllers\Controller;
use App\Jobs\GenerateAiReply;
use App\Models\AiConversation;
use App\Models\AiMessage;
use App\Models\AiProvider;
use App\Models\AiUsageDaily;
use App\Models\AiUserMemory;
use App\Models\User;
use App\Services\SettingsService;
use App\Support\WorkspaceContext;
use Illuminate\Http\JsonResponse;
use Illuminate\Http\Request;
use Illuminate\Http\Response;
use Illuminate\Support\Facades\Redis;

/**
 * API-100..113, 117, 118 — AI Assistant endpoints (FR-AI-001..008, 010).
 * Conversations are user-owned (DEC-015); X-Workspace-Id still gates
 * access and attributes usage.
 */
class AiController extends Controller
{
    public function __construct(
        private readonly AiGate $gate,
        private readonly SettingsService $settings,
        private readonly WorkspaceContext $context,
    ) {}

    /** API-100 — gate report for the sidebar entry + limits + today's usage. */
    public function status(Request $request): JsonResponse
    {
        [$provider, $error] = $this->gate->resolve($request->user()->id, $this->context->id(), requireConsent: false);

        if ($error === 'AI_DISABLED') {
            return $this->error(403, 'AI_DISABLED');
        }

        /** @var User $user */
        $user = $request->user();

        return response()->json(['data' => [
            'enabled' => true,
            'configured' => $provider !== null,
            'allowed_in_workspace' => $provider !== null && $this->context->id() !== null
                ? $provider->allowsWorkspace($this->context->id())
                : true,
            'provider' => $provider !== null ? [
                'name' => $provider->name,
                'model' => $provider->model,
                'window_size' => (int) $provider->window_size,
            ] : null,
            'limits' => [
                'daily_messages' => $this->dailyLimit($provider),
                'max_message_chars' => $this->settings->int('ai.max_message_chars'),
            ],
            'usage_today' => AiUsageDaily::today($user->id, $user->timezone ?? 'UTC'),
            'memory_enabled' => $user->ai_memory_enabled && $this->settings->bool('ai.memory.enabled'),
            'consented' => $user->ai_consented_at !== null,
        ]]);
    }

    /** API-109 — first-use disclosure acceptance (FR-AI-007/013). */
    public function consent(Request $request): Response|JsonResponse
    {
        $request->user()->forceFill(['ai_consented_at' => now()])->save();

        return response()->noContent();
    }

    /** API-101 — conversation list, newest first, cursor paginated. */
    public function conversations(Request $request): JsonResponse
    {
        if ($error = $this->requireGate($request)) {
            return $error;
        }

        $limit = min(50, (int) $request->query('limit', 30));
        $archived = $request->boolean('archived', false);

        $query = AiConversation::query()
            ->notDeleted()
            ->where('user_id', $request->user()->id)
            ->when($archived, fn ($q) => $q->whereNotNull('archived_at'), fn ($q) => $q->whereNull('archived_at'))
            ->orderByDesc('last_message_at');

        $cursor = $request->query('cursor');
        if (is_string($cursor) && $cursor !== '') {
            [$at, $id] = explode('|', $cursor, 2) + [null, null];
            if ($at !== null) {
                $query->where(function ($q) use ($at, $id) {
                    $q->where('last_message_at', '<', $at)
                        ->orWhere(fn ($q2) => $q2->where('last_message_at', $at)->where('id', '<', $id ?? ''));
                });
            }
        }

        $rows = $query->take($limit + 1)->get();

        $next = null;
        if ($rows->count() > $limit) {
            $last = $rows[$limit - 1];
            $next = $last->last_message_at?->toIso8601String().'|'.$last->id;
            $rows = $rows->take($limit);
        }

        return response()->json([
            'data' => [
                'conversations' => $rows->map(fn (AiConversation $c) => AiBroadcast::conversationSummary($c))->values()->all(),
                'next_cursor' => $next,
            ],
        ]);
    }

    /** API-102 */
    public function createConversation(Request $request): JsonResponse
    {
        if ($error = $this->requireGate($request)) {
            return $error;
        }

        $data = $request->validate([
            'title' => ['nullable', 'string', 'max:100'],
        ]);

        $conversation = AiConversation::create([
            'user_id' => $request->user()->id,
            'title' => $data['title'] ?? null,
            'title_source' => isset($data['title']) ? 'user' : null,
            'last_message_at' => now(),
        ]);

        return response()->json([
            'data' => ['conversation' => $this->conversationPayload($conversation)],
        ], 201);
    }

    /** API-103 */
    public function showConversation(Request $request, string $id): JsonResponse
    {
        $conversation = $this->ownedConversation($request, $id);
        if ($conversation === null) {
            return $this->error(404, 'NOT_FOUND');
        }

        return response()->json(['data' => ['conversation' => $this->conversationPayload($conversation)]]);
    }

    /** API-104 */
    public function updateConversation(Request $request, string $id): JsonResponse
    {
        $conversation = $this->ownedConversation($request, $id);
        if ($conversation === null) {
            return $this->error(404, 'NOT_FOUND');
        }

        $data = $request->validate([
            'title' => ['sometimes', 'nullable', 'string', 'max:100'],
            'archived' => ['sometimes', 'boolean'],
        ]);

        if (array_key_exists('title', $data)) {
            $conversation->title = $data['title'];
            if ($data['title'] !== null) {
                $conversation->title_source = 'user'; // manual edit blocks auto-title (FR-AI-008)
            }
        }
        if (array_key_exists('archived', $data)) {
            $conversation->archived_at = $data['archived'] ? now() : null;
        }
        $conversation->save();

        AiBroadcast::toUser($conversation->user_id, 'ai.conversation.updated', [
            'conversation_summary' => AiBroadcast::conversationSummary($conversation->refresh()),
        ]);

        return response()->json(['data' => ['conversation' => $this->conversationPayload($conversation)]]);
    }

    /** API-105 — soft delete, purge follows in ai.deleted_purge_days. */
    public function deleteConversation(Request $request, string $id): Response|JsonResponse
    {
        $conversation = $this->ownedConversation($request, $id);
        if ($conversation === null) {
            return $this->error(404, 'NOT_FOUND');
        }

        $conversation->forceFill([
            'deleted_at' => now(),
            'purge_after' => now()->addDays($this->settings->int('ai.deleted_purge_days')),
        ])->save();

        AiBroadcast::toUser($conversation->user_id, 'ai.conversation.deleted', ['conversation_id' => $conversation->id]);

        return response()->noContent();
    }

    /** API-106 — messages page, superseded hidden unless asked for. */
    public function messages(Request $request, string $id): JsonResponse
    {
        $conversation = $this->ownedConversation($request, $id);
        if ($conversation === null) {
            return $this->error(404, 'NOT_FOUND');
        }

        $limit = min(100, (int) $request->query('limit', 50));
        $beforeSeq = $request->query('before_seq');

        $rows = AiMessage::query()
            ->where('conversation_id', $conversation->id)
            ->when(! $request->boolean('include_superseded'), fn ($q) => $q->whereNull('superseded_at'))
            ->when($beforeSeq !== null && $beforeSeq !== '', fn ($q) => $q->where('seq', '<', (int) $beforeSeq))
            ->orderByDesc('seq')
            ->take($limit + 1)
            ->get();

        $hasMore = $rows->count() > $limit;
        $rows = $rows->take($limit);

        return response()->json([
            'data' => [
                'messages' => $rows->map(fn (AiMessage $m) => AiBroadcast::message($m, ...$this->streamState($m)))->values()->all(),
                'has_more_before' => $hasMore,
                'oldest_seq' => $rows->isNotEmpty() ? (int) $rows->min('seq') : null,
                'summary_up_to_seq' => (int) $conversation->summary_up_to_seq,
            ],
        ]);
    }

    /** API-107 — the send path: validate → pair insert → 202 + job. */
    public function send(Request $request, string $id): JsonResponse
    {
        if ($errorResponse = $this->requireGate($request)) {
            return $errorResponse;
        }

        $conversation = $this->ownedConversation($request, $id);
        if ($conversation === null) {
            return $this->error(404, 'NOT_FOUND');
        }

        $data = $request->validate([
            'client_message_id' => ['required', 'uuid'],
            'content' => ['required', 'string', 'max:'.(2 * $this->settings->int('ai.max_message_chars'))], // bytes headroom before char check
            'continue' => ['sometimes', 'boolean'],
        ]);

        $content = trim($data['content']);
        if ($content === '' && ! ($data['continue'] ?? false)) {
            return $this->error(422, 'VALIDATION_FAILED', ['content' => ['ต้องมีเนื้อหา']]);
        }
        if (mb_strlen($content) > $this->settings->int('ai.max_message_chars')) {
            return $this->error(422, 'AI_MESSAGE_TOO_LONG');
        }

        /** @var User $user */
        $user = $request->user();

        // idempotency: same client_message_id replays the original pair
        $existing = AiMessage::query()
            ->where('conversation_id', $conversation->id)
            ->where('client_message_id', $data['client_message_id'])
            ->first();
        if ($existing !== null) {
            $assistant = AiMessage::query()
                ->where('conversation_id', $conversation->id)
                ->where('role', 'assistant')
                ->where('seq', $existing->seq + 1)
                ->first();

            return response()->json([
                'data' => [
                    'user_message' => AiBroadcast::message($existing),
                    'assistant_message' => $assistant !== null ? AiBroadcast::message($assistant, ...$this->streamState($assistant)) : null,
                ],
            ]);
        }

        // FR-AI-010: daily quota in the user's timezone
        [$provider] = $this->gate->resolve($user->id, $this->context->id());
        $used = AiUsageDaily::messagesToday($user->id, $user->timezone ?? 'UTC');
        if ($used >= $this->dailyLimit($provider)) {
            $resets = now($user->timezone ?? 'UTC')->endOfDay()->utc();

            return $this->error(429, 'AI_QUOTA_EXCEEDED', ['resets_at' => $resets->toIso8601String()]);
        }

        // NFR-OPS-011: circuit open → refuse immediately, don't queue doomed work
        $breaker = AiCircuitBreaker::make();
        if ($breaker->isOpen()) {
            return $this->error(503, 'AI_PROVIDER_ERROR', ['retry_after_seconds' => max(1, $breaker->openRemaining())]);
        }

        // FR-AI-003: no in-flight generation in this conversation…
        $inFlight = AiMessage::query()
            ->where('conversation_id', $conversation->id)
            ->whereIn('status', ['pending', 'streaming'])
            ->exists();
        if ($inFlight) {
            return $this->error(409, 'AI_GENERATION_IN_PROGRESS');
        }

        // …and ≤ ai.max_concurrent_per_user across all conversations
        $concurrent = AiMessage::query()
            ->whereIn('status', ['pending', 'streaming'])
            ->where('role', 'assistant')
            ->where('user_id', $user->id)
            ->count();
        if ($concurrent >= $this->settings->int('ai.max_concurrent_per_user')) {
            return $this->error(409, 'AI_GENERATION_IN_PROGRESS', ['scope' => 'user']);
        }

        // FR-AI-005: latest user message alone > 50% of budget → reject
        $estimator = app(TokenEstimator::class);
        $builder = app(ContextBuilder::class);
        if ($provider !== null && $builder->messageTooLong($content, $conversation, $provider)) {
            return $this->error(422, 'AI_MESSAGE_TOO_LONG');
        }

        $pair = \DB::transaction(function () use ($conversation, $user, $data, $content, $provider): array {
            $seq = (int) AiConversation::query()
                ->whereKey($conversation->id)->lockForUpdate()->value('last_seq');
            $seqUser = $seq + 1;

            $userMessage = AiMessage::create([
                'conversation_id' => $conversation->id,
                'user_id' => $user->id,
                'workspace_id' => $this->context->id(),
                'seq' => $seqUser,
                'role' => 'user',
                'content' => $content,
                'status' => 'completed',
                'client_message_id' => $data['client_message_id'],
            ]);

            $assistantMessage = AiMessage::create([
                'conversation_id' => $conversation->id,
                'user_id' => $user->id,
                'workspace_id' => $this->context->id(),
                'seq' => $seqUser + 1,
                'role' => 'assistant',
                'content' => null,
                'status' => 'pending',
                'parent_message_id' => $userMessage->id,
                'model' => $provider->model ?? null,
            ]);

            $conversation->forceFill([
                'last_seq' => $seqUser + 1,
                'message_count' => $conversation->message_count + 2,
                'last_message_at' => now(),
            ])->save();

            return [$userMessage, $assistantMessage];
        });

        GenerateAiReply::dispatch($pair[1]->id)->onQueue('ai');
        AiUsageDaily::bump($user->id, $this->context->id(), messages: 1); // quota counter (FR-AI-010)

        return response()->json([
            'data' => [
                'user_message' => AiBroadcast::message($pair[0]),
                'assistant_message' => AiBroadcast::message($pair[1]),
            ],
        ], 202);
    }

    /** API-117 — single message; partial stream state from Redis while live. */
    public function showMessage(Request $request, string $id): JsonResponse
    {
        $message = AiMessage::query()->find($id);
        if ($message === null || $message->user_id !== $request->user()->id) {
            return $this->error(404, 'NOT_FOUND');
        }

        [$partial, $lastIndex] = $this->streamState($message);

        return response()->json(['data' => [
            'message' => AiBroadcast::message($message, $partial, $lastIndex),
            'partial_content' => $partial,
            'last_index' => $lastIndex,
        ]]);
    }

    /** API-108 — FR-AI-004 cancel: owner-only flag the job polls per delta. */
    public function cancel(Request $request, string $id): JsonResponse
    {
        $message = AiMessage::query()->find($id);
        if ($message === null || $message->user_id !== $request->user()->id) {
            return $this->error(404, 'NOT_FOUND');
        }

        if (! in_array($message->status, ['pending', 'streaming'], true)) {
            return $this->error(409, 'AI_NOT_GENERATING');
        }

        Redis::set("ai:cancel:{$message->id}", '1', 'EX', 600);

        return response()->json(['data' => ['message' => AiBroadcast::message($message, ...$this->streamState($message))]]);
    }

    /** API-118 — focus ping for push suppression (TTL from settings). */
    public function focus(Request $request, string $id): Response|JsonResponse
    {
        $conversation = $this->ownedConversation($request, $id);
        if ($conversation === null) {
            return $this->error(404, 'NOT_FOUND');
        }

        $data = $request->validate(['focused' => ['sometimes', 'boolean']]);
        $key = "ai:focus:{$conversation->id}:{$request->user()->id}";

        if (($data['focused'] ?? true) === false) {
            Redis::del($key);
        } else {
            Redis::set($key, '1', 'EX', $this->settings->int('ai.push_suppress_if_focused_seconds'));
        }

        return response()->noContent();
    }

    /** API-110 */
    public function memories(Request $request): JsonResponse
    {
        $rows = AiUserMemory::query()
            ->active()
            ->where('user_id', $request->user()->id)
            ->when($request->query('category'), fn ($q, $c) => $q->where('category', $c))
            ->orderByDesc('importance')
            ->orderByDesc('created_at')
            ->get();

        return response()->json(['data' => ['memories' => $rows->map(fn (AiUserMemory $m) => [
            'id' => $m->id,
            'content' => $m->content,
            'category' => $m->category,
            'importance' => $m->importance,
            'source' => $m->source,
            'source_conversation_id' => $m->source_conversation_id,
            'last_used_at' => $m->last_used_at?->toIso8601String(),
            'created_at' => $m->created_at?->toIso8601String(),
        ])->values()->all()]]);
    }

    /** API-113 — manual add (FR-AI-007, P1). */
    public function addMemory(Request $request): JsonResponse
    {
        if ($errorResponse = $this->requireGate($request)) {
            return $errorResponse;
        }

        $data = $request->validate([
            'content' => ['required', 'string', 'min:2', 'max:300'],
            'category' => ['required', 'string', 'in:profile,preference,project,other'],
        ]);

        $memory = AiUserMemory::create([
            'user_id' => $request->user()->id,
            'content' => trim($data['content']),
            'category' => $data['category'],
            'importance' => 3,
            'source' => 'user',
        ]);

        return response()->json(['data' => ['memory' => [
            'id' => $memory->id, 'content' => $memory->content, 'category' => $memory->category,
            'importance' => $memory->importance, 'source' => $memory->source,
        ]]], 201);
    }

    /** API-111 — user delete is immediate and hard (§4.2). */
    public function deleteMemory(Request $request, string $id): Response|JsonResponse
    {
        $deleted = AiUserMemory::query()->where('user_id', $request->user()->id)->whereKey($id)->delete();

        return $deleted > 0
            ? response()->noContent()
            : $this->error(404, 'NOT_FOUND');
    }

    /** API-112 */
    public function clearMemories(Request $request): Response|JsonResponse
    {
        AiUserMemory::query()->where('user_id', $request->user()->id)->delete();

        return response()->noContent();
    }

    // ---- helpers ---------------------------------------------------

    private function requireGate(Request $request): ?JsonResponse
    {
        [$provider, $error] = $this->gate->resolve($request->user()->id, $this->context->id());

        if ($error === null) {
            return null;
        }

        return match ($error) {
            'AI_PROVIDER_NOT_CONFIGURED' => $this->error(503, $error),
            default => $this->error(403, $error),
        };
    }

    private function dailyLimit(?AiProvider $provider): int
    {
        return $provider?->daily_message_limit_per_user
            ?? $this->settings->int('ai.daily_message_limit_per_user');
    }

    private function ownedConversation(Request $request, string $id): ?AiConversation
    {
        return AiConversation::query()
            ->notDeleted()
            ->whereKey($id)
            ->where('user_id', $request->user()->id)
            ->first();
    }

    /**
     * @return array{0: ?string, 1: ?int} partial content + last flushed index
     */
    private function streamState(AiMessage $message): array
    {
        if (! in_array($message->status, ['pending', 'streaming'], true)) {
            return [null, null];
        }

        $entries = Redis::lRange("ai:gen:{$message->id}", 0, -1);

        return [$entries === [] ? null : implode('', $entries), count($entries) - 1];
    }

    private function conversationPayload(AiConversation $conversation): array
    {
        $payload = AiBroadcast::conversationSummary($conversation);
        $payload['summary_up_to_seq'] = (int) $conversation->summary_up_to_seq;

        return $payload;
    }

    private function error(int $status, string $code, array $details = []): JsonResponse
    {
        return response()->json([
            'error' => ['code' => $code, 'message' => "AI error: {$code}", 'details' => $details ?: null],
        ], $status);
    }
}
