#!/usr/bin/env python3
"""Banana Chat — Public Chat partner API (Tier 1, HMAC).

Creates a support room and prints the visitor link.
Python 3.7+. Standard library only: hmac, hashlib, json, os, secrets, time, urllib.

    PCHAT_KEY_ID=pck_... PCHAT_SECRET=pcs_... python3 sign.py

Environment:
    PCHAT_KEY_ID     required. 'pck_' + 28 lowercase hex (32 chars). Public, safe to log.
    PCHAT_SECRET     required. 'pcs_' + 64 lowercase hex (68 chars). The HMAC key is the
                     WHOLE string, prefix included. Shown once at issuance; never printed here.
    PCHAT_BASE_URL   default https://chat.gamecoms.net
    PCHAT_TIMESTAMP  override the unix-seconds timestamp (debugging / reproducible runs)
    PCHAT_NONCE      override the nonce (debugging / reproducible runs)
    PCHAT_BODY_FILE  read the request body verbatim from this file instead of building one
    PCHAT_DRY_RUN=1  print the canonical string and signature, send nothing
"""

import hashlib
import hmac
import json
import os
import secrets
import sys
import time
import urllib.error
import urllib.request

VERSION = "v1"

# Identify your integration. See the User-Agent note where the request is built.
USER_AGENT = "banana-chat-partner-example/1.0 (+python-urllib)"


def canonical(method, path, timestamp, nonce, raw_body):
    """The canonical string, byte-for-byte what VerifyPublicChatSignature::canonical() builds.

    Six lines joined with "\\n", NO trailing newline:

        1  v1                    the literal version tag
        2  HTTP METHOD, uppercase
        3  request path — leading slash, INCLUDES /api/v1, EXCLUDES the query string
        4  the X-PChat-Timestamp value, verbatim
        5  the X-PChat-Nonce value, verbatim
        6  lowercase hex sha256 of the RAW request body bytes (sha256("") if no body)

    `raw_body` is BYTES on purpose — the digest must be over what goes on the wire.
    """
    return "\n".join([
        VERSION,
        method.upper(),
        path,
        str(timestamp),
        nonce,
        # >>> THE BUG EVERYONE HITS <<<
        # Hash the EXACT bytes that go on the wire. `raw_body` is already encoded
        # here and those same bytes are handed to urllib below — they are never
        # re-serialised. A second json.dumps() (or letting a HTTP client encode a
        # dict for you) changes separators, key order and \\uXXXX escaping, which
        # changes this digest and produces intermittent 401s.
        hashlib.sha256(raw_body).hexdigest(),
    ])


def sign(secret, canonical_string):
    mac = hmac.new(secret.encode("utf-8"), canonical_string.encode("utf-8"), hashlib.sha256)
    return VERSION + "=" + mac.hexdigest()


def fresh_nonce():
    """Nonce must match [A-Za-z0-9_-]{16,64}. Hex is always safe.

    Do NOT use base64: '+' '/' '=' fail the header check and you get a
    401 API_KEY_INVALID that looks like a bad key.
    """
    return secrets.token_hex(16)


def main():
    base_url = os.environ.get("PCHAT_BASE_URL", "https://chat.gamecoms.net").rstrip("/")
    key_id = os.environ.get("PCHAT_KEY_ID", "")
    secret = os.environ.get("PCHAT_SECRET", "")
    dry_run = os.environ.get("PCHAT_DRY_RUN") == "1"

    if not dry_run and (not key_id or not secret):
        sys.stderr.write("Set PCHAT_KEY_ID and PCHAT_SECRET (or PCHAT_DRY_RUN=1).\n")
        return 2

    method = "POST"
    # No trailing slash. getPathInfo() keeps one if you send it, and your
    # signature will not have it.
    path = "/api/v1/partner/public-chat/rooms"

    # Encode the body ONCE, to bytes. Everything downstream — the digest and the
    # wire — uses these exact bytes.
    body_file = os.environ.get("PCHAT_BODY_FILE")
    if body_file:
        with open(body_file, "rb") as fh:
            body = fh.read()
    else:
        body = json.dumps({
            "customer_name": "สมชาย ใจดี",          # required, 1..120
            "provider_name": "ACME Support",        # required, 1..120 — shown to the visitor
            "external_ref": "ticket-%d" % time.time(),  # optional, <=120. Reuse it and the create
                                                    # is idempotent: 200 + the same room, not 201.
            "locale": "th",                         # optional, 'th' or 'en'
            "meta": {"plan": "gold"},               # optional. Partner-private: stored, shown to
                                                    # staff, NEVER served to the visitor.
                                                    # <=8192 bytes JSON-encoded.
        }, ensure_ascii=False, separators=(",", ":")).encode("utf-8")

    timestamp = os.environ.get("PCHAT_TIMESTAMP") or str(int(time.time()))
    nonce = os.environ.get("PCHAT_NONCE") or fresh_nonce()

    canonical_string = canonical(method, path, timestamp, nonce, body)
    signature = sign(secret, canonical_string)

    print("--- request ------------------------------------------------")
    print("%s %s%s" % (method, base_url, path))
    print("X-PChat-Key:       %s" % (key_id or "(unset)"))
    print("X-PChat-Timestamp: %s" % timestamp)
    print("X-PChat-Nonce:     %s" % nonce)
    print("X-PChat-Signature: %s" % signature)
    print("body:              %s" % body.decode("utf-8"))
    print("body sha256:       %s" % hashlib.sha256(body).hexdigest())
    print("canonical (\\n shown literally):")
    print("  %s" % canonical_string.replace("\n", "\\n"))
    print("canonical hex:     %s" % canonical_string.encode("utf-8").hex())

    if dry_run:
        print("\n(PCHAT_DRY_RUN=1 — nothing sent)")
        return 0

    request = urllib.request.Request(
        base_url + path,
        data=body,  # the SAME bytes that were hashed above
        method="POST",
        headers={
            # Without Content-Type Laravel does not parse the JSON and you get a
            # confusing 422.
            "Content-Type": "application/json",
            "Accept": "application/json",
            # ALWAYS send a real User-Agent. urllib's default is
            # "Python-urllib/3.x", which the CDN in front of the API blocks
            # outright — you get a Cloudflare 403 "Error 1010 /
            # browser_signature_banned" HTML-ish body and the request never
            # reaches the API at all. It is NOT a signing problem: the giveaway
            # is that the response has no {"error":{"code":...}} envelope.
            "User-Agent": USER_AGENT,
            "X-PChat-Key": key_id,
            "X-PChat-Timestamp": timestamp,
            "X-PChat-Nonce": nonce,
            "X-PChat-Signature": signature,
        },
    )

    # urllib raises on 4xx/5xx; the error object IS the response, and the error
    # envelope we need to read is in its body.
    try:
        response = urllib.request.urlopen(request, timeout=20)
        status, headers, text = response.status, response.headers, response.read().decode("utf-8")
    except urllib.error.HTTPError as err:
        status, headers, text = err.code, err.headers, err.read().decode("utf-8")
    except urllib.error.URLError as err:
        sys.stderr.write("network error: %s\n" % err)
        return 1

    print("\n--- response -----------------------------------------------")
    print("status: %d" % status)
    retry_after = headers.get("Retry-After")
    if retry_after:
        print("Retry-After: %s" % retry_after)
    print(text)

    try:
        payload = json.loads(text)
    except ValueError:
        payload = {}

    # Branch on error.code, NEVER on error.message: messages may be in Thai.
    code = payload.get("error", {}).get("code")

    print("\n--- what that means ----------------------------------------")
    if status == 201:
        print("Room created. Give this link to the customer over TLS:")
        print("  %s" % payload["url"])
        print("Keep room.id (%s) — every later partner call uses the ULID," % payload["room"]["id"])
        print("never the code. The code is the visitor credential; do not put it in logs.")
    elif status == 200:
        print("Idempotent replay: this external_ref already had a room. Not an error.")
        print("  %s" % payload["url"])
    elif code == "PCHAT_DISABLED":
        # This is what production returns today. Public Chat ships DISABLED
        # (DEC-071); an admin turns it on in the Filament admin Settings page.
        #
        # Getting a 503 here is GOOD NEWS for your integration: the feature gate
        # runs LAST, inside the controller, after the HMAC middleware has already
        # verified your key, your timestamp, your signature and your nonce. A 503
        # PCHAT_DISABLED is positive proof that your signing is correct.
        print("Signature VERIFIED. The feature is switched off by the workspace admin.")
        print("Retriable — Retry-After: %ss." % (retry_after or "60"))
        print("Ask the admin to enable Public Chat in the admin Settings page.")
        print("(Note: GET /rooms/{id} keeps answering while disabled — reads survive.)")
    elif code == "API_SIGNATURE_INVALID":
        print("The canonical string you built differs from ours. Run:")
        print("  node ../node/verify-canonical.mjs POST %s %s %s <body-file>" % (path, timestamp, nonce))
        print("and diff it line by line. Line 6 (the body digest) is wrong most often —")
        print("usually because the body was re-serialised after being hashed.")
    elif code == "API_TIMESTAMP_SKEW":
        print("Your clock is more than 300s from ours. Run NTP.")
    elif code == "API_KEY_INVALID":
        print("Bad/revoked key_id, or a malformed header. Check that:")
        print("  - key_id matches pck_ + 28 lowercase hex")
        print("  - the nonce matches [A-Za-z0-9_-]{16,64}  <- base64 nonces land here")
        print("  - all four X-PChat-* headers are present")
    elif code == "API_NONCE_REPLAYED":
        print("That nonce was already used within the last 600s. Generate a fresh one per request.")
    elif code == "VALIDATION_FAILED":
        print("Body rejected: %s" % json.dumps(payload["error"].get("details"), ensure_ascii=False))
    elif status == 429:
        print("Rate limited. Create is 60/min per key.")
    elif not payload.get("error"):
        # No {"error":{"code":...}} envelope means something in front of the API
        # answered — a CDN/WAF block (Cloudflare 1010 = banned User-Agent), a
        # proxy, or a captive network. Nothing to do with your signature.
        print("HTTP %d with no API error envelope — an intermediary answered, not the API." % status)
        print("Check your User-Agent and that you can reach %s at all." % base_url)
    else:
        print("Unexpected. request_id for support: %s" % payload.get("error", {}).get("request_id", "n/a"))

    return 0


if __name__ == "__main__":
    sys.exit(main())
