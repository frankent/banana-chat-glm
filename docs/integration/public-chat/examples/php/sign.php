<?php
/**
 * Banana Chat — Public Chat partner API (Tier 1, HMAC).
 * Creates a support room and prints the visitor link.
 *
 * Plain PHP 8+, no framework, no Composer. Uses ext-curl if present and falls
 * back to file_get_contents() otherwise.
 *
 *   PCHAT_KEY_ID=pck_... PCHAT_SECRET=pcs_... php sign.php
 *
 * Environment:
 *   PCHAT_KEY_ID    required. 'pck_' + 28 lowercase hex (32 chars). Public, safe to log.
 *   PCHAT_SECRET    required. 'pcs_' + 64 lowercase hex (68 chars). The HMAC key is the
 *                   WHOLE string, prefix included. Shown once at issuance; never printed here.
 *   PCHAT_BASE_URL  default https://chat.gamecoms.net
 *   PCHAT_TIMESTAMP override the unix-seconds timestamp (debugging / reproducible runs)
 *   PCHAT_NONCE     override the nonce (debugging / reproducible runs)
 *   PCHAT_BODY_FILE read the request body verbatim from this file instead of building one
 *   PCHAT_DRY_RUN=1 print the canonical string and signature, send nothing
 */

declare(strict_types=1);

const PCHAT_VERSION = 'v1';

/**
 * The canonical string. Mirrors VerifyPublicChatSignature::canonical() exactly:
 * six lines joined with "\n", NO trailing newline.
 *
 *   1  v1                    the literal version tag
 *   2  HTTP METHOD, uppercase
 *   3  request path — leading slash, INCLUDES /api/v1, EXCLUDES the query string
 *   4  the X-PChat-Timestamp value, verbatim
 *   5  the X-PChat-Nonce value, verbatim
 *   6  lowercase hex sha256 of the RAW request body bytes (sha256("") if no body)
 */
function pchat_canonical(string $method, string $path, string $timestamp, string $nonce, string $rawBody): string
{
    return implode("\n", [
        PCHAT_VERSION,
        strtoupper($method),
        $path,
        $timestamp,
        $nonce,
        // >>> THE BUG EVERYONE HITS <<<
        // Hash the EXACT bytes that go on the wire. $rawBody is already a string
        // here and that same string is handed to curl below — it is never
        // re-serialised. A second json_encode() (or handing curl an array) can
        // change key order, whitespace or unicode escaping, which changes this
        // digest and produces intermittent 401s.
        hash('sha256', $rawBody),
    ]);
}

function pchat_sign(string $secret, string $canonical): string
{
    return PCHAT_VERSION.'='.hash_hmac('sha256', $canonical, $secret);
}

/**
 * Nonce must match [A-Za-z0-9_-]{16,64}. Hex is always safe.
 * Do NOT use base64: '+' '/' '=' fail the header check and you get a
 * 401 API_KEY_INVALID that looks like a bad key.
 */
function pchat_nonce(): string
{
    return bin2hex(random_bytes(16));
}

// ---------------------------------------------------------------------------

$baseUrl = rtrim(getenv('PCHAT_BASE_URL') ?: 'https://chat.gamecoms.net', '/');
$keyId = (string) (getenv('PCHAT_KEY_ID') ?: '');
$secret = (string) (getenv('PCHAT_SECRET') ?: '');
$dryRun = getenv('PCHAT_DRY_RUN') === '1';

if (! $dryRun && ($keyId === '' || $secret === '')) {
    fwrite(STDERR, "Set PCHAT_KEY_ID and PCHAT_SECRET (or PCHAT_DRY_RUN=1).\n");
    exit(2);
}

$method = 'POST';
// No trailing slash. getPathInfo() keeps one if you send it, and your
// signature will not have it.
$path = '/api/v1/partner/public-chat/rooms';

// Serialise the body ONCE, into a string. Everything downstream — the digest
// and the wire — uses this exact string. The JSON_UNESCAPED_* flags only make
// it readable; they do not matter to the signature because we sign this result.
$bodyFile = getenv('PCHAT_BODY_FILE');
$body = $bodyFile
    ? file_get_contents($bodyFile)
    : json_encode([
        'customer_name' => 'สมชาย ใจดี',    // required, 1..120
        'provider_name' => 'ACME Support',  // required, 1..120 — shown to the visitor
        'external_ref' => 'ticket-'.time(), // optional, <=120. Reuse it and the create is
                                            // idempotent: 200 + the same room instead of 201.
        'locale' => 'th',                   // optional, 'th' or 'en'
        'meta' => ['plan' => 'gold'],       // optional. Partner-private: stored, shown to
                                            // staff, NEVER served to the visitor.
                                            // <=8192 bytes JSON-encoded.
    ], JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES);

$timestamp = (string) (getenv('PCHAT_TIMESTAMP') ?: time());
$nonce = (string) (getenv('PCHAT_NONCE') ?: pchat_nonce());

$canonical = pchat_canonical($method, $path, $timestamp, $nonce, $body);
$signature = pchat_sign($secret, $canonical);

echo "--- request ------------------------------------------------\n";
echo $method.' '.$baseUrl.$path."\n";
echo 'X-PChat-Key:       '.($keyId !== '' ? $keyId : '(unset)')."\n";
echo 'X-PChat-Timestamp: '.$timestamp."\n";
echo 'X-PChat-Nonce:     '.$nonce."\n";
echo 'X-PChat-Signature: '.$signature."\n";
echo 'body:              '.$body."\n";
echo 'body sha256:       '.hash('sha256', $body)."\n";
echo "canonical (\\n shown literally):\n";
echo '  '.str_replace("\n", '\n', $canonical)."\n";
echo 'canonical hex:     '.bin2hex($canonical)."\n";

if ($dryRun) {
    echo "\n(PCHAT_DRY_RUN=1 — nothing sent)\n";
    exit(0);
}

$headers = [
    // Without Content-Type Laravel does not parse the JSON and you get a
    // confusing 422.
    'Content-Type: application/json',
    'Accept: application/json',
    // Always identify your integration. A default or missing User-Agent can be
    // blocked by the CDN in front of the API before the request ever reaches it
    // — a 403 with no {"error":{"code":...}} envelope is that, not a signing bug.
    'User-Agent: banana-chat-partner-example/1.0 (+php)',
    'X-PChat-Key: '.$keyId,
    'X-PChat-Timestamp: '.$timestamp,
    'X-PChat-Nonce: '.$nonce,
    'X-PChat-Signature: '.$signature,
];

[$status, $respHeaders, $responseBody] = pchat_post($baseUrl.$path, $headers, $body);

echo "\n--- response -----------------------------------------------\n";
echo 'status: '.$status."\n";
if (isset($respHeaders['retry-after'])) {
    echo 'Retry-After: '.$respHeaders['retry-after']."\n";
}
echo $responseBody."\n";

$payload = json_decode($responseBody, true);
// Branch on error.code, NEVER on error.message: messages may be in Thai.
$code = $payload['error']['code'] ?? null;

echo "\n--- what that means ----------------------------------------\n";

if ($status === 201) {
    echo "Room created. Give this link to the customer over TLS:\n";
    echo '  '.$payload['url']."\n";
    echo 'Keep room.id ('.$payload['room']['id'].") — every later partner call uses the ULID,\n";
    echo "never the code. The code is the visitor credential; do not put it in logs.\n";
} elseif ($status === 200) {
    echo "Idempotent replay: this external_ref already had a room. Not an error.\n";
    echo '  '.$payload['url']."\n";
} elseif ($code === 'PCHAT_DISABLED') {
    // This is what production returns today. Public Chat ships DISABLED (DEC-071);
    // an admin turns it on in the Filament admin Settings page.
    //
    // Getting a 503 here is GOOD NEWS for your integration: the feature gate runs
    // LAST, inside the controller, after the HMAC middleware has already verified
    // your key, your timestamp, your signature and your nonce. A 503 PCHAT_DISABLED
    // is positive proof that your signing is correct.
    echo "Signature VERIFIED. The feature is switched off by the workspace admin.\n";
    echo 'Retriable — Retry-After: '.($respHeaders['retry-after'] ?? '60')."s.\n";
    echo "Ask the admin to enable Public Chat in the admin Settings page.\n";
    echo "(Note: GET /rooms/{id} keeps answering while disabled — reads survive.)\n";
} elseif ($code === 'API_SIGNATURE_INVALID') {
    echo "The canonical string you built differs from ours. Run:\n";
    echo '  node ../node/verify-canonical.mjs POST '.$path.' '.$timestamp.' '.$nonce." <body-file>\n";
    echo "and diff it line by line. Line 6 (the body digest) is wrong most often —\n";
    echo "usually because the body was re-serialised after being hashed.\n";
} elseif ($code === 'API_TIMESTAMP_SKEW') {
    echo "Your clock is more than 300s from ours. Run NTP.\n";
} elseif ($code === 'API_KEY_INVALID') {
    echo "Bad/revoked key_id, or a malformed header. Check that:\n";
    echo "  - key_id matches pck_ + 28 lowercase hex\n";
    echo "  - the nonce matches [A-Za-z0-9_-]{16,64}  <- base64 nonces land here\n";
    echo "  - all four X-PChat-* headers are present\n";
} elseif ($code === 'API_NONCE_REPLAYED') {
    echo "That nonce was already used within the last 600s. Generate a fresh one per request.\n";
} elseif ($code === 'VALIDATION_FAILED') {
    echo 'Body rejected: '.json_encode($payload['error']['details'] ?? null, JSON_UNESCAPED_UNICODE)."\n";
} elseif ($status === 429) {
    echo "Rate limited. Create is 60/min per key.\n";
} elseif (! isset($payload['error'])) {
    // No {"error":{"code":...}} envelope means something in front of the API
    // answered — a CDN/WAF block, a proxy, or a captive network. Not a signing bug.
    echo 'HTTP '.$status." with no API error envelope — an intermediary answered, not the API.\n";
    echo 'Check your User-Agent and that you can reach '.$baseUrl." at all.\n";
} else {
    echo 'Unexpected. request_id for support: '.($payload['error']['request_id'] ?? 'n/a')."\n";
}

/**
 * @param  list<string>  $headers
 * @return array{0:int,1:array<string,string>,2:string}
 */
function pchat_post(string $url, array $headers, string $body): array
{
    if (function_exists('curl_init')) {
        $ch = curl_init($url);
        curl_setopt_array($ch, [
            CURLOPT_CUSTOMREQUEST => 'POST',
            CURLOPT_HTTPHEADER => $headers,
            // A STRING, never an array — an array makes curl send multipart
            // form data, and the body you signed is not the body you sent.
            CURLOPT_POSTFIELDS => $body,
            CURLOPT_RETURNTRANSFER => true,
            CURLOPT_HEADER => true,
            CURLOPT_TIMEOUT => 20,
        ]);
        $raw = (string) curl_exec($ch);
        if ($raw === '' && curl_errno($ch) !== 0) {
            fwrite(STDERR, 'curl error: '.curl_error($ch)."\n");
            exit(1);
        }
        $status = (int) curl_getinfo($ch, CURLINFO_RESPONSE_CODE);
        $headerSize = (int) curl_getinfo($ch, CURLINFO_HEADER_SIZE);
        curl_close($ch);

        return [$status, pchat_parse_headers(substr($raw, 0, $headerSize)), substr($raw, $headerSize)];
    }

    $ctx = stream_context_create(['http' => [
        'method' => 'POST',
        'header' => implode("\r\n", $headers),
        'content' => $body,
        'timeout' => 20,
        // Without this, a 4xx/5xx returns false and you never see the envelope.
        'ignore_errors' => true,
    ]]);
    $responseBody = (string) file_get_contents($url, false, $ctx);
    $raw = implode("\r\n", $http_response_header ?? []);
    $status = 0;
    if (preg_match('#\AHTTP/\S+\s+(\d{3})#', $raw, $m) === 1) {
        $status = (int) $m[1];
    }

    return [$status, pchat_parse_headers($raw), $responseBody];
}

/** @return array<string,string> */
function pchat_parse_headers(string $raw): array
{
    $out = [];
    foreach (preg_split('/\r?\n/', $raw) ?: [] as $line) {
        if (str_contains($line, ':')) {
            [$k, $v] = explode(':', $line, 2);
            $out[strtolower(trim($k))] = trim($v);
        }
    }

    return $out;
}
