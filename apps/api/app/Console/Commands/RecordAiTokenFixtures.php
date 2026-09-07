<?php

namespace App\Console\Commands;

use App\Domain\Ai\OpenAiCompatibleProvider;
use App\Models\AiProvider;
use Illuminate\Console\Command;
use Illuminate\Support\Facades\Http;

/**
 * TASK-QA-008 / TC-AI-037 — record real provider token counts for the
 * TokenEstimator fixture file. Sends each sample to the default provider
 * (max_tokens 1, no system prompt) and stores usage.prompt_tokens back
 * into tests/Fixtures/Ai/tokens.json so the ±15% drift test has real
 * values to check against.
 *
 * Usage (against dev/test provider creds, never production):
 *   php artisan ai:tokens-fixtures
 */
class RecordAiTokenFixtures extends Command
{
    protected $signature = 'ai:tokens-fixtures {--path= : absolute path to tokens.json (defaults to the repo test fixtures)}';

    protected $description = 'Record live provider token counts into the TokenEstimator test fixture (TASK-QA-008)';

    public function handle(): int
    {
        if (app()->environment('production')) {
            $this->error('Refusing to run in production — this command spends real provider quota.');

            return self::FAILURE;
        }

        $providerRow = AiProvider::defaultProvider();
        if ($providerRow === null) {
            $this->error('No default AI provider configured.');

            return self::FAILURE;
        }

        $path = (string) ($this->option('path') ?: dirname(__DIR__, 3).'/tests/Fixtures/Ai/tokens.json');
        if (! is_file($path)) {
            $this->error("Fixture file not found: {$path}");

            return self::FAILURE;
        }

        $fixture = json_decode((string) file_get_contents($path), true);
        $provider = OpenAiCompatibleProvider::make($providerRow);

        foreach ($fixture['samples'] as &$sample) {
            $response = Http::withHeaders([
                'Authorization' => 'Bearer '.$providerRow->plainApiKey(),
                'Content-Type' => 'application/json',
            ])
                ->timeout($providerRow->timeout_seconds ?? 60)
                ->post(rtrim($providerRow->base_url, '/').'/chat/completions', [
                    'model' => $providerRow->model,
                    'messages' => [['role' => 'user', 'content' => $sample['text']]],
                    'max_tokens' => 1,
                ]);

            if (! $response->successful()) {
                $this->warn("{$sample['id']}: provider error {$response->status()} — left unchanged");

                continue;
            }

            $sample['provider_prompt_tokens'] = (int) ($response->json('usage.prompt_tokens') ?? 0);
            $this->info("{$sample['id']}: {$sample['provider_prompt_tokens']} tokens");
        }

        $fixture['_recorded_at'] = now()->toIso8601String();
        $fixture['_recorded_with'] = $providerRow->model.' @ '.$providerRow->base_url;

        file_put_contents($path, json_encode(
            $fixture,
            JSON_PRETTY_PRINT | JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES
        )."\n");

        $this->table(['id', 'tokens'], array_map(
            fn ($s) => [$s['id'], $s['provider_prompt_tokens'] ?? '—'],
            $fixture['samples'],
        ));

        return self::SUCCESS;
    }
}
