<?php

return [
    'enabled' => (bool) env('CALLS_ENABLED', false),
    'key' => env('LIVEKIT_API_KEY', ''),
    'secret' => env('LIVEKIT_API_SECRET', ''),
    'url' => env('LIVEKIT_URL', ''),
    'internal_url' => env('LIVEKIT_INTERNAL_URL', 'http://livekit:7880'),
    // Group/public capacity moved to the runtime setting `call.max_participants`
    // (FR-CALL-006 / DEC-057, default 8, range 2–50, admin-editable).
    // FR-CALL-009 / DEC-086: participant join-token lifetime (seconds, default
    // 6h). Long enough to survive a backgrounded phone's reconnect; revocation
    // is unaffected — authorizeMedia re-checks participantAllowed per connect.
    'token_ttl' => (int) env('CALLS_TOKEN_TTL', 21600),
];
