#!/usr/bin/env node
/**
 * Banana Chat — Public Chat partner API (Tier 1, HMAC).
 * Creates a support room and prints the visitor link.
 *
 * Node 18+. No dependencies beyond node: builtins.
 *
 *   PCHAT_KEY_ID=pck_... PCHAT_SECRET=pcs_... node sign.mjs
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

import { createHash, createHmac, randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';

// ---------------------------------------------------------------------------
// The canonical string. Mirrors VerifyPublicChatSignature::canonical() exactly:
// six lines joined with "\n", NO trailing newline.
//
//   1  v1                    the literal version tag
//   2  HTTP METHOD, uppercase
//   3  request path — leading slash, INCLUDES /api/v1, EXCLUDES the query string
//   4  the X-PChat-Timestamp value, verbatim
//   5  the X-PChat-Nonce value, verbatim
//   6  lowercase hex sha256 of the RAW request body bytes (sha256("") if no body)
// ---------------------------------------------------------------------------
const VERSION = 'v1';

export function canonical(method, path, timestamp, nonce, rawBody) {
  return [
    VERSION,
    method.toUpperCase(),
    path,
    String(timestamp),
    nonce,
    // >>> THE BUG EVERYONE HITS <<<
    // Hash the EXACT bytes that go on the wire. `rawBody` is already a string
    // here and that same string is handed to fetch() below — it is never
    // re-serialised. Calling JSON.stringify() again (or letting a HTTP client
    // serialise an object for you) can change key order, whitespace or unicode
    // escaping, which changes this digest and produces intermittent 401s.
    createHash('sha256').update(rawBody, 'utf8').digest('hex'),
  ].join('\n');
}

export function sign(secret, canonicalString) {
  return VERSION + '=' + createHmac('sha256', secret).update(canonicalString, 'utf8').digest('hex');
}

// Nonce must match [A-Za-z0-9_-]{16,64}. Hex is always safe.
// Do NOT use base64: '+' '/' '=' fail the header check and you get a
// 401 API_KEY_INVALID that looks like a bad key.
const freshNonce = () => randomBytes(16).toString('hex');

// ---------------------------------------------------------------------------

const baseUrl = (process.env.PCHAT_BASE_URL || 'https://chat.gamecoms.net').replace(/\/+$/, '');
const keyId = process.env.PCHAT_KEY_ID || '';
const secret = process.env.PCHAT_SECRET || '';
const dryRun = process.env.PCHAT_DRY_RUN === '1';

if (!dryRun && (!keyId || !secret)) {
  console.error('Set PCHAT_KEY_ID and PCHAT_SECRET (or PCHAT_DRY_RUN=1).');
  process.exit(2);
}

const method = 'POST';
// No trailing slash. getPathInfo() keeps one if you send it, and your
// signature will not have it.
const path = '/api/v1/partner/public-chat/rooms';

// Serialise the body ONCE, into a string. Everything downstream — the digest
// and the wire — uses this exact string.
const body = process.env.PCHAT_BODY_FILE
  ? readFileSync(process.env.PCHAT_BODY_FILE, 'utf8')
  : JSON.stringify({
      customer_name: 'สมชาย ใจดี',   // required, 1..120
      provider_name: 'ACME Support', // required, 1..120 — shown to the visitor
      external_ref: 'ticket-' + Date.now(), // optional, <=120. Reuse it and the
                                            // create is idempotent: 200 + the
                                            // same room instead of 201.
      locale: 'th',                  // optional, 'th' or 'en'
      meta: { plan: 'gold' },        // optional. Partner-private: stored, shown to
                                     // staff, NEVER served to the visitor.
                                     // <=8192 bytes JSON-encoded.
    });

const timestamp = process.env.PCHAT_TIMESTAMP || String(Math.floor(Date.now() / 1000));
const nonce = process.env.PCHAT_NONCE || freshNonce();

const canonicalString = canonical(method, path, timestamp, nonce, body);
const signature = sign(secret, canonicalString);

console.log('--- request ------------------------------------------------');
console.log(method + ' ' + baseUrl + path);
console.log('X-PChat-Key:       ' + (keyId || '(unset)'));
console.log('X-PChat-Timestamp: ' + timestamp);
console.log('X-PChat-Nonce:     ' + nonce);
console.log('X-PChat-Signature: ' + signature);
console.log('body:              ' + body);
console.log('body sha256:       ' + createHash('sha256').update(body, 'utf8').digest('hex'));
console.log('canonical (\\n shown literally):');
console.log('  ' + canonicalString.replace(/\n/g, '\\n'));
console.log('canonical hex:     ' + Buffer.from(canonicalString, 'utf8').toString('hex'));

if (dryRun) {
  console.log('\n(PCHAT_DRY_RUN=1 — nothing sent)');
  process.exit(0);
}

const res = await fetch(baseUrl + path, {
  method,
  headers: {
    'Content-Type': 'application/json', // without this Laravel does not parse the
                                        // JSON and you get a confusing 422
    Accept: 'application/json',
    // Always identify your integration. A default or missing User-Agent can be
    // blocked by the CDN in front of the API before the request ever reaches it
    // — a 403 with no {"error":{"code":...}} envelope is that, not a signing bug.
    'User-Agent': 'banana-chat-partner-example/1.0 (+node)',
    'X-PChat-Key': keyId,
    'X-PChat-Timestamp': timestamp,
    'X-PChat-Nonce': nonce,
    'X-PChat-Signature': signature,
  },
  body, // the SAME string that was hashed above
});

const text = await res.text();
console.log('\n--- response -----------------------------------------------');
console.log('status: ' + res.status);
if (res.headers.get('retry-after')) console.log('Retry-After: ' + res.headers.get('retry-after'));
console.log(text);

let payload = null;
try {
  payload = JSON.parse(text);
} catch {
  /* not JSON — print raw above and fall through */
}

// Branch on error.code, NEVER on error.message: messages may be in Thai.
const code = payload?.error?.code;

console.log('\n--- what that means ----------------------------------------');
if (res.status === 201) {
  console.log('Room created. Give this link to the customer over TLS:');
  console.log('  ' + payload.url);
  console.log('Keep room.id (' + payload.room.id + ') — every later partner call uses the ULID,');
  console.log('never the code. The code is the visitor credential; do not put it in logs.');
} else if (res.status === 200) {
  console.log('Idempotent replay: this external_ref already had a room. Not an error.');
  console.log('  ' + payload.url);
} else if (code === 'PCHAT_DISABLED') {
  // This is what production returns today. Public Chat ships DISABLED (DEC-071);
  // an admin turns it on in the Filament admin Settings page.
  //
  // Getting a 503 here is GOOD NEWS for your integration: the feature gate runs
  // LAST, inside the controller, after the HMAC middleware has already verified
  // your key, your timestamp, your signature and your nonce. A 503 PCHAT_DISABLED
  // is positive proof that your signing is correct.
  console.log('Signature VERIFIED. The feature is switched off by the workspace admin.');
  console.log('Retriable — Retry-After: ' + (res.headers.get('retry-after') || '60') + 's.');
  console.log('Ask the admin to enable Public Chat in the admin Settings page.');
  console.log('(Note: GET /rooms/{id} keeps answering while disabled — reads survive.)');
} else if (code === 'API_SIGNATURE_INVALID') {
  console.log('The canonical string you built differs from ours. Run:');
  console.log('  node verify-canonical.mjs POST ' + path + ' ' + timestamp + ' ' + nonce + ' <body-file>');
  console.log('and diff it line by line. Line 6 (the body digest) is wrong most often —');
  console.log('usually because the body was re-serialised after being hashed.');
} else if (code === 'API_TIMESTAMP_SKEW') {
  console.log('Your clock is more than 300s from ours. Run NTP.');
} else if (code === 'API_KEY_INVALID') {
  console.log('Bad/revoked key_id, or a malformed header. Check that:');
  console.log('  - key_id matches pck_ + 28 lowercase hex');
  console.log('  - the nonce matches [A-Za-z0-9_-]{16,64}  <- base64 nonces land here');
  console.log('  - all four X-PChat-* headers are present');
} else if (code === 'API_NONCE_REPLAYED') {
  console.log('That nonce was already used within the last 600s. Generate a fresh one per request.');
} else if (code === 'VALIDATION_FAILED') {
  console.log('Body rejected: ' + JSON.stringify(payload.error.details));
} else if (res.status === 429) {
  console.log('Rate limited. Create is 60/min per key.');
} else if (!payload?.error) {
  // No {"error":{"code":...}} envelope means something in front of the API
  // answered — a CDN/WAF block, a proxy, or a captive network. Not a signing bug.
  console.log('HTTP ' + res.status + ' with no API error envelope — an intermediary answered,');
  console.log('not the API. Check your User-Agent and that you can reach ' + baseUrl + ' at all.');
} else {
  console.log('Unexpected. request_id for support: ' + (payload?.error?.request_id ?? 'n/a'));
}
