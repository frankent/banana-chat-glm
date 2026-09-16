<?php

use App\Domain\PublicChat\PublicChatMessageWriter;
use App\Enums\PublicChatSenderKind;
use App\Enums\PublicChatStatus;
use App\Enums\PublicChatSystemEvent;
use App\Events\NotificationAlert;
use App\Events\PublicChatMessageCreated;
use App\Events\PublicChatMessageCreatedStaff;
use App\Events\PublicChatMessageDeleted;
use App\Events\PublicChatRoomChanged;
use App\Events\PublicChatRoomChangedStaff;
use App\Events\PublicChatRoomCreated;
use App\Models\PublicChatMessage;
use App\Models\PublicChatRoom;
use App\Models\User;
use App\Models\Workspace;
use App\Services\SettingsService;
use Illuminate\Database\QueryException;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Event;
use Illuminate\Support\Str;

/**
 * TC-PCHAT-010 / FR-PCHAT-011 — AUTO-CLAIM UNDER A REAL RACE.
 *
 * "Exactly one claim" is the design's load-bearing concurrency claim: the claim
 * runs INSIDE the same lockForUpdate transaction that assigns `seq`, so two
 * agents opening the same unassigned room and typing at the same moment must
 * produce one assignee, one `claimed` system row and a gapless seq sequence.
 *
 * A sequential pair of requests CANNOT test that — it passes with the lock
 * removed entirely, because the first transaction has already committed before
 * the second one reads. Both tests here therefore use a SECOND DATABASE SESSION:
 *
 *   1. the fork test runs two real writers in two OS processes that meet at a
 *      wall-clock barrier, which is the actual scenario;
 *   2. the lock-contention test pins WHY it is safe — the writer blocks on the
 *      room row itself, proven by a lock_timeout (SQLSTATE 55P03) rather than by
 *      a timing window that could go green by luck.
 *
 * ############ WHY THIS FILE COMMITS ITS FIXTURES ############
 * RefreshDatabase wraps each test in a transaction that is never committed, so
 * NOTHING a test creates is visible to any other connection. A second session —
 * a forked child or an explicit second connection — would see an empty database
 * and the "race" would be a fiction. Each test below therefore commits, and each
 * cleans up every row it created in a finally block, because after the commit
 * RefreshDatabase's rollback is a no-op and the rows would otherwise leak into
 * every test that runs after it in the same process.
 * ############################################################
 */
if (! function_exists('pchatRaceFixture')) {
    /**
     * Creates a workspace, two active members and one unassigned support room,
     * then COMMITS so other sessions can see them.
     *
     * @return array{0: PublicChatRoom, 1: User, 2: User, 3: Workspace}
     */
    function pchatRaceFixture(): array
    {
        $workspace = Workspace::factory()->create(['slug' => 'race-'.Str::lower(Str::random(8))]);

        $first = User::factory()->create(['username' => 'race'.Str::lower(Str::random(8))]);
        $second = User::factory()->create(['username' => 'race'.Str::lower(Str::random(8))]);

        $workspace->members()->attach($first->id, ['role' => 'owner']);
        $workspace->members()->attach($second->id, ['role' => 'member']);

        $room = PublicChatRoom::withoutGlobalScopes()->create([
            'workspace_id' => $workspace->id,
            'code' => PublicChatRoom::generateCode(),
            'customer_name' => 'Somchai',
            'provider_name' => 'ACME Support',
            'status' => PublicChatStatus::New->value,
            'locale' => 'th',
            'expires_at' => now()->addDays(30),
        ]);

        // The customer's opening message, so the agents are replying to
        // something and seq starts from a non-zero value.
        app(PublicChatMessageWriter::class)->write(
            $room, PublicChatSenderKind::Visitor, null, 'my order is late', (string) Str::uuid(),
        );

        while (DB::transactionLevel() > 0) {
            DB::commit();
        }

        return [$room->refresh(), $first, $second, $workspace];
    }
}

if (! function_exists('pchatRaceCleanup')) {
    /**
     * Undoes what the commit made permanent. public_chat_* and
     * workspace_members cascade from `workspaces`; the users are deleted
     * explicitly. Anything left behind would leak into every later test in this
     * process, so this runs from a finally, never from the happy path.
     *
     * The settings row matters as much as the rows: beforeEach turns
     * publicchat.enabled ON, the fixture commits, and a committed `true` would
     * silently flip the feature on for EVERY suite that runs after this file —
     * including any test asserting DEC-071's ships-disabled default, which would
     * then fail only when run in this order.
     */
    function pchatRaceCleanup(?Workspace $workspace, array $userIds): void
    {
        DB::purge();
        DB::reconnect();

        DB::table('app_settings')->where('key', 'publicchat.enabled')->delete();
        app(SettingsService::class)->flush();

        if ($workspace !== null) {
            DB::table('audit_logs')->where('workspace_id', $workspace->id)->delete();
            PublicChatMessage::withoutGlobalScopes()->where('workspace_id', $workspace->id)->forceDelete();
            PublicChatRoom::withoutGlobalScopes()->where('workspace_id', $workspace->id)->forceDelete();
            DB::table('workspace_members')->where('workspace_id', $workspace->id)->delete();
            DB::table('workspaces')->where('id', $workspace->id)->delete();
        }

        if ($userIds !== []) {
            DB::table('audit_logs')->whereIn('actor_id', $userIds)->delete();
            DB::table('access_tokens')->whereIn('user_id', $userIds)->delete();
            DB::table('sessions')->whereIn('user_id', $userIds)->delete();
            DB::table('users')->whereIn('id', $userIds)->delete();
        }
    }
}

beforeEach(function () {
    Event::fake([
        PublicChatMessageCreated::class,
        PublicChatMessageCreatedStaff::class,
        PublicChatMessageDeleted::class,
        PublicChatRoomChanged::class,
        PublicChatRoomChangedStaff::class,
        PublicChatRoomCreated::class,
        NotificationAlert::class,
    ]);

    app(SettingsService::class)->set('publicchat.enabled', true);
});

it('TC-PCHAT-010 claims exactly once when two agents reply in the same instant, in two processes', function () {
    if (! extension_loaded('pcntl') || ! extension_loaded('posix')) {
        test()->markTestSkipped('pcntl/posix are required to run two writers concurrently.');
    }

    $workspace = null;
    $userIds = [];

    try {
        [$room, $agentA, $agentB, $workspace] = pchatRaceFixture();
        $userIds = [$agentA->id, $agentB->id];

        // A wall-clock barrier: both children park until the same instant, so
        // the two BEGIN...lockForUpdate statements genuinely overlap instead of
        // being separated by fork() latency.
        $startAt = microtime(true) + 0.75;
        $pids = [];

        foreach ([$agentA, $agentB] as $agent) {
            $pid = pcntl_fork();

            if ($pid === -1) {
                test()->fail('pcntl_fork() failed; cannot run the race.');
            }

            if ($pid === 0) {
                // CHILD. The inherited PDO handle belongs to the parent — take a
                // private one before touching the database, or both processes
                // would be multiplexing one server-side session and the "race"
                // would be two statements on one connection.
                DB::purge();
                DB::reconnect();

                try {
                    usleep((int) max(0, ($startAt - microtime(true)) * 1_000_000));

                    app(PublicChatMessageWriter::class)->write(
                        PublicChatRoom::withoutGlobalScopes()->findOrFail($room->id),
                        PublicChatSenderKind::Agent,
                        $agent,
                        'we are on it',
                        (string) Str::uuid(),
                    );
                } catch (Throwable) {
                    // A loser that throws is still evidence: the assertions
                    // below count rows, and a missing reply shows up there.
                }

                // SIGKILL, never exit(): PHPUnit's shutdown handlers would
                // otherwise run a second time in the child and report a phantom
                // result for the whole suite.
                posix_kill(getmypid(), SIGKILL);
            }

            $pids[] = $pid;
        }

        foreach ($pids as $pid) {
            pcntl_waitpid($pid, $status);
        }

        // The parent's own connection was inherited by the children; take a
        // fresh one before reading what they wrote.
        DB::purge();
        DB::reconnect();

        $fresh = PublicChatRoom::withoutGlobalScopes()->findOrFail($room->id);

        $rows = PublicChatMessage::withoutGlobalScopes()
            ->where('room_id', $room->id)
            ->orderBy('seq')
            ->get();

        $claims = $rows->where('sender_kind', PublicChatSenderKind::System)
            ->where('system_event', PublicChatSystemEvent::Claimed);

        // EXACTLY ONE claim — the property the lock exists to guarantee.
        expect($claims)->toHaveCount(1)
            ->and($fresh->assigned_to)->toBeIn([$agentA->id, $agentB->id])
            ->and($fresh->status)->toBe(PublicChatStatus::InProgress)
            ->and($fresh->claimed_at)->not->toBeNull()
            ->and($fresh->first_response_at)->not->toBeNull();

        // The claim row names the agent the room was actually assigned to — a
        // second claimer overwriting assigned_to after the system row was
        // written would show up here and nowhere else. The actor is carried in
        // system_meta, not in sender_user_id: a system row's sender is NULL by
        // design (M3), which is also why it can never be attributed to a user
        // the customer would then see.
        $winner = $agentA->id === $fresh->assigned_to ? $agentA : $agentB;

        expect($claims->first()->sender_user_id)->toBeNull()
            ->and($claims->first()->system_meta['actor_username'] ?? null)->toBe($winner->username);

        // Both agents' replies survived: this is a race for the CLAIM, not for
        // the message. Losing a customer reply would be the worse bug.
        $agentRows = $rows->where('sender_kind', PublicChatSenderKind::Agent);
        expect($agentRows)->toHaveCount(2)
            ->and($agentRows->pluck('sender_user_id')->sort()->values()->all())
            ->toBe(collect([$agentA->id, $agentB->id])->sort()->values()->all());

        // GAPLESS AND UNIQUE seq under concurrency: 1 visitor + 2 agents + 1
        // system = 1..4 with no duplicate and no hole. A seq assigned outside
        // the lock produces either a gap or a unique violation here.
        $seqs = $rows->pluck('seq')->map(fn ($s) => (int) $s)->values()->all();
        expect($seqs)->toBe(range(1, $rows->count()))
            ->and($fresh->last_seq)->toBe($rows->count());
    } finally {
        pchatRaceCleanup($workspace, $userIds);
    }
});

it('TC-PCHAT-010 serialises the writer on the room row itself, not on a hopeful re-read', function () {
    $workspace = null;
    $userIds = [];

    try {
        [$room, $agentA, $agentB, $workspace] = pchatRaceFixture();
        // BOTH users, always: the fixture creates two, and a cleanup that
        // forgets one leaves a committed `users` row behind for every suite
        // that runs afterwards.
        $userIds = [$agentA->id, $agentB->id];

        // A genuinely separate session. Same credentials, different connection
        // name, so Laravel opens a second PDO instead of reusing the default.
        config(['database.connections.pchat_race' => config('database.connections.pgsql')]);
        $other = DB::connection('pchat_race');

        $other->beginTransaction();
        $other->select('select id from public_chat_rooms where id = ? for update', [$room->id]);

        // The writer must now BLOCK. Bound the wait so a regression is a fast
        // failure rather than a hung suite.
        DB::statement("SET lock_timeout = '750ms'");

        $blocked = false;

        try {
            app(PublicChatMessageWriter::class)->write(
                PublicChatRoom::withoutGlobalScopes()->findOrFail($room->id),
                PublicChatSenderKind::Agent,
                $agentA,
                'we are on it',
                (string) Str::uuid(),
            );
        } catch (QueryException $e) {
            // 55P03 lock_not_available — the writer asked for the room row and
            // waited for it. Without lockForUpdate this write sails through and
            // the test fails on $blocked, which is exactly the regression that
            // would let two agents both claim.
            $blocked = ($e->getPrevious()?->getCode() ?? $e->getCode()) === '55P03';
        } finally {
            DB::statement('SET lock_timeout = 0');
        }

        expect($blocked)->toBeTrue();

        // Nothing partial was left behind by the aborted attempt.
        DB::purge();
        DB::reconnect();
        expect(PublicChatMessage::withoutGlobalScopes()->where('room_id', $room->id)->count())->toBe(1)
            ->and(PublicChatRoom::withoutGlobalScopes()->findOrFail($room->id)->assigned_to)->toBeNull();

        // Release the blocker; the same write now succeeds and claims.
        $other->rollBack();
        $other->disconnect();

        app(PublicChatMessageWriter::class)->write(
            PublicChatRoom::withoutGlobalScopes()->findOrFail($room->id),
            PublicChatSenderKind::Agent,
            $agentA,
            'we are on it',
            (string) Str::uuid(),
        );

        $fresh = PublicChatRoom::withoutGlobalScopes()->findOrFail($room->id);

        expect($fresh->assigned_to)->toBe($agentA->id)
            ->and($fresh->status)->toBe(PublicChatStatus::InProgress);
    } finally {
        DB::purge('pchat_race');
        pchatRaceCleanup($workspace, $userIds);
    }
});
