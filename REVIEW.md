# Project review — banana-chat-glm

Reviewed: 2026-09-19 · Commit: `79d1cf2` · Scope: current checkout.

**Verdict: fix-then-ship.** Address attachment authorization and upload integrity first. This is a prioritized source review, not a production penetration test or certification of every feature. Application code was not changed.

## Intent and approach

The project provides self-hosted workspace chat across web and mobile, with private rooms, attachments, AI, calls, and public support conversations. The existing architecture can support that goal: targeted authorization, lifecycle wiring, and regression tests are preferable to a rewrite or broad dependency upgrade.

Review size: LARGE; risk: HIGH for authentication/media findings. Codex inspected requirements, source paths, tests, CI and deployment configuration; an independent Codex reviewer inspected backend authorization, media and refresh-token handling. Preferred Claude/OpenCode configurations were not verified and those agents were not used for review. No deployment was performed.

## Findings

### R1 — HIGH: Attachment URL renewal lacks room authorization

**Evidence:** `apps/api/routes/api.php:170` applies account/workspace middleware; the attachment route at line 262 reaches `apps/api/app/Http/Controllers/Api/V1/UploadController.php:87`. Its lookup at line 176 checks workspace scope and non-pending status, then `show()` serializes fresh signed URLs without checking the uploader or access to the containing room. `PRODUCT_SPEC.md:1757` explicitly requires room membership or uploader identity for API-062.

**Impact:** A removed room member who remains in the workspace and retains an attachment ID can renew its download URL. The expiry check for secret rooms does not cover ordinary room membership removal.

**Update:** Centralize attachment read authorization and apply it before issuing URLs. Account for each supported attachment context, including room messages/notes, public support chat and intentional workspace-wide Kanban access.

**Validation:** Add API tests denying unrelated workspace members and removed room members, while allowing the uploader and currently authorized readers. Source trace confirmed independently; API reproduction was not run.

### R2 — HIGH: A completed S3 upload can be overwritten after validation

**Evidence:** `apps/api/app/Domain/Media/UploadService.php:184` chooses the final object key and line 215 signs a 15-minute PUT to that key. `finish()` at lines 299–325 validates size/MIME and dispatches processing without moving the object to an inaccessible key or pinning an immutable version. `apps/api/app/Jobs/ProcessAttachment.php:94` scans that same key; `apps/api/app/Domain/Media/AttachmentSerializer.php:46` signs downloads from it. S3 presigned URLs are reusable until expiry and uploads replace an existing object at the same key. [AWS documentation](https://docs.aws.amazon.com/AmazonS3/latest/userguide/using-presigned-url.html).

**Impact:** For the single-PUT path, a client can upload an acceptable file, wait for completion/scanning, then overwrite its bytes with the still-valid upload URL. The delivered object can differ from the recorded MIME, size and malware-scan result. The local-disk route rejects writes after pending status, so local fake-storage tests do not establish S3 safety.

**Update:** Upload to a staging key; finalize to a separate server-controlled key/version, then validate and scan exactly the immutable bytes that will be served. Merely shortening the URL lifetime does not remove the race.

**Validation:** Add an isolated S3/MinIO integration test that replays the original PUT after completion and verifies it cannot alter the served attachment. Source and documented S3 semantics support this finding; no live storage reproduction was performed.

### R3 — HIGH: Mobile persistence is never initialized

**Evidence:** `apps/mobile/src/auth/session.ts:36` initializes `db` to null; bootstrap/login never populate it. `openMobileDb()` in `apps/mobile/src/db/driver.ts:23` has no application callers. Consequently `roomCache()`, `aiCache()` and `scopedOutbox()` return null (`session.ts:96–115`). The room screen at `apps/mobile/app/room/[id].tsx:95` falls back to an outbox whose save operation does nothing.

**Impact:** The shipped mobile path does not use the SQLite caches. Pending messages disappear when that room screen is unmounted or the process restarts, despite the offline persistence contract. Passing adapter tests do not exercise application bootstrap.

**Update:** Open and initialize the database during startup, assign it to session state, and gate cache/outbox creation on database readiness. Surface initialization failures instead of silently using a nonpersistent queue.

**Validation:** Exercise real bootstrap followed by offline enqueue, room navigation, process restart and restore. Include account/workspace isolation and logout wiping. Existing mobile tests construct their adapters directly and therefore miss this wiring gap.

### R4 — MEDIUM: chat-core typecheck fails and blocks the CI web job

**Evidence:** Running `node --run typecheck` in `packages/chat-core` exits 1:

```text
src/ai-stream.test.ts(2,37): error TS2835: Relative import paths need explicit file extensions ... Did you mean './ai-stream.js'?
src/ai-stream.test.ts(32,47): error TS7006: Parameter 's' implicitly has an 'any' type.
```

`packages/chat-core/tsconfig.json` uses NodeNext and includes `src` and `test`; `.github/workflows/ci.yml` runs recursive typechecks before unit tests/build.

**Update:** Correct the import at `packages/chat-core/src/ai-stream.test.ts:2` to use the module's `.js` specifier, then recheck the inferred callback type. Do not exclude the test or loosen strictness to hide the failure.

**Validation:** Run the package typecheck, recursive workspace typecheck and affected AI stream tests. This failure was executed locally, independently of the missing native test dependencies.

### R5 — MEDIUM: Refresh-token rotation is not atomic

**Evidence:** `apps/api/app/Domain/Auth/Actions/RefreshAction.php:29` reads the current hash without locking; lines 55–56 rotate and issue an access token. `apps/api/app/Domain/Auth/TokenService.php:103` saves the replacement against the session ID without a compare-and-swap condition. The controller does not wrap this in a transaction.

**Impact:** Two requests that both read R0 before either update can both succeed with different replacement tokens. The last write wins, leaving one caller with an unusable refresh token while both issued access tokens remain valid. Concurrent reuse also misses the intended reuse-detection branch. Client-side single-flight only protects one TokenManager instance.

**Update:** Atomically consume and rotate the current token, using a transaction/row lock or conditional update. Define the losing request's behavior and ensure any reuse revocation survives transaction rollback.

**Validation:** Add a PostgreSQL concurrency test synchronizing two refresh requests at the read/consume boundary. Existing sequential refresh tests do not exercise this interleaving. Static finding; not runtime-reproduced.

### R6 — MEDIUM: Reuse detection forgets older refresh tokens

**Evidence:** `RefreshAction.php:33` checks only `prev_refresh_token_hash`; `TokenService.php:104` overwrites it on every rotation. Following R0 → R1 → R2, replaying R0 matches neither stored hash and returns generic invalid-token without revoking the session. FR-AUTH-002 (`PRODUCT_SPEC.md:759`) requires reuse of a rotated token to revoke the session and create an audit event.

**Impact:** Theft detection covers only the immediate predecessor, not the full refresh-token lineage.

**Update:** Retain consumed token hashes associated with the session for the applicable session/token lifetime, with bounded cleanup, and perform lookup/revocation atomically with rotation.

**Validation:** Rotate twice, replay the first token, and assert session/access-token revocation plus the reuse audit event. Static finding; not runtime-reproduced.

### R7 — MEDIUM: Mobile replies lose their parent reference

**Evidence:** `apps/mobile/app/room/[id].tsx:202` queues `replyToMessageId`. The shared Outbox preserves it as `reply_to_message_id`, but `apps/mobile/src/offline/outbox-flusher.ts:55` passes `undefined` as the fifth argument to `sendMessage()`. `packages/api-client/src/endpoints.ts:271` uses that argument for the request's reply reference.

**Impact:** Sending a reply from mobile produces an ordinary message, including when already online. The chosen parent is silently discarded.

**Update:** Forward `entry.reply_to_message_id` to `sendMessage()`.

**Validation:** Add an outbox-sender test asserting the fifth argument and a restored queued-reply case. The current test helper accepts `_reply` but does not record or assert it. Static trace; current tests pass without checking this behavior.

### R8 — MEDIUM: Mobile forced-update handler is never invoked

**Evidence:** `apps/mobile/app/_layout.tsx:138` assigns a handler to `globalThis.__onApiError`, but no application or shared-client code calls it. `packages/api-client/src/client.ts` throws API errors; `apps/mobile/src/lib/api.ts` supplies headers without an error observer. The only automatic navigation to `/force-update` is inside that unused handler.

**Impact:** A server 426 response is handled as an ordinary screen/bootstrap error rather than showing the required update screen. The current gate unit test verifies only the predicate, not the request-to-navigation path.

**Update:** Connect a centralized API-error observer to mobile navigation/state and enforce the update gate across routes. Preserve normal error propagation for other callers.

**Validation:** Inject a 426 from both bootstrap and an authenticated request; assert the update screen is reached and protected screens remain gated.

### R9 — MEDIUM: ZAP workflow readiness checks depend on absent services

**Evidence:** `.github/workflows/security.yml:78` starts the API and requires `/api/v1/health` to return success before ZAP runs. The job provisions PostgreSQL/Redis only. Its copied `.env.example:36` selects S3, and line 69 targets Reverb on port 8088; neither service is started. `apps/api/app/Http/Controllers/Api/V1/HealthController.php:36` probes storage and line 58 probes Reverb; any failed check returns 503.

**Impact:** The readiness step fails on a fresh runner, preventing the scheduled baseline scan from reaching its target. Backgrounding migration also hides migration failure from the setup command.

**Update:** Run migration synchronously, use local storage for this job or provision S3, and start Reverb before the full-health gate. Alternatively use an explicit application-readiness probe appropriate to the scan's dependencies.

**Validation:** Run the workflow manually and confirm both readiness and ZAP execution complete. This is a configuration/source trace, not an inspected GitHub Actions run.

## Executed verification and limits

Commands below ran from the stated directory using Node `v22.23.2` and already-installed dependencies. No dependency installation, lockfile update, production request or deployment was performed.

| Directory | Command | Result |
| --- | --- | --- |
| Repository root | `git status --short` | Clean before review |
| `apps/mobile` | `node --run test -- --runInBand && node --run typecheck` | PASS: 9 suites, 40 tests; typecheck exit 0 |
| `apps/web` | `node --run typecheck && node --run build` | Typecheck passed; build reached Vite and failed loading missing native Rolldown bindings |
| `packages/shared` | `node --run typecheck` | PASS |
| `packages/api-client` | `node --run typecheck` | PASS |
| `packages/chat-core` | `node --run typecheck` | FAIL: TS2835 and TS7006; R4 |
| Each of `packages/shared`, `packages/api-client`, `packages/chat-core` | `node node_modules/vitest/vitest.mjs run` | BLOCKED before tests: missing `@rollup/rollup-linux-x64-gnu` |
| `apps/web` | `node --run lint` | BLOCKED: missing `@oxlint/binding-linux-x64-gnu` and fallback binding |
| Repository root | `pnpm --version`; `php --version` | Both unavailable on PATH; API vendor directory absent |

An initial chat-core test invocation used a duplicated relative path and failed module resolution; it was corrected to the command above. Native-module startup failures are checkout/environment limitations, not evidence that the underlying test assertions fail.

Pest/Pint, live API/S3 integration, browser E2E, native-device QA, dependency vulnerability audits and GitHub workflow execution were not run. No claims about latest package versions or absence of vulnerabilities are made. Restore the prescribed local toolchain and platform dependencies, rerun the blocked checks, and add the targeted regressions before treating this project as release-verified.

**Review deliverable complete; release QA remains PARTIAL.** Highest priority: close attachment access and upload-integrity gaps, then restore mobile persistence and the failing typecheck.
