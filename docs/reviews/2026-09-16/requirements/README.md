# Meeting and expiring-chat requirements — 2026-09-16

User-authorized implementation and production deployment. Camera requirement interpreted as **off by default**, matching the request that participants turn it on themselves. Secret chat means a separate expiring room, not end-to-end encryption.

## Verification ledger

- Production SSH access verified before implementation. Claude Code 2.1.273 restored; its `opus` alias resolves to GLM 5.2 through the configured Z.AI endpoint. Two CLI sidekicks implement secret rooms and capacity/mobile changes; Codex handles media, independent review, integration and deployment.
- Media source trace: shared `MediaPanel` explicitly enabled the camera after microphone on every video join; all shares went into `GridLayout`. Replaced with camera opt-in and a selectable focus stage. Multiple participants can share concurrently; browser fullscreen remains an explicit gesture.
- `verify-audio.mjs` renders the actual gain/compressor adapter through `OfflineAudioContext`: default quiet-signal RMS increases 1.5x, tested loud steady signal remains below 1.0, mute produces zero. This does not establish physical speaker output or subjective equivalence to another meeting product.
- Predeployment meeting browser checks: 12 passed; private call checks: 15 passed. Three browser contexts use real LiveKit transport and forced TURN TLS on `media.gamecoms.net:443`. Media capture is synthetic. Camera-off entry, explicit enable, multiple shares, focus/fullscreen, playback gain, mobile layout, leave/logout/revocation and track cleanup covered.
- Initial browser harness fixes: use installed Chrome (Playwright bundled browser unavailable); `artisan serve --no-reload` preserves isolated container environment; camera control selector follows actual SDK markup. The production orphan reconciler removed initial unknown QA rooms; the isolated test container now mounts a **test-only** MediaServer adapter that prefixes SFU rooms with `qa-sept16-`, strips the prefix during local admission, and filters room enumeration to that namespace. Production code and scheduler are unchanged. The adapter is never deployed.
- Independent capacity review: real SFU CreateRoom requested 2 -> returned 2, then requested 5 -> returned 2. Existing SFU room limits are immutable through this API. New capacity is snapshotted for new calls/meeting links so app and SFU admission agree; existing meetings keep their capacity.
- Secret-room review identified queued model serialization after hard deletion, early manual room deletion skipping expiry, and signed storage URL expiry. Fixes and regression evidence are required before deployment.

## Environment and rollout

Local API uses a dedicated `orgchat_call_review` database, ports 18000/18880, temporary users/workspaces and an SSH-only SFU API tunnel. PHP tests use separate test databases. No existing customer conversation is used as a fixture.

Production backup: `/root/banana-chat-backups/requirements-20260916` (database, source archive and prior working-tree diff). Rollback images: `banana-chat-prod-{api,worker,scheduler,reverb,nginx}:before-requirements-20260916`. Runtime source baselines are compared before incremental deployment to preserve prior server modifications.

## Deployment and final totals (appended 2026-09-16, Claude)

Merged `origin/main` (commits `79f3cf7`, `e21f421` — FR-CALL-001 ringtone and unified chat
controls) before the final deployment; one conflict in `apps/web/src/index.css`, resolved by
keeping both blocks (the DEC-058 coarse-pointer floor and the TASK-WEB-018 message-action rules
are independent). Merge commit `960f538`.

Automated suites after the merge: `apps/api` Pest 404 passed / 2 skipped / 0 failed
(1964 assertions); `pnpm test` 167 passed across packages/shared, packages/api-client,
packages/chat-core and apps/mobile; `pnpm typecheck` and `pnpm build:web` clean.

Production verification against `https://chat.gamecoms.net` after deployment — 44 checks, all
passed, each against a throwaway workspace that was removed afterwards:

| Script | Checks | Covers |
|---|---|---|
| `verify-private-calls.mjs` | 15 | FR-CALL-007 camera-off entry, focus/fullscreen, forced TURN TLS, three-way RTP |
| `verify-meetings.mjs` | 12 | FR-MEET-*, TC-CALL-030 concurrent shares + auto-focus, TC-CALL-031 gain 150%→200% |
| `verify-secret-rooms.mjs` | 9 | FR-ROOM-012 creation, validation, dm_key namespace, 410 at deadline, sweeper hard delete, EVT-003 eviction |
| `verify-mobile.mjs` | 7 | FR-WEB-001 viewport meta, 16px floor across 6 surfaces, negative probe, no overflow |
| `verify-admin.mjs` | 1 | FR-CALL-006 admin capacity control and active-session policy |

`verify-secret-rooms.mjs` exercises the destructive `ExpireSecretRooms` path on production
against its own fixture room and asserts that every room outside the fixture workspace is
untouched (`evidence.prodRoomsOutsideFixture`: before 9, after 9, `missingIds: []`). Verified
independently from the database: the nine production room ids and the 107-message count were
byte-identical before and after the run.

### Incidents during this deployment

1. **API 502, roughly 03:50–03:57 UTC.** A 300 s timeout in the deploy helper fired mid-build and
   its automatic retry started a second concurrent `docker compose up --build`; the two raced on
   container removal and left `api` stopped. Fixed by force-removing the stale containers and
   bringing the stack up again. The retry was removed from the helper. No data loss.
2. **`rsync --delete` removed production-only files.** `infra/livekit/config.yaml` and
   `infra/livekit/certs/` (the TURN TLS certificate) were deleted and restored from
   `/root/banana-chat-backups/extra-reqs-20260916`.

   The first hypothesis — that this deletion caused the `TC-CALL-011` forced-TURN-TLS failure —
   was **wrong, and was checked rather than assumed**. `docker exec livekit ls -la /certs`
   showed the container's mount was an empty orphaned inode *after* the host-side restore, yet
   `TC-CALL-011` passed on the re-run: LiveKit loads `cert_file`/`key_file` into memory at
   startup and does not re-read them per handshake, so the running SFU never noticed. The single
   `TC-CALL-011` failure was therefore transient (three relay-forced Chrome contexts from one
   laptop against a 45 s timeout), not caused by the deletion.

   The deletion was still a latent outage: the restore did not reach the running container, so
   the **next** LiveKit restart would have found `/certs` empty and failed to serve TURN TLS.
   `docker compose up -d --force-recreate --no-deps livekit` was run to re-resolve the bind
   mount; `/certs` is now populated inside the container and the full 15-check private-call
   suite, `TC-CALL-011` included, passes from that cold start.

   The same `--delete` also removed `IncomingRingtone.tsx`,
   `notification-audio.ts` and `buttons.css`, which existed on `origin/main` but not on the
   deploying branch, so the rebuilt SPA shipped without the FR-CALL-001 ringtone for about an
   hour; the merge above restored it and the live bundle was re-checked.

   **Deploy rule going forward:** never `rsync --delete` to `/opt/banana-chat`, and always
   exclude `infra/livekit/config.yaml`, `infra/livekit/certs`, `infra/livekit/acme-webroot`,
   `infra/.env` and `apps/api/.env`. Merge `origin/main` before deploying.

### Known gaps

- "Screen share full screen by default" is implemented as automatic in-app stage fill plus a
  gesture-gated **Full screen** button. Browsers reject `requestFullscreen` without a user
  gesture (DEC-059), so a literal automatic browser-fullscreen is not possible.
- The iOS on-screen-keyboard pan (the second half of "don't move") is not addressed;
  `interactive-widget=resizes-content` covers Android. Chromium cannot reproduce iOS Safari's
  focus auto-zoom, so `verify-mobile.mjs` proves the CSS floor and viewport meta are live on
  production, not the device behaviour. Needs a physical iOS device to close.
- `TC-CALL-032` has no component test asserting the camera is never enabled on join; `apps/web`
  has no vitest/jsdom harness. The behaviour is covered by the two production scripts above.

---

## Public Chat (FR-PCHAT-*) — production verification, 2026-09-16

Deployed as `fc07350`. Feature ships DISABLED (`publicchat.enabled = false`, DEC-071).

`verify-public-chat.mjs` (run with `PCHAT_QA_PRODUCTION=1`) exercises all three tiers against
`https://chat.gamecoms.net` from a throwaway workspace, then restores the flag and removes every
fixture. **19 checks, all passed**:

| Tier | Covered |
|---|---|
| Kill switch | a correctly HMAC-signed partner create returns `503 PCHAT_DISABLED` while the flag is off — and again after it is restored |
| API key | plaintext returned exactly once; the row stores ciphertext + last4 only; the audit row carries `key_id`, never the secret |
| HMAC | correct signature accepted; missing headers, ±400s skew, unknown key, tampered body and replayed nonce each rejected with the documented code; a nonce burned by a bad-signature attempt is still usable, proving replay is checked *after* signature |
| Partner | `API-200` returns a `/support/<64-hex>` link; replaying `external_ref` is idempotent (same room id) |
| Visitor | opens the link with no login, sees customer + provider names, sends a message; **zero** call/meeting controls in the DOM; `sender_kind=visitor` with a NULL user |
| Agent | Public Chat rail entry; room lists as `new`/unassigned; server-side filtering by status and assignee; replying **auto-claims** (assignee set, status → in progress) and survives a reload |
| External identity | the agent's message renders to the visitor as exactly `provider name (admin username)`; the visitor wire carries neither the agent's ULID nor display name |
| `problem` never leaks | page text, `API-210` and `API-211` are all free of `problem` / `in_progress` / `มีปัญหา`; `status_public` stays `open`; the zero-delta system row is absent (DEC-074) |
| Isolation (DEC-064) | the public chat room is absent from `GET /rooms` and the sidebar; a real production room id is rejected `404 PCHAT_ROOM_NOT_FOUND` by every public-chat tier |
| Edge (DEC-063) | the 64-hex code appears in no response header; `/support/<code>` answers `Referrer-Policy: no-referrer` + `Cache-Control: no-store` |

**Verified independently from the database, not just by the script:** the ten production room ids were
byte-identical before and after; messages stayed at 108 and users at 9; `publicchat.enabled` is back to
`false`; and `public_chat_rooms`, `public_chat_api_keys` and `pchatqa%` workspaces are all at zero.

Also confirmed on the live edge: a request carrying a 64-hex code appears **0 times** in nginx's logs —
the `/support/` and `/api/v1/public-chat/` locations emit no log line at all, with the redacting
`log_format` as the backstop for fall-throughs.

### Test-environment correction

The "115 pre-existing failures" recorded earlier in this file were **never a code defect**. Port 8088 was
held by a QA Reverb serving app `qa` while `apps/api/phpunit.xml` inherits `REVERB_APP_ID=784046` from
`.env`, so every broadcasting write 500'd with `Pusher error: No matching application for ID [784046]`.
With Reverb restarted from `.env`, the full suite is **535 passed / 2 skipped / 0 failed** (3046
assertions) — including `TC-ROOM-074` and every channel-authorisation test, which no earlier run in this
session had actually verified under either broadcaster.

### Known gap

One result row in `production-public-chat-results.json` for FR-PCHAT-009 shows `"status": "in_progress"`
instead of `"passed"`: the evidence object passed to `pass()` carried a `status` key that overwrote the
row's own pass/fail field. The check itself passed — every assertion ahead of it (the "In progress" pill,
the assignee cell, the filter flips) would have thrown otherwise, and the run exited 0. Fixed in the
script by renaming the evidence key to `room_status`.
