<?php

use App\Domain\Ai\AiProviderException;
use App\Domain\Ai\OpenAiCompatibleProvider;
use App\Models\AiProvider;
use Illuminate\Support\Facades\Crypt;
use Illuminate\Support\Facades\Http;

/**
 * FR-AI-019 / DEC-075 — base_url scheme + SSRF guard.
 *
 * The guard runs before any HTTP call, so every case here asserts on whether the
 * faked request was ever attempted, not just on the absence of an exception.
 */
function schemeProvider(string $baseUrl): AiProvider
{
    return AiProvider::create([
        'name' => 'test',
        'provider_type' => 'openai_compatible',
        'base_url' => $baseUrl,
        'api_key_encrypted' => Crypt::encryptString('sk-test'),
        'api_key_last4' => 'test',
        'model' => 'm',
        'model_source' => 'custom',
        'window_size' => 1000,
        'max_output_tokens' => 100,
        'temperature' => 0.7,
        'system_prompt' => 'x',
        'is_enabled' => true,
        'is_default' => true,
    ]);
}

it('accepts an http base_url even in production', function () {
    app()->detectEnvironment(fn () => 'production');
    Http::fake(['*' => Http::response(['data' => []], 200)]);

    OpenAiCompatibleProvider::make(schemeProvider('http://ai.example.test/v1'))->listModels();

    Http::assertSent(fn ($r) => str_starts_with($r->url(), 'http://ai.example.test/v1'));
});

it('accepts an https base_url in production', function () {
    app()->detectEnvironment(fn () => 'production');
    Http::fake(['*' => Http::response(['data' => []], 200)]);

    OpenAiCompatibleProvider::make(schemeProvider('https://ai.example.test/v1'))->listModels();

    Http::assertSentCount(1);
});

// Before DEC-075 the scheme test only ran under `production`, so these reached Guzzle
// in every other environment. They must now be refused everywhere.
it('refuses a non-http scheme regardless of environment', function (string $env, string $url) {
    app()->detectEnvironment(fn () => $env);
    Http::fake();

    expect(fn () => OpenAiCompatibleProvider::make(schemeProvider($url))->listModels())
        ->toThrow(AiProviderException::class);

    Http::assertNothingSent();
})->with([
    ['production', 'file:///etc/passwd'],
    ['local', 'file:///etc/passwd'],
    ['local', 'gopher://ai.example.test/v1'],
    ['local', 'ftp://ai.example.test/v1'],
]);

it('still refuses a host that resolves to a private range', function () {
    config(['ai.allow_private_hosts' => false]);
    Http::fake();

    expect(fn () => OpenAiCompatibleProvider::make(schemeProvider('http://10.0.0.1/v1'))->listModels())
        ->toThrow(AiProviderException::class, 'host resolves to private address 10.0.0.1');

    Http::assertNothingSent();
});

// Regression for the bypass DEC-075 closed: gethostbyname() echoes an IP literal
// back, which used to take the "resolution failed" early return and skip the check.
it('refuses a private IP given as a literal, not just via DNS', function (string $url, string $ip) {
    config(['ai.allow_private_hosts' => false]);
    Http::fake();

    expect(fn () => OpenAiCompatibleProvider::make(schemeProvider($url))->listModels())
        ->toThrow(AiProviderException::class, "host resolves to private address {$ip}");

    Http::assertNothingSent();
})->with([
    ['http://192.168.112.1/v1', '192.168.112.1'],
    ['http://169.254.169.254/latest/meta-data', '169.254.169.254'],
    ['http://172.16.0.5/v1', '172.16.0.5'],
]);

it('allows a private host when the operator opts in', function () {
    config(['ai.allow_private_hosts' => true]);
    Http::fake(['*' => Http::response(['data' => []], 200)]);

    OpenAiCompatibleProvider::make(schemeProvider('http://192.168.112.50:11434/v1'))->listModels();

    Http::assertSent(fn ($r) => str_starts_with($r->url(), 'http://192.168.112.50:11434/v1'));
});

it('keeps allowing loopback', function () {
    config(['ai.allow_private_hosts' => false]);
    Http::fake(['*' => Http::response(['data' => []], 200)]);

    OpenAiCompatibleProvider::make(schemeProvider('http://127.0.0.1:11434/v1'))->listModels();

    Http::assertSentCount(1);
});
