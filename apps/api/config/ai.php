<?php

// FR-AI-019 — provider client knobs. Functional settings (limits, memory)
// live in the DB-backed SettingsService ('ai.*' keys per §4.4).
return [
    'retry_backoff' => env('AI_RETRY_BACKOFF', true),
    'allow_private_hosts' => env('AI_ALLOW_PRIVATE_HOSTS', false),

    // NFR-OPS-011 — circuit breaker + alert thresholds
    'breaker' => [
        'threshold' => (int) env('AI_BREAKER_THRESHOLD', 20),
        'open_seconds' => (int) env('AI_BREAKER_OPEN_SECONDS', 60),
    ],
    'alerts' => [
        'error_rate_window_minutes' => (int) env('AI_ALERT_ERROR_WINDOW', 5),
        'error_rate_threshold' => 0.10, // >10% failed in window (min 10 attempts)
        'min_attempts' => 10,
        'first_token_p95_ms' => 15000, // p95 > 15s
    ],
];
