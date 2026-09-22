#!/usr/bin/env node
/**
 * Canonical-string debugger for a 401 API_SIGNATURE_INVALID.
 *
 * Prints the canonical string exactly as VerifyPublicChatSignature::canonical()
 * builds it, with "\n" shown literally, plus the byte length, the body digest
 * and the full hex — so you can diff ours against yours character by character.
 *
 *   node verify-canonical.mjs <METHOD> <PATH> <TIMESTAMP> <NONCE> [BODY_FILE]
 *
 * Example (the fixture used to prove all four examples agree):
 *   printf '%s' '{"customer_name":"x"}' > /tmp/body.json
 *   node verify-canonical.mjs POST /api/v1/partner/public-chat/rooms \
 *        1789000000 abcdefghijklmnop /tmp/body.json
 *
 * Set PCHAT_SECRET to also print the signature. The secret itself is never printed.
 */

import { createHash, createHmac } from 'node:crypto';
import { readFileSync } from 'node:fs';

const [method, path, timestamp, nonce, bodyFile] = process.argv.slice(2);

if (!method || !path || !timestamp || !nonce) {
  console.error('usage: node verify-canonical.mjs <METHOD> <PATH> <TIMESTAMP> <NONCE> [BODY_FILE]');
  console.error('  PATH must include /api/v1 and exclude the query string.');
  process.exit(2);
}

// Read as bytes, not as a decoded+re-encoded string: what is hashed must be
// what is on the wire. (utf8 round-trips fine, but bytes remove the question.)
const body = bodyFile ? readFileSync(bodyFile) : Buffer.alloc(0);
const bodyHash = createHash('sha256').update(body).digest('hex');

const canonical = ['v1', method.toUpperCase(), path, String(timestamp), nonce, bodyHash].join('\n');

console.log('body bytes:    ' + body.length + (bodyFile ? '  (from ' + bodyFile + ')' : '  (no body)'));
console.log('body sha256:   ' + bodyHash);
console.log('               ^ line 6. If yours differs, you are hashing different bytes than you send.');
console.log('                 A trailing newline from `echo` or a text editor counts.');
console.log('');
console.log('canonical string, one line, "\\n" shown literally:');
console.log('  ' + canonical.replace(/\n/g, '\\n'));
console.log('');
console.log('canonical string, as sent to HMAC:');
console.log(canonical.split('\n').map((l, i) => '  ' + (i + 1) + ' | ' + l).join('\n'));
console.log('');
console.log('canonical bytes: ' + Buffer.byteLength(canonical, 'utf8'));
console.log('canonical hex: ' + Buffer.from(canonical, 'utf8').toString('hex'));
console.log('canonical sha256: ' + createHash('sha256').update(canonical, 'utf8').digest('hex'));

if (process.env.PCHAT_SECRET) {
  const sig = 'v1=' + createHmac('sha256', process.env.PCHAT_SECRET).update(canonical, 'utf8').digest('hex');
  console.log('X-PChat-Signature: ' + sig);
} else {
  console.log('(set PCHAT_SECRET to also print X-PChat-Signature)');
}
