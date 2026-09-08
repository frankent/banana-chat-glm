<?php

/*
 * FR-SETUP — first-run installer paths. Tests point these at temp files so
 * the wizard's .env writes never touch the real environment.
 */
return [
    'env_path' => env('SETUP_ENV_PATH', base_path('.env')),

    'marker_path' => env('SETUP_MARKER_PATH', storage_path('app/setup-complete')),

    /*
     * Connections the wizard may probe (FR-SETUP-003). Private ranges are
     * allowed by design — the whole point is pointing at docker/db hosts on
     * a private network; unlike AI providers this form is operator-only.
     */
    'probe_timeout' => (int) env('SETUP_PROBE_TIMEOUT', 5),
];
