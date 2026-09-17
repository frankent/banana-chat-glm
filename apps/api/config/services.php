<?php

return [

    /*
    |--------------------------------------------------------------------------
    | Third Party Services
    |--------------------------------------------------------------------------
    |
    | This file is for storing the credentials for third party services such
    | as Mailgun, Postmark, AWS and more. This file provides the de facto
    | This file is for storing the credentials for third party services such
    | as Mailgun, Postmark, AWS and more. This file provides the de facto
    | place for this type of information. This file provides a conventional
    | location to locate such information.
    |
    */

    'postmark' => [
        'key' => env('POSTMARK_API_KEY'),
    ],

    'resend' => [
        'key' => env('RESEND_API_KEY'),
    ],

    'ses' => [
        'key' => env('AWS_ACCESS_KEY_ID'),
        'secret' => env('AWS_SECRET_ACCESS_KEY'),
        'region' => env('AWS_DEFAULT_REGION', 'us-east-1'),
    ],

    'slack' => [
        'notifications' => [
            'bot_user_oauth_token' => env('SLACK_BOT_USER_OAUTH_TOKEN'),
            'channel' => env('SLACK_BOT_USER_DEFAULT_CHANNEL'),
        ],
    ],

    // FR-NOTI-002 — empty key = stub mode (pushes logged, not delivered)
    // FR-NOTI-002/003 — FCM HTTP v1 (Appendix A). The old FCM_SERVER_KEY was a
    // legacy-API credential for an endpoint Google decommissioned; v1 authenticates
    // with a service account instead. Absent credentials => FcmPushSender logs a
    // warning and sends nothing, so dev/CI need no secrets.
    'fcm' => [
        'project_id' => env('FCM_PROJECT_ID', ''),
        // Path to the service-account JSON, or the JSON itself.
        'credentials' => env('FCM_CREDENTIALS_JSON', ''),
    ],

    // FR-MEDIA-006 — clamd (TASK-INF-010 container, or 127.0.0.1 on host dev).
    // Unreachable daemon ⇒ scans are skipped with an alert, never a failed upload.
    'clamav' => [
        'host' => env('CLAMAV_HOST', 'clamav'),
        'port' => (int) env('CLAMAV_PORT', 3310),
        'timeout' => (int) env('CLAMAV_TIMEOUT', 30),
        'enabled' => env('CLAMAV_ENABLED', true),
    ],

    // FR-MEDIA-004 — video poster/metadata (closes DEC-034). The api image
    // ships ffmpeg; host dev without it keeps the lite path (no poster).
    'ffmpeg' => [
        'binary' => env('FFMPEG_PATH', 'ffmpeg'),
        'probe_binary' => env('FFPROBE_PATH', 'ffprobe'),
        'timeout' => (int) env('FFMPEG_TIMEOUT', 120),
    ],

];
