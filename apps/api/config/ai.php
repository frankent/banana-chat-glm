<?php

// FR-AI-019 — provider client knobs. Functional settings (limits, memory)
// live in the DB-backed SettingsService ('ai.*' keys per §4.4).
return [
    'retry_backoff' => env('AI_RETRY_BACKOFF', true),
    'allow_private_hosts' => env('AI_ALLOW_PRIVATE_HOSTS', false),
];
