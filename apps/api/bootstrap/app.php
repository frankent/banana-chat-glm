<?php

use App\Exceptions\ApiException;
use App\Http\Middleware\EnsureAccountActive;
use App\Http\Middleware\EnsurePasswordFresh;
use App\Http\Middleware\RequireMinimumAppVersion;
use App\Http\Middleware\SecurityHeaders;
use App\Http\Middleware\SetRequestId;
use App\Http\Middleware\WorkspaceContextMiddleware;
use Illuminate\Auth\AuthenticationException;
use Illuminate\Database\Eloquent\ModelNotFoundException;
use Illuminate\Foundation\Application;
use Illuminate\Foundation\Configuration\Exceptions;
use Illuminate\Foundation\Configuration\Middleware;
use Illuminate\Http\Request;
use Illuminate\Support\Facades\Response;
use Illuminate\Validation\ValidationException;
use Symfony\Component\HttpKernel\Exception\HttpException;
use Symfony\Component\HttpKernel\Exception\NotFoundHttpException;

$app = Application::configure(basePath: dirname(__DIR__))
    ->withRouting(
        web: __DIR__.'/../routes/web.php',
        api: __DIR__.'/../routes/api.php',
        commands: __DIR__.'/../routes/console.php',
        channels: __DIR__.'/../routes/channels.php',
        health: '/up',
    )
    ->withMiddleware(function (Middleware $middleware): void {
        $middleware->api(prepend: [SetRequestId::class]);

        // TASK-BE-025 — X-App-Version gate (426 APP_UPDATE_REQUIRED)
        $middleware->api(RequireMinimumAppVersion::class);

        // NFR-SEC-008 — baseline security headers on API + admin responses
        $middleware->prepend(SecurityHeaders::class);

        // No guest redirects — unauthenticated API calls get the 401 envelope
        $middleware->redirectGuestsTo(fn () => null);

        $middleware->alias([
            'account.active' => EnsureAccountActive::class,
            'password.fresh' => EnsurePasswordFresh::class,
            'workspace.context' => WorkspaceContextMiddleware::class,
        ]);
    })
    ->withExceptions(function (Exceptions $exceptions): void {
        // Spec §7 error envelope — applied to API paths only (admin panel uses its own UX)
        $renderApiError = function (Throwable $e, Request $request, int $status, string $code, string $message, array $details = []) {
            $requestId = $request->attributes->get('request_id') ?? $request->header('X-Request-Id');

            return Response::json([
                'error' => [
                    'code' => $code,
                    'message' => $message,
                    ...($details !== [] ? ['details' => $details] : []),
                    'request_id' => $requestId,
                ],
            ], $status);
        };

        $exceptions->render(function (ApiException $e, Request $request) use ($renderApiError) {
            return $renderApiError($e, $request, $e->status, $e->errorCode, $e->getMessage(), $e->details);
        });

        $exceptions->render(function (ValidationException $e, Request $request) use ($renderApiError) {
            return $renderApiError($e, $request, 422, 'VALIDATION_FAILED', 'ข้อมูลไม่ถูกต้อง', [
                'fields' => $e->errors(),
            ]);
        });

        $exceptions->render(function (AuthenticationException $e, Request $request) use ($renderApiError) {
            // API paths get the §7 envelope; the Filament panel needs a login redirect.
            if ($request->expectsJson() || $request->is('api/*')) {
                return $renderApiError($e, $request, 401, 'AUTH_TOKEN_INVALID', 'กรุณาเข้าสู่ระบบ');
            }

            return redirect()->guest('/admin/login');
        });

        $exceptions->render(function (ModelNotFoundException $e, Request $request) use ($renderApiError) {
            return $renderApiError($e, $request, 404, 'NOT_FOUND', 'ไม่พบข้อมูลที่ต้องการ');
        });

        $exceptions->render(function (NotFoundHttpException $e, Request $request) use ($renderApiError) {
            if ($request->is('api/*')) {
                return $renderApiError($e, $request, 404, 'NOT_FOUND', 'ไม่พบข้อมูลที่ต้องการ');
            }
        });

        $exceptions->render(function (HttpException $e, Request $request) use ($renderApiError) {
            // 429 rate limit + generic http errors on API paths
            if ($request->is('api/*')) {
                $retry = $e->getHeaders()['Retry-After'] ?? null;

                return $renderApiError(
                    $e,
                    $request,
                    $e->getStatusCode(),
                    $e->getStatusCode() === 429 ? 'RATE_LIMITED' : 'HTTP_ERROR',
                    $e->getStatusCode() === 429 ? 'ร้องขอถี่เกินไป กรุณารอสักครู่' : 'เกิดข้อผิดพลาด',
                    $retry !== null ? ['retry_after_seconds' => (int) $retry] : [],
                )->withHeaders($e->getHeaders());
            }
        });
    })->create();

return $app;
