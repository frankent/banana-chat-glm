<?php

use App\Filament\Pages\AiUsage;
use App\Models\User;
use App\Models\Workspace;
use Illuminate\Support\Facades\DB;
use Livewire\Livewire;

/**
 * FR-AI-014 / TC-ADM-066 — usage dashboard numbers match ai_usage_daily.
 */
beforeEach(function () {
    $this->admin = User::factory()->systemAdmin()->create();
    $this->be($this->admin, 'admin');

    $this->tony = User::factory()->create(['display_name' => 'Tony']);
    $this->ws = Workspace::factory()->create(['name' => 'Acme']);
});

test('TC-ADM-066 usage dashboard numbers match ai_usage_daily', function () {
    DB::table('ai_usage_daily')->insert([
        'user_id' => $this->tony->id,
        'workspace_id' => $this->ws->id,
        'date' => today()->toDateString(),
        'messages' => 4, 'tokens_in' => 150, 'tokens_out' => 90, 'tokens_memory' => 10, 'failed' => 1,
    ]);

    $page = Livewire::test(AiUsage::class);

    $summary = $page->instance()->summary();
    expect($summary)->toBe([
        'messages' => 4,
        'tokens_in' => 150,
        'tokens_out' => 90,
        'tokens_memory' => 10,
        'failed' => 1,
    ]);

    $workspaces = $page->instance()->byWorkspace();
    expect($workspaces)->toHaveCount(1)
        ->and($workspaces[0]['label'])->toBe('Acme')
        ->and($workspaces[0]['tokens'])->toBe(250);

    $users = $page->instance()->topUsers();
    expect($users)->toHaveCount(1)
        ->and($users[0]['name'])->toBe('Tony')
        ->and($users[0]['messages'])->toBe(4);
});

test('month filter scopes to the selected month only', function () {
    DB::table('ai_usage_daily')->insert([
        ['user_id' => $this->tony->id, 'workspace_id' => $this->ws->id, 'date' => today()->toDateString(),
            'messages' => 2, 'tokens_in' => 10, 'tokens_out' => 5, 'tokens_memory' => 0, 'failed' => 0],
        ['user_id' => $this->tony->id, 'workspace_id' => $this->ws->id, 'date' => today()->subMonth()->startOfMonth()->toDateString(),
            'messages' => 9, 'tokens_in' => 900, 'tokens_out' => 0, 'tokens_memory' => 0, 'failed' => 0],
    ]);

    $page = Livewire::test(AiUsage::class)
        ->set('month', today()->format('Y-m'));

    expect($page->instance()->summary()['messages'])->toBe(2);

    $page = Livewire::test(AiUsage::class)
        ->set('month', today()->subMonth()->format('Y-m'));

    expect($page->instance()->summary()['messages'])->toBe(9)
        ->and($page->instance()->summary()['tokens_in'])->toBe(900);
});

test('guest is redirected to the admin login', function () {
    auth('admin')->logout();

    $this->get('/admin/ai-usage')->assertRedirect();
});
