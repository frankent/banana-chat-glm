<?php

namespace App\Domain\Ai;

use App\Models\AiProvider;
use Illuminate\Http\Client\ConnectionException;
use Illuminate\Support\Facades\Http;

/**
 * FR-AI-019 — OpenAI-compatible client over the Laravel Http stack.
 *
 * chatStream() reads the PSR-7 body incrementally; chat()/listModels()/
 * testConnection() are plain JSON calls (Http::fake-able in tests).
 * Error mapping: 401/403 → AI_PROVIDER_ERROR, 429 → 3 retries 2/4/8s,
 * 5xx → 2 retries, timeout → AI_PROVIDER_TIMEOUT, context-length 400 →
 * AiProviderException(AI_CONTEXT_OVERFLOW). Private-IP hosts are refused
 * unless AI_ALLOW_PRIVATE_HOSTS=true (SSRF guard).
 */
class OpenAiCompatibleProvider
{
    public function __construct(private readonly AiProvider $config) {}

    public static function make(?AiProvider $provider = null): self
    {
        return new self($provider ?? AiProvider::defaultProvider() ?? throw new \RuntimeException('no default ai provider'));
    }

    /**
     * @param  list<array{role: string, content: string}>  $messages
     * @return \Generator<int, array{type: string, text?: string, finish_reason?: ?string, usage?: array{prompt_tokens: int, completion_tokens: int}}> yields type=delta|usage|done
     */
    public function chatStream(array $messages, ?string $model = null): \Generator
    {
        $body = [
            'model' => $model ?? $this->config->model,
            'messages' => $messages,
            'stream' => true,
            'temperature' => (float) ($this->config->temperature ?? 0.7),
            'max_tokens' => (int) ($this->config->max_output_tokens ?? 4096),
            'stream_options' => ['include_usage' => true],
        ];

        $response = $this->post('/chat/completions', $body, stream: true, allowStreamOptionsRetry: true);

        $parser = new SseParser;
        $stream = $response->toPsrResponse()->getBody();

        while (! $stream->eof()) {
            $chunk = $stream->read(8192);
            if ($chunk === '') {
                continue;
            }

            foreach ($parser->push($chunk) as $event) {
                $choice = $event['choices'][0] ?? null;
                $deltaText = $choice['delta']['content'] ?? null;

                if (is_string($deltaText) && $deltaText !== '') {
                    yield ['type' => 'delta', 'text' => $deltaText];
                }

                if (isset($event['usage']) && is_array($event['usage'])) {
                    yield [
                        'type' => 'usage',
                        'usage' => [
                            'prompt_tokens' => (int) ($event['usage']['prompt_tokens'] ?? 0),
                            'completion_tokens' => (int) ($event['usage']['completion_tokens'] ?? 0),
                        ],
                    ];
                }

                if ($choice !== null && isset($choice['finish_reason']) && $choice['finish_reason'] !== null) {
                    yield ['type' => 'done', 'finish_reason' => (string) $choice['finish_reason']];
                }
            }

            if ($parser->isDone()) {
                break;
            }
        }

        if (! $parser->isDone()) {
            throw new AiProviderException('AI_PROVIDER_TIMEOUT', 'stream ended without [DONE]');
        }
    }

    /**
     * Non-streaming completion — used by memory extraction, compaction
     * and title generation (FR-AI-005/006/008).
     *
     * @param  list<array{role: string, content: string}>  $messages
     */
    public function chat(array $messages, ?string $model = null): string
    {
        $response = $this->post('/chat/completions', [
            'model' => $model ?? $this->config->model,
            'messages' => $messages,
            'temperature' => (float) ($this->config->temperature ?? 0.7),
            'max_tokens' => min(4096, (int) ($this->config->max_output_tokens ?? 4096)),
        ]);

        return (string) ($response->json('choices.0.message.content') ?? '');
    }

    /**
     * FR-AI-012 — GET {base}/models.
     *
     * @return list<string>
     */
    public function listModels(): array
    {
        $response = $this->get('/models');

        return collect($response->json('data') ?? [])->pluck('id')->filter()->values()->all();
    }

    /**
     * FR-AI-012 — models listing with a chat ping fallback when the
     * endpoint is missing (404/405).
     *
     * @return array{ok: bool, latency_ms: int, models?: list<string>, error?: string}
     */
    public function testConnection(): array
    {
        $start = microtime(true);

        try {
            $response = $this->get('/models');
            $latency = (int) ((microtime(true) - $start) * 1000);

            if ($response->status() === 404 || $response->status() === 405) {
                $ping = $this->post('/chat/completions', [
                    'model' => $this->config->model,
                    'messages' => [['role' => 'user', 'content' => 'ping']],
                    'max_tokens' => 1,
                ]);
                $latency = (int) ((microtime(true) - $start) * 1000);

                return $ping->successful()
                    ? ['ok' => true, 'latency_ms' => $latency, 'models' => []]
                    : ['ok' => false, 'latency_ms' => $latency, 'error' => mb_substr((string) $ping->body(), 0, 300)];
            }

            if (! $response->successful()) {
                return ['ok' => false, 'latency_ms' => $latency, 'error' => mb_substr((string) $response->body(), 0, 300)];
            }

            return [
                'ok' => true,
                'latency_ms' => $latency,
                'models' => collect($response->json('data') ?? [])->pluck('id')->filter()->values()->all(),
            ];
        } catch (\Throwable $e) {
            return ['ok' => false, 'latency_ms' => (int) ((microtime(true) - $start) * 1000), 'error' => mb_substr($e->getMessage(), 0, 300)];
        }
    }

    public function config(): AiProvider
    {
        return $this->config;
    }

    // ---- internals -------------------------------------------------

    private function post(string $path, array $body, bool $stream = false, bool $allowStreamOptionsRetry = false)
    {
        $this->guardHost();

        $attempt = fn (array $payload) => $this->client($stream)
            ->timeout($stream ? 600 : (int) ($this->config->timeout_seconds ?? 60))
            ->connectTimeout(min(10, (int) ($this->config->timeout_seconds ?? 60)))
            ->post($this->url($path), $payload);

        try {
            $response = $attempt($body);
        } catch (ConnectionException $e) {
            throw new AiProviderException('AI_PROVIDER_TIMEOUT', 'connection failed', $e->getMessage());
        }

        // provider that rejects stream_options → retry once without it
        if ($allowStreamOptionsRetry && $response->status() === 400 && str_contains((string) $response->body(), 'stream_options')) {
            unset($body['stream_options']);
            $response = $attempt($body);
        }

        if ($response->status() === 400 && preg_match('/context_length|maximum context|context window/i', (string) $response->body())) {
            throw new AiProviderException('AI_CONTEXT_OVERFLOW', 'context length exceeded', mb_substr((string) $response->body(), 0, 300));
        }

        $response = $this->retryFailures($response, $attempt, $body);

        if (! $response->successful()) {
            throw new AiProviderException('AI_PROVIDER_ERROR', "provider http {$response->status()}", mb_substr((string) $response->body(), 0, 300));
        }

        return $response;
    }

    private function get(string $path)
    {
        $this->guardHost();

        $attempt = fn () => $this->client(false)
            ->timeout((int) ($this->config->timeout_seconds ?? 60))
            ->connectTimeout(min(10, (int) ($this->config->timeout_seconds ?? 60)))
            ->get($this->url($path));

        try {
            $response = $attempt();
        } catch (ConnectionException $e) {
            throw new AiProviderException('AI_PROVIDER_TIMEOUT', 'connection failed', $e->getMessage());
        }

        $response = $this->retryFailures($response, fn () => $attempt());

        return $response;
    }

    /**
     * 429 → 3 retries (2/4/8s), 5xx → 2 retries. Backoff is skipped in
     * tests via AI_RETRY_BACKOFF=false so fake 429/5xx paths stay fast.
     */
    private function retryFailures($response, callable $attempt, ?array $body = null)
    {
        $backoff = config('ai.retry_backoff', true) ? fn (int $s) => sleep($s) : fn (int $s) => null;

        $retries = 0;
        $maxRetries = 0;

        while (true) {
            if ($response->status() === 429 && $retries < 3) {
                $maxRetries = 3;
            } elseif ($response->status() >= 500 && $response->status() < 600 && $retries < 2) {
                $maxRetries = 2;
            } else {
                break;
            }
            $retries++;
            $backoff([2, 4, 8][min($retries, 3) - 1]);
            $response = $attempt($body ?? []);
        }

        return $response;
    }

    private function client(bool $stream)
    {
        return Http::withHeaders(array_merge([
            'Authorization' => 'Bearer '.$this->config->plainApiKey(),
            'Content-Type' => 'application/json',
            'User-Agent' => 'orgchat/'.config('app.version', '1.0'),
        ], $this->config->extra_headers ?? []))
            ->withOptions(array_filter(['stream' => $stream ?: null]));
    }

    private function url(string $path): string
    {
        return rtrim($this->config->base_url, '/').$path;
    }

    /**
     * SSRF guard (FR-AI-019): base_url must be https and its host must
     * not resolve to a private range unless explicitly allowed.
     */
    private function guardHost(): void
    {
        $host = (string) parse_url($this->config->base_url, PHP_URL_HOST);
        $scheme = (string) parse_url($this->config->base_url, PHP_URL_SCHEME);

        if ($host === '' || (! in_array($scheme, ['https'], true) && app()->environment('production'))) {
            throw new AiProviderException('AI_PROVIDER_ERROR', 'base_url must be a valid https host');
        }

        if (config('ai.allow_private_hosts', false)) {
            return;
        }

        $ip = gethostbyname($host);
        if ($ip === $host) { // resolution failed — let the request surface the error
            return;
        }

        $private = filter_var($ip, FILTER_VALIDATE_IP, FILTER_FLAG_NO_PRIV_RANGE | FILTER_FLAG_NO_RES_RANGE) === false;
        if ($private && ! in_array($ip, ['127.0.0.1', '::1'])) {
            throw new AiProviderException('AI_PROVIDER_ERROR', "host resolves to private address {$ip}");
        }
    }
}
