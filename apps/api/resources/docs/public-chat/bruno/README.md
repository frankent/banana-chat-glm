# Public Chat — Bruno collection

A runnable client for the Banana Chat **Public Chat** API, covering all three
tiers. Everything here talks to `https://chat.gamecoms.net` (or your local API)
over `/api/v1`.

The point of this collection is the **collection-level HMAC signer** in
`collection.bru`. It signs every Tier-1 partner request for you, so the request
files stay plain JSON and you can see the actual contract instead of signing
boilerplate.

---

## 1. Open it

1. Install [Bruno](https://www.usebruno.com/) (desktop app, free).
2. **Open Collection** → point it at this folder (the one containing
   `bruno.json`).
3. You should see three folders: `01 Partner`, `02 Visitor`, `03 Agent`.

### If you get a crypto / module error

The signer needs a hashing library. Bruno's default **Safe Mode** sandbox does
not expose Node's `crypto`. The script falls back to `crypto-js`, but if your
build bundles neither you will see:

> Public Chat signer: no crypto module available.

Fix: **Collection settings → Script → Developer Mode**. Then re-run.

---

## 2. Select an environment and paste your credentials

Top-right environment selector:

| Environment  | `baseUrl`                    |
| ------------ | ---------------------------- |
| `production` | `https://chat.gamecoms.net`  |
| `local`      | `http://localhost:8000`      |

Both ship with **empty credentials**. Nothing real is committed to this repo,
and nothing real should ever be.

Open the environment editor and fill in:

| Variable       | Tier | Where it comes from |
| -------------- | ---- | ------------------- |
| `key_id`       | 1    | Filament admin → **Settings → Public Chat**. Format `pck_` + 28 lowercase hex (32 chars). Public — safe to log. |
| `secret`       | 1    | Shown **exactly once**, at issuance, on the same screen. Format `pcs_` + 64 lowercase hex (68 chars). |
| `agent_token`  | 3    | `POST /api/v1/auth/login {"username","password"}` → `access_token`. |
| `workspace_id` | 3    | The workspace ULID from that same login response (`workspaces[]`). |

`secret` and `agent_token` are declared as **secret vars**, so Bruno keeps them
in its local store and never writes them into these files.

> **The secret is unrecoverable.** It is stored encrypted under the server's
> `APP_KEY`; the admin screen only ever shows `****last4` afterwards. Lost it?
> Issue a new key and revoke the old one.

Tier 2 needs **no credentials at all** — see §4.

---

## 3. Run it, in this order

Bruno's folder runner executes files in `seq` order within a folder, and folders
in `seq` order. **Do not run the whole collection blind on the first pass** —
`01 Partner` ends with *close room*, and everything after a close is legitimately
`409 PCHAT_ROOM_CLOSED`.

Recommended first pass:

1. **`01 Partner / API-200 Create room`** — run it alone. It stores `room_id`,
   `code` and `support_url` as runtime vars, which every later request uses.
2. **`01 Partner / API-201 Get room status`**.
3. **`02 Visitor`** — run the folder. Uses the `code` from step 1.
4. **`03 Agent`** — run the folder. Needs `agent_token` + `workspace_id`.
5. **`01 Partner / API-203 Rotate link`**, then **`API-202 Close room`** — last,
   and in that order (rotating a closed room is a 409).

Re-running **API-200** is safe and instructive: `external_ref` is a fixed string
(`bruno-demo-0001`), so the second run returns **200 with the same room and the
same code** instead of 201. That is the idempotency contract, not an error.

A full top-to-bottom run afterwards will show 409s in `02`/`03` because the room
is closed. That is correct behaviour.

---

## 4. The three tiers, and what authenticates each

| Tier | Prefix | Credential | Who |
| ---- | ------ | ---------- | --- |
| 1 | `/api/v1/partner/public-chat/…` | HMAC-SHA256 over the request (`X-PChat-*`) | **you**, server-to-server |
| 2 | `/api/v1/public-chat/{code}/…` | the 64-hex `code` in the URL — nothing else | the customer's browser |
| 3 | `/api/v1/public-chat/rooms/…` | `Authorization: Bearer` + `X-Workspace-Id` | your support staff |

**Tier 2 is unauthenticated on purpose.** Do not attach an API key or a bearer
token to it. A valid bearer makes reads work but turns every write into
`403 PCHAT_SIGNED_IN`; an expired one is a flat `401`. In production your visitor
just opens `https://chat.gamecoms.net/support/<code>` — **the hosted page is the
supported path.** Tier 2 is documented here so you *can* build your own widget,
not because you should.

**Tier 3 is listed for completeness. A partner never calls it.**

---

## 5. Feature disabled? A `503` is the good outcome

Public Chat **ships disabled** (`publicchat.enabled=false`, DEC-071). An admin
turns it on in **Settings → Public Chat** and issues the API key there.

While it is off, a **correctly signed** create returns:

```
HTTP/1.1 503 Service Unavailable
Retry-After: 60

{"error":{"code":"PCHAT_DISABLED","message":"...","details":{"retry_after_seconds":60},"request_id":"..."}}
```

**That 503 is proof your signature verified.** The feature gate runs *inside the
controller*, after the HMAC middleware has already checked headers, clock skew,
key validity, signature and nonce. An unsigned or badly signed request never
reaches it — it dies at `401` or `409` first.

So on a fresh integration, `503 PCHAT_DISABLED` means **"your signing is
correct; ask the admin to flip the switch."** The `create-room` request has a
named test asserting exactly this.

**If you have not been issued a key yet you will see `401 API_KEY_INVALID`
instead — that is not a signing failure.** Key lookup is step 3 and the
signature check is step 4, so an unknown or revoked `key_id` is rejected before
the MAC is ever computed; a correct and an incorrect canonical string are
indistinguishable from the outside until you hold a real key. Get the key from
**Settings → Public Chat** first, then re-run.

Reads keep working while the feature is off (API-201, API-210, API-211,
API-220/221/222/227). Only writes stop.

---

## 6. Signing, and the one bug everyone hits

`collection.bru` builds the canonical string the server expects — **exactly six
lines, joined with `\n`**:

```
v1
POST
/api/v1/partner/public-chat/rooms
1789567750
91dd96f9aca85c9ba9708492b6bfaa05
74d98b3a955e00c2cfbd9d981581a2c303c5e1ba5129359e655286d926d7d762
```

| # | Line | Notes |
| - | ---- | ----- |
| 1 | `v1` | literal version tag |
| 2 | HTTP method | **uppercase** |
| 3 | request path | leading slash, **includes `/api/v1`**, **excludes the query string** |
| 4 | timestamp | unix **seconds**, integer |
| 5 | nonce | unique per request |
| 6 | `sha256(raw body)` | lowercase hex; `sha256("")` when there is no body |

```
signature = "v1=" + hex(hmac_sha256(canonical_string, secret))
```

Four headers go on the request:

```
X-PChat-Key:        pck_…
X-PChat-Timestamp:  1789567750
X-PChat-Nonce:      91dd96f9aca85c9ba9708492b6bfaa05
X-PChat-Signature:  v1=<64 lowercase hex>
```

### ⚠ Sign the exact bytes you put on the wire

**Never re-serialise your JSON between hashing it and sending it.** Key order,
whitespace and unicode escaping all change the body hash, and you get
`401 API_SIGNATURE_INVALID` — *intermittently*, on only the requests whose
payload happens to reorder. This is the single most common integration bug in
this class of API.

Concretely, in your own client: serialise the body **once**, hash **that
string**, and send **that same string**. Do not hand a language object to both
your hasher and your HTTP library and assume they agree.

The two traps this collection had to solve, which yours will hit too:

- **Bruno substitutes `{{vars}}` _after_ pre-request scripts run.** So
  `req.getUrl()` hands the script the literal `.../rooms/{{room_id}}`. The signer
  interpolates the URL and the body **itself** before hashing, then pushes the
  interpolated body back with `req.setBody()`. Hash a template, sign a path that
  never gets requested.
- **Empty body ≠ no line 6.** A body-less `POST` (close, rotate-link) still hashes
  the empty string:
  `e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855`.

If a request comes back `401 API_SIGNATURE_INVALID`, the signer stashes the
canonical string it built in the runtime var **`last_canonical_string`**. Open
the Vars panel and compare it line by line with what you expect.

### Nonce format

Must match `[A-Za-z0-9_-]{16,64}` and be unique for 600 seconds. The signer uses
16 random bytes as hex (32 chars). **Do not use base64** — `+`, `/` and `=` fail
the header shape check and come back as `401 API_KEY_INVALID`, which reads
misleadingly like a bad key.

A nonce burned by a *failed-signature* attempt is still usable: the replay check
runs **after** signature verification, deliberately, so an observer cannot
pre-consume your nonces with unsigned garbage.

---

## 7. Errors

Every error uses the same envelope:

```json
{"error":{"code":"…","message":"…","details":{…},"request_id":"…"}}
```

**Branch on `code`. Never on `message` — messages may be in Thai.**

| Code | HTTP | Meaning |
| ---- | ---- | ------- |
| `API_KEY_INVALID` | 401 | header missing/malformed, or key unknown or revoked |
| `API_TIMESTAMP_SKEW` | 401 | your clock is more than **300 s** off ours |
| `API_SIGNATURE_INVALID` | 401 | the canonical string or the secret is wrong |
| `API_NONCE_REPLAYED` | 409 | that nonce was already used within **600 s** |
| `PCHAT_DISABLED` | 503 | feature switched off — **signature was fine** (§5) |
| `PCHAT_ROOM_NOT_FOUND` | 404 | unknown room, rotated code, or another workspace's room |
| `PCHAT_ROOM_CLOSED` | 409 | the conversation is `done` |
| `PCHAT_LINK_EXPIRED` | 410 | link expired or the conversation was deleted |
| `PCHAT_INVALID_TRANSITION` | 422 | illegal status change (see API-224's notes) |
| `PCHAT_SIGNED_IN` | 403 | a bearer token was sent on Tier 2 |
| `VALIDATION_FAILED` | 422 | bad payload; `details.fields` says which |

Rate limits (`429`) are per-key on Tier 1 and per-code on Tier 2:

| Limiter | Limit | Applies to |
| ------- | ----- | ---------- |
| `pchat-create` | 60/min per key | API-200 |
| `pchat-partner` | 120/min per key | API-201/202/203 |
| visitor read | 120/min per code | API-210/211/215 |
| visitor write | 20/min per code | API-212/216 |
| visitor upload | 10/min per code | API-213/214 |

---

## 8. Behaviour worth knowing before you ship

- **Rooms are addressed by ULID on Tier 1, never by the code.** A code in a
  partner URL would put the *visitor's* credential into your outbound HTTP logs,
  every proxy in between, and our access logs on every status poll. A 64-hex
  value in `{id}` is a plain `404`.
- **The link is a bearer capability.** Anyone holding
  `/support/<code>` can read and write that one conversation. Our edge never logs
  it. Treat it like a password: deliver over TLS, and keep it out of email
  subjects, `Referer` headers and analytics URLs. `rotate-link` (API-203)
  invalidates the old one immediately — but **you must re-deliver the new URL**,
  and an already-connected socket is not evicted.
- **The transcript is never returned to a partner.** API-201 gives you status and
  counts. That bound is deliberate.
- **`meta` is partner-private.** Stored, visible to staff and admin, **never**
  served to the visitor.
- **The visitor never sees the real status.** They see `status_public`
  (`open`/`closed`); `new`, `in_progress` and `problem` all project to `open`.
  `problem` is internal triage and is never disclosed.
- **The first agent reply auto-claims the room** — assignee set, status →
  `in_progress`.
- **An agent's message shows to the visitor as `provider name (admin username)`.**
- **Chat + file + video only.** Never a call, never a meeting. **Strictly one
  visitor per room.**

---

## 9. What's in here

```
bruno.json                     collection manifest
collection.bru                 the HMAC signer (collection-level pre-request script)
environments/production.bru    https://chat.gamecoms.net
environments/local.bru         http://localhost:8000

01-partner/   API-200 create-room · API-201 get-room · API-203 rotate-link · API-202 close-room
02-visitor/   API-210 show · API-211 list-messages · API-212 send-message
              API-213 create-upload · API-214 complete-upload · API-216 typing
03-agent/     API-220 list-rooms · API-227 summary · API-221 show-room
              API-222 list-messages · API-223 send-message · API-224 patch-room
              API-228 mark-read
```

Every request has a `docs` block explaining its contract and a `tests` block
asserting the status code and response shape. Open any request's **Docs** tab.

Two notes on the tests:

- **`02-visitor / API-214 Complete upload` is expected to fail on a plain run.**
  Completing an upload requires you to `PUT` the actual bytes to the presigned
  `upload_url` from API-213 first, which happens outside Bruno. Its test only
  asserts the error envelope is well-formed.
- **`03-agent / API-224 Patch room` requires an assignee.** Any status other than
  `new` needs a non-null assignee, enforced against the locked row. That is why
  API-223 (which auto-claims) runs before it. Run it standalone against an
  unclaimed room and `422 PCHAT_INVALID_TRANSITION` is the correct answer — send
  `{"status": …, "assigned_to": "<member ULID>"}` together instead.

Not included: **API-215** `POST /api/v1/public-chat/{code}/broadcasting/auth`
(120/min per code). It is the websocket channel-auth endpoint and needs a live
`socket_id` from an open Reverb connection, so it cannot be exercised
meaningfully from an HTTP client. `channel_name` must equal
`private-public-chat.<room ULID>` — the room id, never the code — and anything
else is rejected.
