# QA-006 — Mobile QA checklist (TASK-MOB-012)

Expo (SDK 57) dev-client app in `apps/mobile`. Two verification layers:

1. **Automated (Jest, `pnpm --filter @banana-chat/mobile test`)** — platform-agnostic
   logic incl. the full chat-core contract suite over **real SQLite**
   (better-sqlite3 driver shaped like expo-sqlite).
2. **Device-manual** — needs a dev-client build (`pnpm --filter @banana-chat/mobile ios`
   / `android`) against a running API + Reverb. Run per release candidate.

## Automated coverage (36 tests, 8 suites)

| Suite | Covers |
| --- | --- |
| `src/db/__tests__/sqlite-cache.test.ts` | TC-MOB-002, TC-MOB-005 (+ chat-core contracts TC-CORE-020..024, TC-CORE-050) |
| `src/db/__tests__/scope-isolation.test.ts` | TC-MOB-003, TC-MOB-004, TC-MOB-008 |
| `src/auth/__tests__/token-store.test.ts` | TC-MOB-040 (token never logged) |
| `src/offline/__tests__/outbox-flusher.test.ts` | TC-MOB-009..014, TC-MOB-026..031 |
| `src/push/__tests__/routing.test.ts` | TC-MOB-031, TC-MOB-033, TC-MOB-034 (channel routing, badge, deep links) |
| `src/push/__tests__/registration.test.ts` | TC-MOB-030, TC-MOB-035 (API-070 lifecycle) |
| `src/update/__tests__/gate.test.ts` | TC-MOB-042 (426 gate logic) |
| `src/media/__tests__/policy.test.ts` | TC-MOB-020..023 (blocked extensions, resize/compress plans) |

## Device-manual checklist

Prereqs: dev-client build installed; API + Reverb reachable (set
`extra.apiBaseUrl` / `extra.reverb*` in `app.json` for the build profile —
device on LAN needs the host machine's LAN IP, not `localhost`).

### Session & cache (TC-MOB-001, 006, 007, 041)

- [ ] Cold start with a stored refresh token: lands straight on the room list
- [ ] Kill the app, relaunch offline: rooms + last 200 messages/room paint from
      SQLite instantly (cache-first), offline banner shows in a room
- [ ] Log in, log out → log in as a DIFFERENT user: previous user's cached
      rooms/messages do NOT flash on screen (logout wiped all cache tables)
- [ ] iOS: refresh token lives in Keychain (SecureStore), not AsyncStorage
- [ ] Background → foreground: badge count matches total unread

### Offline outbox (TC-MOB-009..012)

- [ ] Airplane mode, send a message: row appears with 🕓 pending marker
- [ ] Two messages queued offline, back online: delivered FIFO, original order
- [ ] Server down (stop API): after 3 attempts entry flips to failed with
      retry/delete actions; retry succeeds once API is back
- [ ] Kill the app while a message is queued: relaunch → queue survived (SQLite)

### Attachments (TC-MOB-013, 014, 024..029 — device picker flows)

- [ ] Pick an image offline → queued; back online: upload + send, message
      shows the attachment
- [ ] Queue an attachment, delete the local file (Files app / adb), go online:
      entry fails permanently with "ไฟล์แนบหายจากเครื่อง"
- [ ] `.exe`/`.sh` pick is rejected client-side by extension policy

### Push (TC-MOB-032, 033, 035, 036)

- [ ] Fresh install: prompt appears on first settings toggle; deny → info
      alert with "ตั้งค่า > การแจ้งเตือน" guidance
- [ ] Background push (message + mention): banner shows, tapping deep-links
      `orgchat://room/{ws}/{id}` and switches workspace if needed
- [ ] Open room A, receive push for room A: NO foreground banner (suppressed)
- [ ] Open AI conversation, receive ai_completed: no banner while focused
- [ ] Android: messages/mentions/ai channels visible in system settings
- [ ] Badge number = total unread, clamped at 99 999

### Update gate (TC-MOB-042)

- [ ] Set `min_app_version` above the installed build (admin or env):
      API returns 426 → app lands on the dead-end update screen, no way back
- [ ] Below min version: everything works normally

### AI assistant (TC-MOB-050..056)

- [ ] First AI send: consent modal; decline blocks send, accept stores consent
- [ ] Streaming reply renders progressively; Stop mid-stream cancels cleanly
- [ ] Kill connectivity mid-stream, reconnect: conversation resyncs (no gap)
- [ ] Failed generation: retry button re-sends the last user message
- [ ] ai_completed push while app closed: tapping opens the conversation
- [ ] Conversations + messages survive cold start offline (SQLite cache)
- [ ] Memories screen lists memories; clear-all wipes them

### Search (TASK-MOB-014, FR-SRCH-001/002)

- [ ] 🔍 on the rooms header opens the search screen; typing <2 chars shows the hint
- [ ] Thai query ("ประชุม") finds messages containing that substring
- [ ] Files tab: kind chips filter to images/videos/files; names match Thai + English
- [ ] Tapping a result opens the room seeded around the hit (jumps to that message)
- [ ] "โหลดเพิ่ม" appends the next page without duplicating rows

### Workspace switching (TC-MOB-008)

- [ ] Switch workspace: rooms list changes; switch back: previous rooms render
      from cache instantly (other ws cache rows were never dropped)

## E2E + release (TASK-MOB-012)

- [ ] Maestro smoke suite (`maestro test .maestro/`) once flows stabilize:
      login → room → send → AI ask → logout
- [ ] EAS build (`eas build --profile development`) green for iOS + Android
- [ ] TestFlight / Play internal track install passes the manual checklist
