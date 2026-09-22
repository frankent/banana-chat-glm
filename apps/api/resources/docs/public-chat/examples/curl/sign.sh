#!/usr/bin/env bash
# Banana Chat — Public Chat partner API (Tier 1, HMAC).
# Creates a support room and prints the visitor link.
#
# bash 3.2+ (stock macOS), openssl, curl. Nothing else.
#
#   PCHAT_KEY_ID=pck_... PCHAT_SECRET=pcs_... ./sign.sh
#
# Environment:
#   PCHAT_KEY_ID     required. 'pck_' + 28 lowercase hex (32 chars). Public, safe to log.
#   PCHAT_SECRET     required. 'pcs_' + 64 lowercase hex (68 chars). The HMAC key is the
#                    WHOLE string, prefix included. Shown once at issuance; never printed here.
#   PCHAT_BASE_URL   default https://chat.gamecoms.net
#   PCHAT_TIMESTAMP  override the unix-seconds timestamp (debugging / reproducible runs)
#   PCHAT_NONCE      override the nonce (debugging / reproducible runs)
#   PCHAT_BODY_FILE  read the request body verbatim from this file instead of building one
#   PCHAT_DRY_RUN=1  print the canonical string and signature, send nothing

set -eu

BASE_URL="${PCHAT_BASE_URL:-https://chat.gamecoms.net}"
BASE_URL="${BASE_URL%/}"
KEY_ID="${PCHAT_KEY_ID:-}"
SECRET="${PCHAT_SECRET:-}"
DRY_RUN="${PCHAT_DRY_RUN:-}"

if [ "$DRY_RUN" != "1" ] && { [ -z "$KEY_ID" ] || [ -z "$SECRET" ]; }; then
  echo "Set PCHAT_KEY_ID and PCHAT_SECRET (or PCHAT_DRY_RUN=1)." >&2
  exit 2
fi

METHOD="POST"
# NOT named $PATH — that is the shell's executable search path and clobbering it
# breaks every command after this line.
# No trailing slash: getPathInfo() keeps one if you send it, and your signature
# will not have it.
REQ_PATH="/api/v1/partner/public-chat/rooms"

# Build the body ONCE, into a variable. Everything downstream — the digest and
# the wire — uses this exact string.
#   customer_name  required, 1..120
#   provider_name  required, 1..120 — shown to the visitor
#   external_ref   optional, <=120. Reuse it and the create is idempotent:
#                  200 + the same room instead of 201.
#   locale         optional, 'th' or 'en'
#   meta           optional. Partner-private: stored, shown to staff, NEVER
#                  served to the visitor. <=8192 bytes JSON-encoded.
if [ -n "${PCHAT_BODY_FILE:-}" ]; then
  # The `; printf x` / `%x` dance is NOT a curiosity — it is the whole point.
  # Plain BODY="$(cat file)" strips EVERY trailing newline, so a body file saved
  # by an editor (almost all of them add a final "\n") would be hashed and sent
  # one byte shorter than the file on disk. This script would still agree with
  # itself — it signs what it sends — but it would disagree with
  # ../node/verify-canonical.mjs, which reads the file as raw bytes, and with
  # every other example here. That turns the documented debugging flow ("diff
  # line 6 against verify-canonical.mjs") into a false alarm. Appending a
  # sentinel and stripping only the sentinel preserves the file byte for byte.
  BODY="$(cat "$PCHAT_BODY_FILE"; printf x)"
  BODY="${BODY%x}"
else
  BODY='{"customer_name":"สมชาย ใจดี","provider_name":"ACME Support","external_ref":"ticket-'"$(date +%s)"'","locale":"th","meta":{"plan":"gold"}}'
fi

TIMESTAMP="${PCHAT_TIMESTAMP:-$(date +%s)}"

# Nonce must match [A-Za-z0-9_-]{16,64}. Hex is always safe.
# Do NOT use base64: '+' '/' '=' fail the header check and you get a
# 401 API_KEY_INVALID that looks like a bad key.
NONCE="${PCHAT_NONCE:-$(openssl rand -hex 16)}"

# ---------------------------------------------------------------------------
# >>> THE BUG EVERYONE HITS <<<
# Hash the EXACT bytes that go on the wire. "$BODY" is hashed here with
# printf '%s' — NOT `echo`, which appends a newline that is then not sent, so
# the digest would be over bytes that never existed. The same "$BODY" is handed
# to curl with --data-binary further down; it is never rebuilt or re-quoted.
#
# openssl 3 prints "SHA2-256(stdin)= <hex>" while openssl 1.x prints
# "(stdin)= <hex>" — `awk '{print $NF}'` takes the last field either way.
# (macOS has no sha256sum; this works on both macOS and Linux.)
BODY_SHA="$(printf '%s' "$BODY" | openssl dgst -sha256 | awk '{print $NF}')"

# The canonical string. Mirrors VerifyPublicChatSignature::canonical() exactly:
# six lines joined with "\n", NO trailing newline — hence printf with five \n
# and no sixth.
#
#   1  v1                    the literal version tag
#   2  HTTP METHOD, uppercase
#   3  request path — leading slash, INCLUDES /api/v1, EXCLUDES the query string
#   4  the X-PChat-Timestamp value, verbatim
#   5  the X-PChat-Nonce value, verbatim
#   6  lowercase hex sha256 of the RAW request body bytes
CANONICAL="$(printf '%s\n%s\n%s\n%s\n%s\n%s' \
  "v1" "$METHOD" "$REQ_PATH" "$TIMESTAMP" "$NONCE" "$BODY_SHA")"

SIGNATURE="v1=$(printf '%s' "$CANONICAL" | openssl dgst -sha256 -hmac "$SECRET" | awk '{print $NF}')"
# ---------------------------------------------------------------------------

echo "--- request ------------------------------------------------"
echo "$METHOD $BASE_URL$REQ_PATH"
echo "X-PChat-Key:       ${KEY_ID:-(unset)}"
echo "X-PChat-Timestamp: $TIMESTAMP"
echo "X-PChat-Nonce:     $NONCE"
echo "X-PChat-Signature: $SIGNATURE"
echo "body:              $BODY"
echo "body sha256:       $BODY_SHA"
echo 'canonical (\n shown literally):'
printf '  %s\n' "$(printf '%s' "$CANONICAL" | tr '\n' '~' | sed 's/~/\\n/g')"
echo "canonical hex:     $(printf '%s' "$CANONICAL" | xxd -p | tr -d '\n')"

if [ "$DRY_RUN" = "1" ]; then
  printf '\n(PCHAT_DRY_RUN=1 — nothing sent)\n'
  exit 0
fi

echo
echo "--- response -----------------------------------------------"

# --data-binary, never -d: plain -d strips newlines and can mangle the payload,
# and then the body you signed is not the body you sent.
# -D - dumps the response headers so we can read Retry-After.
RESPONSE="$(curl -sS -X POST "$BASE_URL$REQ_PATH" \
  -D - \
  -H 'Content-Type: application/json' \
  -H 'Accept: application/json' \
  -H 'User-Agent: banana-chat-partner-example/1.0 (+curl)' \
  -H "X-PChat-Key: $KEY_ID" \
  -H "X-PChat-Timestamp: $TIMESTAMP" \
  -H "X-PChat-Nonce: $NONCE" \
  -H "X-PChat-Signature: $SIGNATURE" \
  --data-binary "$BODY")"

echo "$RESPONSE"

STATUS="$(printf '%s' "$RESPONSE" | awk 'BEGIN{IGNORECASE=1} /^HTTP\//{c=$2} END{print c}')"
# tolower(), not awk's IGNORECASE: IGNORECASE is a gawk extension and is a
# silent no-op in the BWK awk that ships with macOS. HTTP/2 lowercases every
# header name, so a literal /^Retry-After:/ would never match in production.
RETRY_AFTER="$(printf '%s' "$RESPONSE" | awk 'tolower($1)=="retry-after:"{print $2}' | tr -d '\r')"
# The error envelope is {"error":{"code":"...","message":"...","request_id":"..."}}.
# Branch on code, NEVER on message: messages may be in Thai.
CODE="$(printf '%s' "$RESPONSE" | sed -n 's/.*"code":"\([A-Z_]*\)".*/\1/p' | head -1)"

echo
echo "--- what that means ----------------------------------------"
case "$STATUS:$CODE" in
  201:*)
    echo "Room created. The visitor link is the \"url\" field above — deliver it over TLS."
    echo "Keep room.id (the ULID) — every later partner call uses it, never the code."
    echo "The code IS the visitor credential; do not put it in logs, emails subjects or analytics URLs."
    ;;
  200:*)
    echo "Idempotent replay: this external_ref already had a room. Not an error."
    ;;
  *:PCHAT_DISABLED)
    # This is what production returns today. Public Chat ships DISABLED
    # (DEC-071); an admin turns it on in the Filament admin Settings page.
    #
    # Getting a 503 here is GOOD NEWS for your integration: the feature gate runs
    # LAST, inside the controller, after the HMAC middleware has already verified
    # your key, your timestamp, your signature and your nonce. A 503
    # PCHAT_DISABLED is positive proof that your signing is correct.
    echo "Signature VERIFIED. The feature is switched off by the workspace admin."
    echo "Retriable — Retry-After: ${RETRY_AFTER:-60}s."
    echo "Ask the admin to enable Public Chat in the admin Settings page."
    echo "(Note: GET /rooms/{id} keeps answering while disabled — reads survive.)"
    ;;
  *:API_SIGNATURE_INVALID)
    echo "The canonical string you built differs from ours. Run:"
    echo "  node ../node/verify-canonical.mjs POST $REQ_PATH $TIMESTAMP $NONCE <body-file>"
    echo "and diff it line by line. Line 6 (the body digest) is wrong most often —"
    echo "usually because the body was re-serialised after being hashed."
    ;;
  *:API_TIMESTAMP_SKEW)
    echo "Your clock is more than 300s from ours. Run NTP."
    ;;
  *:API_KEY_INVALID)
    echo "Bad/revoked key_id, or a malformed header. Check that:"
    echo "  - key_id matches pck_ + 28 lowercase hex"
    echo "  - the nonce matches [A-Za-z0-9_-]{16,64}  <- base64 nonces land here"
    echo "  - all four X-PChat-* headers are present"
    ;;
  *:API_NONCE_REPLAYED)
    echo "That nonce was already used within the last 600s. Generate a fresh one per request."
    ;;
  *:VALIDATION_FAILED)
    echo "Body rejected — see error.details above."
    ;;
  429:*)
    echo "Rate limited. Create is 60/min per key."
    ;;
  *:)
    # No {"error":{"code":...}} envelope means something in front of the API
    # answered — a CDN/WAF block, a proxy, or a captive network. Not a signing bug.
    echo "HTTP $STATUS with no API error envelope — an intermediary answered, not the API."
    echo "Check your User-Agent and that you can reach $BASE_URL at all."
    ;;
  *)
    echo "Unexpected status $STATUS. Quote error.request_id above when contacting support."
    ;;
esac
