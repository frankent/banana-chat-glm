<?php

return [
    'enabled' => (bool) env('CALLS_ENABLED', false),
    'key' => env('LIVEKIT_API_KEY', ''),
    'secret' => env('LIVEKIT_API_SECRET', ''),
    'url' => env('LIVEKIT_URL', ''),
    'internal_url' => env('LIVEKIT_INTERNAL_URL', 'http://livekit:7880'),
    'max_participants' => 8,
];
