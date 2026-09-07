# Security Review Checklist (TASK-QA-007, §11.2)

Review cadence: before every release cut, plus the automated weekly pass
(`.github/workflows/security.yml` — dependency audit + OWASP ZAP baseline).
Gate per spec §12.2: **0 high/critical**.

Status legend: ✅ implemented + automated test · 🔧 implemented, verify
manually at deploy · ⏳ scheduled phase (PH3/PH4)

## NFR-SEC matrix

| ID | Requirement | Status | Where / how verified |
|---|---|---|---|
| NFR-SEC-001 | HTTPS only, HSTS, TLS 1.2+, wss | 🔧 deploy | Terminated at the edge proxy (Coolify/nginx) — set `Strict-Transport-Security: max-age=31536000; includeSubDomains`, TLS 1.2+ ciphers, and 301 HTTP→HTTPS. Verify with `curl -sI https://<host>` + SSL Labs. Local dev is plain HTTP by design. |
| NFR-SEC-002 | argon2id, hashed tokens, refresh rotation + reuse detection | ✅ | `config/hashing.php` (argon2id); `AccessToken::token_hash` hidden + sha256; `Domain/Auth/Actions/RefreshAction.php` reuse → revoke family + audit `auth.refresh_reuse_detected`. TC-AUTH-*/TC-SEC tests. |
| NFR-SEC-003 | Web: access in memory, refresh in localStorage (DEC-011) | ✅ | `apps/web/src/lib/auth-store.ts` + `packages/api-client` — token never persisted to disk except refresh key. Verify in DevTools → Application → Local Storage (only refresh). |
| NFR-SEC-004 | Workspace isolation everywhere | ✅ | Global scopes (`app/Models/Scopes/`) + policies + `WorkspaceContextMiddleware`; TC-WS-008..012, TC-PERM-* suite. |
| NFR-SEC-005 | No HTML render from user input | ✅ | Web renders message text as React nodes (auto-escaped, no `dangerouslySetInnerHTML`); @mention chips via split, not HTML. Markdown-lite whitelist = DEC-041 (PH4). |
| NFR-SEC-006 | File safety: sniff mime, block exec, strip EXIF, SVG-as-attachment, Content-Disposition, files subdomain | 🔧 partial | `Domain/Media/UploadService.php` — finfo sniff wins, allowlist per kind, SVG not in image allowlist (served as attachment); `ProcessAttachment` re-encodes thumbnails (EXIF-free), originals keep EXIF by DEC-034. ClamAV = BE-023 (PH3). `files.` subdomain = deploy config (serve MinIO/S3 via its own origin, `Content-Disposition: attachment` from `MediaUrls`). |
| NFR-SEC-007 | Rate limits on every endpoint | ✅ | `AppServiceProvider` — `api` 300/min/user default, login 5/min/IP + 10/15min/username, refresh 30/min, ai-send 20/min. 429 envelope w/ retry_after. TC tests. |
| NFR-SEC-008 | Security headers | ✅ API / 🔧 web host | `SecurityHeaders` middleware (nosniff, X-Frame-Options DENY, Referrer-Policy, Permissions-Policy) — TC in `SecurityHeadersTest`. CSP `script-src 'self'` + hashes is set on the SPA host at deploy (nginx config when the prod fronting config lands). |
| NFR-SEC-009 | Audit log coverage | ✅ | `AuditLog` — auth events, admin actions, moderation, settings, deletes; asserted in feature tests (`audit row` convention §12.3). |
| NFR-SEC-010 | Secrets in env only | ✅ | `.env.example` complete (incl. AI keys, breaker, Horizon); nothing secret committed; provider key encrypted at rest (below). Grep CI target: `git grep -iE "(sk-|api_key)\s*=" -- ':!*.example'` stays empty. |
| NFR-SEC-011 | Dependency audit in CI | ✅ | `security.yml` → `composer audit --audit-level=high` + `pnpm audit --audit-level=high --prod`, weekly + dispatch. |
| NFR-SEC-012 | Admin: IP allowlist, 2FA (P1), 30-min idle | ⏳ PH3 | IP allowlist + session timeout via env-ready config; 2FA TOTP = ADM-011. Panel auth gate already active-admin-only. |
| NFR-SEC-013 | Encryption at rest | 🔧 deploy | MinIO SSE-S3 default encryption on bucket create; Postgres volume = host disk encryption (provider-level). |
| NFR-SEC-014 | PDPA: export, delete, retention, admin access log | 🔧 partial | Retention worker exists (`retention` queue); account deactivate/export = admin flow, audit-logged. Verify export output manually per release. |
| NFR-SEC-015 | Mobile: cert pinning, no token logs, FLAG_SECURE | ⏳ PH3 | MOB tasks. |
| NFR-SEC-016 | AI provider key handling | ✅ | `api_key_encrypted` (APP_KEY), write-only Filament field, last4 only, never in responses/logs (snapshots pin this, TC-AI-060/TC-ADM-057/058). |
| NFR-SEC-017 | AI egress SSRF guard | ✅ | `OpenAiCompatibleProvider` — https-only (prod), private-range refuse unless `AI_ALLOW_PRIVATE_HOSTS`, egress allowlist runbook in `infra/README.md`. |
| NFR-SEC-018 | AI data: no logging of content/memories, consent | ✅ | No AI body in structured logs (NFR-OPS-005 convention + scrub list); consent gate FR-AI-013 (`ai_consented_at`); Sentry scrub configured when DSN lands (infra/README.md). |

## Automated weekly checks (security.yml)

1. **Dependency audit** — `composer audit` + `pnpm audit`, fail on ≥ high.
2. **ZAP baseline** — boots the API (Postgres + Redis services, `artisan
   serve`) and runs `zaproxy/action-baseline` with `.zap/rules.tsv`
   thresholds; any FAIL rule fails the job. Report artifact: `zap-baseline`.

   Local ZAP run against dev stack:

   ```
   make up && make migrate
   make dev-api &                                  # :8000
   docker run -t ghcr.io/zaproxy/zaproxy:stable \
     -cmd_options='-baseline -t http://host.docker.internal:8000 \
     -c /zap/rules.tsv' \
     -v "$PWD/.zap/rules.tsv:/zap/rules.tsv"
   ```

   Triage: real finding → fix code or set rule threshold in `.zap/rules.tsv`
   with a comment saying why. Do not silence HIGH rules — fix them.

## Pre-release manual pass (5 min)

1. `curl -sI https://<api-host>` → HSTS present, no `Server`/`X-Powered-By` version leak.
2. DevTools storage on web: only refresh token persisted; access token absent after hard reload until refresh.
3. Login as member → direct `GET /api/v1/workspaces/<other-id>/rooms` → 403/404 envelope.
4. Filament `/admin` → confirm 2FA prompt (PH3+), session idle logout after 30 min.
5. Upload `test.svg` → downloads as attachment, never renders inline.
6. `git log --all --source -p -- '**/api_key*'` → no plaintext keys ever committed.
