# Public Chat — runnable signing examples

Four complete, self-contained programs that create a support room on the
**partner API (Tier 1)** and print the visitor link. Pick your language, set two
environment variables, run it. Each is one file with no dependencies.

| File | Needs | Notes |
|---|---|---|
| [`curl/sign.sh`](curl/sign.sh) | bash 3.2+, `openssl`, `curl` | Start here — paste it into a terminal |
| [`node/sign.mjs`](node/sign.mjs) | Node 18+ | `node:crypto` only, no npm install |
| [`php/sign.php`](php/sign.php) | PHP 8+ | ext-curl if present, `file_get_contents` otherwise |
| [`python/sign.py`](python/sign.py) | Python 3.7+ | stdlib only: `hmac`, `hashlib`, `urllib` |
| [`node/verify-canonical.mjs`](node/verify-canonical.mjs) | Node 18+ | Debugger for a 401 — see [Debugging a 401](#debugging-a-401) |

All four are **verified byte-for-byte against the server's own
`VerifyPublicChatSignature::canonical()`** — same inputs, same canonical string,
same signature, down to the hex. See [Proving it yourself](#proving-it-yourself).

---

## Run one

```bash
export PCHAT_KEY_ID='pck_xxxxxxxxxxxxxxxxxxxxxxxxxxxx'   # public, safe to log
export PCHAT_SECRET='pcs_xxxxxxxx…'                     # 68 chars — keep it server-side

./curl/sign.sh
# or: node node/sign.mjs
# or: php php/sign.php
# or: python3 python/sign.py
```

Every example understands the same environment:

| Variable | Default | Purpose |
|---|---|---|
| `PCHAT_KEY_ID` | — | **required.** `pck_` + 28 lowercase hex (32 chars) |
| `PCHAT_SECRET` | — | **required.** `pcs_` + 64 lowercase hex (68 chars) |
| `PCHAT_BASE_URL` | `https://chat.gamecoms.net` | point at a staging host |
| `PCHAT_TIMESTAMP` | now | pin the timestamp for a reproducible run |
| `PCHAT_NONCE` | random | pin the nonce for a reproducible run |
| `PCHAT_BODY_FILE` | built-in sample | send this file's bytes verbatim as the body |
| `PCHAT_DRY_RUN` | — | `1` prints the canonical string and signature, sends nothing |

`PCHAT_TIMESTAMP` / `PCHAT_NONCE` / `PCHAT_DRY_RUN` exist so you can reproduce a
failing request exactly. They are debugging aids — in production always let the
script generate a fresh timestamp and nonce.

---

## What you should see

**The feature ships disabled.** A create signed with an **issued** key against
production today returns:

```
status: 503
{"error":{"code":"PCHAT_DISABLED","message":"…","details":{"retry_after_seconds":60},…}}
Retry-After: 60
```

**That 503 is a pass, not a failure.** The feature gate runs *last*, inside the
controller, after the signing middleware has already checked your key, your
clock, your signature and your nonce. If your signing were wrong you would have
got a `401` and never reached the gate. A `503 PCHAT_DISABLED` is positive proof
that your HMAC is correct — the only thing left is for a workspace admin to
switch Public Chat on in the Filament admin Settings page.

**Before your key is issued you will get this instead, and it is not a signing
error:**

```
status: 401
{"error":{"code":"API_KEY_INVALID","message":"…","request_id":"…"}}
```

The key lookup is step 3 of verification and the signature check is step 4, so
an unknown, revoked or not-yet-issued `key_id` is rejected *before* the MAC is
computed. A perfectly correct signature and a deliberately corrupted one both
come back `API_KEY_INVALID`, and nothing in the response distinguishes them.
**`API_KEY_INVALID` tells you nothing about your canonical string.** To prove
your signer before you hold a key, use the offline vector in §"Proving it
yourself" below — that is what it is for.

Once it is on you get `201` and a link:

```json
{
  "room": { "id": "01JBX…", "code": "3f9a…", "status": "new", … },
  "url":  "https://chat.gamecoms.net/support/3f9a…"
}
```

Send `url` to your customer. Keep `room.id` — **every later partner call
addresses the room by its ULID, never by the code**, so the visitor's credential
never lands in your outbound HTTP logs.

Re-posting the same `external_ref` returns **`200` with the same room and the
same code**. That is idempotency, not an error — safe to retry.

---

## How the signature works

Four headers, exact spelling:

```
X-PChat-Key        your key_id
X-PChat-Timestamp  unix seconds, integer
X-PChat-Nonce      unique per request, [A-Za-z0-9_-]{16,64}
X-PChat-Signature  v1=<lowercase hex HMAC-SHA256>
```

The signed string is exactly **six lines joined with `\n`, with no trailing
newline**:

```
v1
POST
/api/v1/partner/public-chat/rooms
1789000000
abcdefghijklmnop
5c640040e6524ac4ecbabdc3fe2c7370b09af7f8c0ff1b09d326edbcb58094af
```

1. the literal `v1`
2. the HTTP method, **uppercase**
3. the request path — leading slash, **includes `/api/v1`**, **excludes** the
   query string, **no trailing slash**
4. the `X-PChat-Timestamp` value, verbatim
5. the `X-PChat-Nonce` value, verbatim
6. lowercase hex `sha256` of the **raw request body bytes**
   (`e3b0c442…b855`, the sha256 of the empty string, when there is no body)

Then `X-PChat-Signature: "v1=" + hmac_sha256(canonical, secret)`.

The HMAC key is the **whole secret string including the `pcs_` prefix**. Do not
strip it and do not hex-decode it — it is used as opaque text.

### The one bug everybody hits

> **Sign the exact bytes you put on the wire.**

Serialise your JSON **once**, into a string or a byte array. Hash *that*. Send
*that*. Never let your HTTP client re-serialise an object for you after you have
computed the digest — key order, whitespace and `\uXXXX` escaping all differ
between serialisers, the body hash on line 6 changes, and you get **intermittent
401s that you cannot reproduce**. Every example here marks that line with a
`>>> THE BUG EVERYONE HITS <<<` comment.

The same rule catches the smaller traps:

- Hash with `printf '%s'`, never `echo` — `echo` appends a newline you do not send.
- In PHP, `CURLOPT_POSTFIELDS` must be a **string**; an array silently turns the
  request into multipart form data.
- In Python, hash and send the **same `bytes`**, not a `str` you re-encode later.
- Send `Content-Type: application/json`, or Laravel will not parse the body and
  you get a confusing `422` instead of a clear error.
- Send a real `User-Agent`. The CDN in front of the API blocks default library
  agents such as `Python-urllib/3.x` outright — the giveaway is a `403` whose
  body has **no** `{"error":{"code":…}}` envelope, so it is not a signing problem
  at all.

### Nonce and clock

- The nonce must match `[A-Za-z0-9_-]{16,64}`. Hex from a CSPRNG is always safe.
  **Do not use base64** — `+`, `/` and `=` fail the header check and you get a
  `401 API_KEY_INVALID` that looks like a bad key.
- A nonce is remembered for **600 seconds** per key. Reuse inside that window is
  `409 API_NONCE_REPLAYED`.
- Your clock must be within **±300 seconds** of the server's, or
  `401 API_TIMESTAMP_SKEW`. Run NTP.
- Checks run cheapest-first and the nonce check runs **after** the signature
  check, so a request rejected for a bad signature does **not** burn its nonce —
  you may retry with the same one.

---

## Debugging a 401

If you get `401 API_SIGNATURE_INVALID`, do not guess. Dump our canonical string
and diff it against yours:

```bash
printf '%s' '{"customer_name":"x"}' > /tmp/body.json   # printf, not echo

node node/verify-canonical.mjs POST /api/v1/partner/public-chat/rooms \
     1789000000 abcdefghijklmnop /tmp/body.json
```

It prints the body byte count, the body digest, the canonical string numbered
line by line, the same string with `\n` shown literally, and the full hex. Set
`PCHAT_SECRET` and it prints the signature too (the secret itself is never
printed).

Check in this order:

1. **Line 6, the body digest.** Wrong far more often than anything else. If your
   byte count differs from ours by one, you have a trailing newline from `echo`
   or from your editor.
2. **Line 3, the path.** It must start with `/api/v1`, must have no query
   string, and must have no trailing slash.
3. **Lines 4 and 5.** The header values must be byte-identical to what you
   signed — no reformatting, no re-padding the timestamp.
4. **The secret.** Include the `pcs_` prefix.

The other codes point somewhere specific:

| Code | HTTP | What it means |
|---|---|---|
| `API_KEY_INVALID` | 401 | Missing/malformed header, bad key_id shape, revoked key, or inactive workspace. A base64 nonce lands here. |
| `API_TIMESTAMP_SKEW` | 401 | Clock more than 300s out |
| `API_SIGNATURE_INVALID` | 401 | The canonical string differs — use the debugger above |
| `API_NONCE_REPLAYED` | 409 | Nonce reused within 600s |
| `PCHAT_DISABLED` | 503 | Signing was fine; the feature is switched off. `Retry-After: 60` |
| `PCHAT_ROOM_NOT_FOUND` | 404 | Unknown ULID, or a room belonging to another workspace |
| `PCHAT_ROOM_CLOSED` | 409 | Already closed — e.g. a double close, or rotating a closed room's link |
| `PCHAT_LINK_EXPIRED` | 410 | The conversation has ended |
| `VALIDATION_FAILED` | 422 | See `error.details.fields` |

**Branch on `error.code`, never on `error.message`** — messages are localised and
may be in Thai.

---

## Proving it yourself

Every example agrees with the server's own implementation on the byte level.
Pin the timestamp, the nonce and the body, run all four in dry-run mode, and
compare the hex:

```bash
printf '%s' '{"customer_name":"ok"}' > /tmp/body.json   # no trailing newline

export PCHAT_DRY_RUN=1 \
       PCHAT_TIMESTAMP=1789000000 \
       PCHAT_NONCE=abcdefghijklmnop \
       PCHAT_BODY_FILE=/tmp/body.json \
       PCHAT_KEY_ID=pck_00000000000000000000000000ff \
       PCHAT_SECRET="pcs_$(printf 'a%.0s' $(seq 1 64))"

filter() { awk '/^canonical hex:|^X-PChat-Signature:/'; }
node    node/sign.mjs   | filter
php     php/sign.php    | filter
python3 python/sign.py  | filter
bash    curl/sign.sh    | filter
```

All four print the same two lines. Against that fixture they are, exactly:

```
X-PChat-Signature: v1=2f1399c76bbd4b7e1fa5611fc2bc4af01135e419981751877c2c4c01860d15c5
canonical hex:     76310a504f53540a2f6170692f76312f706172746e65722f7075626c69632d636861742f726f6f6d730a313738393030303030300a6162636465666768696a6b6c6d6e6f700a63663261656534323961303433376230643738613463653465326234313032333538663030363965363063663566633166366336623661386530336530626339
```

That signature is also what `VerifyPublicChatSignature::canonical()` produces for
the same inputs — the examples are checked against the server's own static, not
against each other.

**Use `printf '%s'`, not `echo`, to write the fixture.** `echo` appends a
newline, and a body file's trailing newline is part of the bytes: it changes
line 6 and therefore the signature. That is not a bug in the examples — all four
read the file verbatim and sign exactly what they send — but your run will not
match the values above.

If you fork one of these into your own codebase, keep this check in your test
suite — it is the cheapest possible guard against a signing regression.

---

## The rest of the surface, briefly

**Tier 1 — partner (what these examples use).** HMAC-signed, server-to-server.
Rooms are addressed by ULID.

| | Endpoint | Throttle |
|---|---|---|
| API-200 | `POST /api/v1/partner/public-chat/rooms` | 60/min per key |
| API-201 | `GET /api/v1/partner/public-chat/rooms/{id}` | 120/min per key |
| API-202 | `POST /api/v1/partner/public-chat/rooms/{id}/close` | 120/min per key |
| API-203 | `POST /api/v1/partner/public-chat/rooms/{id}/rotate-link` | 120/min per key |

`GET rooms/{id}` returns status and a message count — **never the transcript**.
The partner surface deliberately cannot read messages, send messages, or act as
a user. It also keeps answering while the feature is disabled, so your status
polling does not break when an admin pauses new conversations; the three write
calls are the ones that return `503`.

`rotate-link` invalidates the old code immediately and returns a new `url`. You
must re-deliver it — a rotation your customer never receives is just a broken
link. An already-connected browser session is not evicted.

**Tier 2 — visitor.** Unauthenticated; the 64-hex code in the link *is* the
credential. Normally you do nothing here: send the customer to
`https://chat.gamecoms.net/support/<code>` and the hosted page — the supported
path — calls these for them. They exist (`GET /api/v1/public-chat/{code}`,
`.../messages`, `POST .../messages`, `.../uploads`,
`.../uploads/{attachment}/complete`, `.../broadcasting/auth`, `.../typing`) if
you must build your own widget. Rates are per code: 120/min reads, 20/min
writes, 10/min uploads.

**Tier 3 — agent.** Your support staff, in the Banana Chat app, on normal bearer
auth plus `X-Workspace-Id`. A partner never calls this tier.

## Things to know before you ship

- **The link is a bearer capability.** Anyone holding it can read and write that
  one conversation. Treat it like a password: deliver over TLS, never in an email
  subject, a `Referer`, or an analytics URL. Our edge does not log it — do not
  make yours log it either. Use `rotate-link` if one leaks.
- **Chat, files and video only.** Never a call, never a meeting. Strictly one
  visitor per room.
- **The first agent reply auto-claims the room**: the assignee is set and status
  moves `new` → `in_progress`.
- **Statuses are `new` / `in_progress` / `done` / `problem`.** You see the real
  one; the visitor sees a projected `status_public`, and `problem` is never
  disclosed to them.
- **An agent appears to the visitor as `provider name (admin username)`** —
  which is why `provider_name` is required at create time.
- **`meta` is partner-private.** Stored, shown to your support staff and to
  admins, never served to the visitor. Capped at 8192 bytes — measured on the
  server's own re-encoding of the decoded object, which escapes non-ASCII as
  `\uXXXX`, so Thai text in `meta` costs about 6 bytes per character rather than
  the 3 it occupies in your request body.
- **Never sign in the browser.** The secret is a server-side credential. It is
  shown exactly once at issuance and cannot be retrieved again — if you lose it,
  an admin issues a new key.
