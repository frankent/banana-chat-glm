<?php

namespace App\Http\Middleware;

use App\Enums\MemberStatus;
use App\Enums\WorkspaceStatus;
use App\Exceptions\ApiException;
use App\Models\Workspace;
use App\Models\WorkspaceMember;
use App\Support\WorkspaceContext;
use Closure;
use Illuminate\Http\Request;
use Symfony\Component\HttpFoundation\Response;

/**
 * Chain #4 (FR-AUTH-007): X-Workspace-Id required on workspace-scoped routes.
 * 400 WS_HEADER_REQUIRED / 403 WS_FORBIDDEN / 403 WS_ARCHIVED. Populates the
 * WorkspaceContext singleton consumed by WorkspaceScope (NFR-SEC-004).
 */
class WorkspaceContextMiddleware
{
    public function __construct(
        private readonly WorkspaceContext $context,
    ) {}

    public function handle(Request $request, Closure $next): Response
    {
        $header = trim((string) $request->header('X-Workspace-Id', ''));

        if ($header === '') {
            throw new ApiException('WS_HEADER_REQUIRED', 'ต้องระบุ header X-Workspace-Id', 400);
        }

        $workspace = Workspace::query()->where('slug', $header)->orWhere('id', $header)->first();

        if ($workspace === null) {
            // Cross-workspace probing must look like a plain 404 (spec §7 HTTP codes)
            throw new ApiException('NOT_FOUND', 'ไม่พบข้อมูลที่ต้องการ', 404);
        }

        $membership = WorkspaceMember::query()
            ->where('workspace_id', $workspace->id)
            ->where('user_id', $request->user()->id)
            ->where('status', MemberStatus::Active->value)
            ->first();

        if ($membership === null) {
            throw new ApiException('WS_FORBIDDEN', 'คุณไม่ได้เป็นสมาชิกของ workspace นี้', 403);
        }

        if ($workspace->status === WorkspaceStatus::Archived) {
            throw new ApiException('WS_ARCHIVED', 'workspace นี้ถูก archive แล้ว (อ่านได้อย่างเดียว)', 403);
        }

        $this->context->set($workspace, $membership);

        return $next($request);
    }
}
