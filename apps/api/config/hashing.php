<?php

return [
    /*
    | FR-AUTH-005: argon2id (memory 64MB, time 4). Test env lowers cost for speed.
    */
    'driver' => env('HASH_DRIVER', 'argon2id'),

    'bcrypt' => [
        'rounds' => env('BCRYPT_ROUNDS', 12),
    ],

    'argon' => [
        'memory' => (int) env('HASH_ARGON_MEMORY', 65536), // 64 MB
        'threads' => (int) env('HASH_ARGON_THREADS', 2),
        'time' => (int) env('HASH_ARGON_TIME', 4),
    ],
];
