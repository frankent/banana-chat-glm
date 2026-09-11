<?php

namespace App\Http\Controllers\Api\V1;

use App\Domain\Calls\MeetingService;
use App\Enums\UserStatus;
use App\Http\Controllers\Controller;
use App\Models\Meeting;
use App\Models\User;
use App\Support\WorkspaceContext;
use Illuminate\Http\Request;
use Illuminate\Support\Facades\Auth;

class MeetingController extends Controller
{
    public function __construct(private MeetingService $meetings, private WorkspaceContext $context) {}

    private function enabled(): void
    {
        abort_unless(config('calls.enabled') && config('calls.secret') && config('calls.url'), 503);
    }

    private function identity(Request $r): ?User
    {
        if (! $r->bearerToken()) {
            return null;
        }
        $user = Auth::guard('api')->user();
        abort_unless($user, 401);
        abort_unless($user->status === UserStatus::Active && ! $user->must_change_password, 403);

        return $user;
    }

    private function find(string $code): Meeting
    {
        $this->enabled();
        $m = Meeting::where('code', $code)->firstOrFail();
        abort_unless($this->meetings->available($m), 410);

        return $m;
    }

    public function index(Request $r)
    {
        $this->enabled();

        return response()->json(['data' => Meeting::where('workspace_id', $this->context->id())->where('created_by', $r->user()->id)->latest()->limit(100)->get()->map(fn ($m) => $this->meetings->summary($m))]);
    }

    public function create(Request $r)
    {
        $this->enabled();
        $d = $r->validate(['title' => ['required', 'string', 'max:120'], 'expires_in_hours' => ['sometimes', 'integer', 'min:1', 'max:168']]);
        $m = Meeting::create(['workspace_id' => $this->context->id(), 'created_by' => $r->user()->id, 'title' => $d['title'], 'code' => bin2hex(random_bytes(32)), 'expires_at' => now()->addHours($d['expires_in_hours'] ?? 168)]);

        return response()->json(['data' => $this->meetings->summary($m)], 201);
    }

    public function end(Request $r, string $id)
    {
        $m = Meeting::where('workspace_id', $this->context->id())->where('created_by', $r->user()->id)->findOrFail($id);
        $this->meetings->end($m);

        return response()->noContent();
    }

    public function show(Request $r, string $code)
    {
        $u = $this->identity($r);
        $m = $this->find($code);

        return response()->json(['data' => ['title' => $m->title, 'expires_at' => $m->expires_at, 'capacity' => config('calls.max_participants'), 'identity' => $u ? ['name' => $u->display_name, 'member' => true] : null]])->header('Cache-Control', 'no-store');
    }

    public function join(Request $r, string $code)
    {
        $u = $this->identity($r);
        $m = $this->find($code);
        $d = $r->validate(['name' => ['nullable', 'string', 'max:80'], 'participant_token' => ['nullable', 'string', 'size:64']]);

        return response()->json(['data' => $this->meetings->join($m, $u, $u ? $r->attributes->get('chat_session')->id : null, isset($d['name']) ? trim($d['name']) : null, $d['participant_token'] ?? null)])->header('Cache-Control', 'no-store');
    }

    public function leave(Request $r, string $code)
    {
        $m = Meeting::where('code', $code)->firstOrFail();
        $d = $r->validate(['participant_token' => ['required', 'string', 'max:128']]);
        $this->meetings->leave($m, $d['participant_token']);

        return response()->noContent();
    }
}
