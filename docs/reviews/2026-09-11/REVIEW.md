# Project verification — 11 September 2026

**Verdict: fix-then-ship. ยังรับรองว่าทำงานครบหรือเชื่อถือได้แบบ Telegram ไม่ได้** โดยเฉพาะการแยกข้อมูลหลัง logout, การรักษาข้อความบนหน้าเว็บ และการรับข้อความสดบน mobile

Scope: PRODUCT_SPEC.md §0, §5, §9, §12 และ Appendix B; backend/API, shared packages, web และ source ของ mobile. Baseline commit `bd52745`. Review นี้ไม่เปลี่ยน behavior ของแอปและไม่ใช่ implementation ของฟีเจอร์ที่ขาด

แนวทางที่เล็กและตรงปัญหาที่สุดคือเชื่อม Outbox/MessageStore/cache ใน `packages/chat-core` เข้ากับ client ให้ครบ แล้วทดสอบผ่านหน้าจอจริง ไม่จำเป็นต้องเขียนระบบแชตใหม่หรือเพิ่มฟีเจอร์ Telegram ทั้งหมดก่อนแก้ความถูกต้องพื้นฐาน

Telegram benchmark ในที่นี้คือส่งข้อความ/ไฟล์และซิงก์หลายอุปกรณ์ได้อย่างน่าเชื่อถือ อ้างอิง [Telegram FAQ](https://telegram.org/faq#q-what-is-telegram-what-do-i-do-here). Calls, Secret Chats/E2EE, public signup, voice messages, reactions/forward/pin-message ไม่ใช่ข้อบังคับของ v1 ตาม non-goals/P2 ของโปรเจกต์

## สิ่งที่รันจริง

| Check | ผล | ขอบเขตที่ยืนยันได้ |
| --- | --- | --- |
| Pest, PostgreSQL `orgchat_test` | **307 passed, 2 skipped**, 1,265 assertions | API/domain scenarios ที่ test เขียนไว้; ไม่รับรอง client wiring |
| pnpm test | **112 passed** | shared 3, api-client 5, chat-core 65, mobile Jest 39 |
| pnpm typecheck ตอนเริ่ม | ผ่านทุก package | snapshot ก่อนมีการแก้ไฟล์ร่วมกัน |
| pnpm build:web ตอนเริ่ม | ผ่าน; bundle-size warning | snapshot ตอนเริ่ม |
| Playwright regression บน dev stack จริง | **18 passed** | admin 5, REST 8, web 5 รวมส่งสอง browser + search + mock AI stream |
| Custom browser probes | 3 ปัญหายืนยันซ้ำ 2 รอบ | private cache, room revisit, failed send; ดู JSON และภาพ |
| Reconnect probe | ผลต่างกัน 2 รอบ | ไม่ผ่านเกณฑ์รับรอง; ต้องควบคุมการส่ง WS ที่อยู่ใน queue และ HMR เพิ่ม |
| Native iOS/Android, real push, real AI, load/soak | ไม่ได้รัน | ต้องมี device/build/provider credentials/isolated load target |

ผลทดสอบผ่านรวม 437 เคสจาก suite เดิม ไม่ใช่จำนวน acceptance criteria ที่ผ่านทั้งหมด. Test ที่ skipped คือ placeholder ของ workspace-header middleware และ AI token drift ซึ่งยังไม่มีค่าจาก provider จริง

มีการแก้ `apps/web/src/echo/EchoProvider.tsx` จากงานอื่นระหว่าง review. การตรวจ TypeScript ระหว่างทางพบ `openRoomId` unused และ `openRoomIdRef` undefined; งานอื่นแก้ต่อแล้ว **web typecheck รอบสุดท้ายผ่าน** (`latest-web-types.log`). ไม่ใช้ baseline build รับรอง working tree ที่เปลี่ยนแล้ว. Reviewer ไม่แก้ทับไฟล์นี้

## Findings เรียงตามผลกระทบ

### 1. [P1 — release blocker] เปลี่ยนบัญชีแล้วยังอ่าน private room ของบัญชีก่อนได้จาก memory cache

FR-WS-003, FR-OFF-001, FR-AUTH-003; TC-WEB-REVIEW-004.

**Repro:** Tony สร้าง room ที่มีสมาชิกคนเดียว → เปิดข้อความ → logout → login เป็น Duangjai ใน SPA เดิม → เปิด URL ห้องเดิม. API ปฏิเสธการอ่าน แต่หน้าเว็บยังแสดงข้อความของ Tony. ทั้งสองรอบได้ `otherAccountApiDenied=true`, `oldPrivateTextVisible=1`; ภาพ `cache-isolation.png` แสดงห้องสมาชิก 1 คนและข้อความที่เป็นของผู้ใช้อื่น

**Trace:** `apps/web/src/state/session.ts:67` ล้าง token และ IndexedDB เท่านั้น; `apps/web/src/App.tsx:15` สร้าง QueryClient อายุทั้งแอป; `apps/web/src/hooks/useMessages.ts:23` ใช้ key ที่ไม่มี user/workspace, `staleTime: Infinity`; `apps/web/src/lib/room-stores.ts:11` มี global Map keyed ด้วย roomId. Logout ไม่ clear QueryClient/MessageStore. API isolation ที่ผ่านไม่ป้องกัน client cache นี้

**แก้ขั้นต่ำ:** แยก query/store ด้วย user+workspace, cancel queries และ clear state/query/drafts/AI memory state ตอน logout, await persistent-cache cleanup ก่อนให้ session ใหม่ใช้งาน. เพิ่ม browser test เปลี่ยนบัญชีโดยไม่ reload และตรวจทั้ง DOM กับ denied API

### 2. [P1] ส่งสำเร็จแล้วออกจากห้องและกลับเข้าใหม่ ข้อความหายจากหน้าจอ

FR-MSG-009, FR-OFF-001; TC-WEB-REVIEW-001.

**Repro:** ส่งข้อความ รอ REST ตอบและ bubble เลิกแสดง sending → ไป search → กลับห้อง. Server ยังมีข้อความ แต่ bubble มีจำนวน 0 ทั้งสองรอบ. Reload แล้วกลับมาเห็น

**Trace:** `apps/web/src/components/Composer.tsx:87` confirm ลง MessageStore; query snapshot ไม่ได้อัปเดต. `apps/web/src/hooks/useMessages.ts:38` กลับห้องแล้ว `replace(query.data.messages)` ด้วย snapshot เก่า และไม่มี refetch เพราะ `staleTime: Infinity`

**แก้ขั้นต่ำ:** ให้ canonical message cache เป็นแหล่งเดียว; reconcile REST/WS ไปที่เดียวกัน และ sync หลังกลับเข้าห้อง. ห้ามนำ snapshot เก่าทับข้อมูลที่ใหม่กว่า

### 3. [P1] ส่งล้มเหลวค้าง sending และไม่มี persistent outbox

FR-MSG-001, FR-OFF-002; TC-WEB-REVIEW-003.

**Repro:** abort เฉพาะ POST messages ด้วย `internetdisconnected`. หน้าเว็บคืนข้อความลง composer แต่ bubble ยังแสดง sending; server ไม่มีข้อความและ IndexedDB `loadOutbox()` คืน null ทั้งสองรอบ

**Trace:** `apps/web/src/components/Composer.tsx:77` สร้าง UUID+seq สมมติแล้ว clear attachments; catch ที่บรรทัด 94 เพียง setBody. หน้าเว็บไม่ใช้ Outbox จาก chat-core. กดส่งซ้ำสร้าง UUID ใหม่ จึงเสี่ยงซ้ำเมื่อ request เดิมสำเร็จแต่ response หาย; ไฟล์แนบที่ clear ไปไม่ถูกคืน

**แก้ขั้นต่ำ:** ใช้ Outbox ที่มีอยู่, pending ไม่มี authoritative seq, persist body+attachments+UUID, retry ด้วย UUID เดิม และแสดง failed/retry/remove ให้ตรงสถานะจริง

### 4. [P1] Mobile room ไม่มีเส้นทางรับข้อความใหม่ผ่าน WebSocket

FR-RT-001/002, FR-MSG-009; TASK-MOB-003/005. **ยืนยันจาก source trace; ไม่ได้รัน native device**

`apps/mobile/app/room/[id].tsx:53` โหลด cache/history ครั้งเดียวและอัปเดต store ผ่าน outbox.onDelivered เท่านั้น. `apps/mobile/src/realtime/echo.ts:77` subscribe user events สำหรับ AI/session และ workspace; ไม่มี private-room listener สำหรับ message.created/updated/deleted. `apps/mobile/app/_layout.tsx` callback ของ room changes โหลด workspace summaries. ข้อความที่อีกคนส่งจึงไม่มีทางเข้า store ของหน้าห้องที่เปิดอยู่

**แก้ขั้นต่ำ:** wire room subscription, cleanup, catch-up/gap-fill และ foreground/network restore ผ่าน shared client logic; เพิ่ม two-device test ส่ง/แก้/ลบขณะที่อีกเครื่องค้างในห้อง

### 5. [P1] เว็บไม่รองรับ upload ticket แบบ multipart ที่ backend ออกให้ไฟล์ใหญ่

FR-MEDIA-001, TASK-BE-024. **ยืนยันจาก contract trace; ไม่ได้ส่งไฟล์ใหญ่จริง**

`apps/api/app/Domain/Media/UploadService.php:89` เมื่อ S3 และเกิน threshold (default 50MB) คืน `put_url=null` พร้อม multipart URLs. `apps/web/src/hooks/useUploader.ts:89` ใช้ `fetch(ticket.put_url)` เสมอ; `packages/api-client/src/endpoints.ts:188` completeUpload ไม่รับ parts/ETags. ดังนั้นไฟล์ 60MB ที่ยังไม่เกิน upload limit ไม่สามารถจบ flow นี้ได้. Mobile upload sender ก็ใช้ single PUT

**แก้ขั้นต่ำ:** เพิ่ม multipart contract ใน shared/api-client และ upload parts/เก็บ ETags/complete/abort; ทดสอบ single PUT และ multipart กับ S3-compatible storage จริง

### 6. [P2] เลื่อนอ่านประวัติแล้ว UI ดึงกลับท้ายห้อง และ search jump ไม่คงตำแหน่ง

FR-MSG-003, FR-SRCH-001, TC-CORE-023. **ยืนยันจาก source trace**

`apps/web/src/components/ChatView.tsx:136` scrollIntoView ท้ายห้องทุกครั้งที่จำนวน messages เปลี่ยน จึงรวม loadOlder ที่ prepend ข้อความด้วย. โค้ดไม่ใช้ prependCount/ตำแหน่ง viewport. Search jump ที่บรรทัด 149 ลบ around_seq ทันที ซึ่งสลับ query กลับ latest และเปิด bottom-scroll effect

**แก้ขั้นต่ำ:** anchor viewport เมื่อ prepend, auto-scroll เฉพาะอยู่ใกล้ท้าย/ผู้ใช้ส่งเอง, เก็บบริบท search window จนผู้ใช้กดกลับล่าสุด

### 7. [P2] ระบบ mark-read อาศัยหน้า visible แทนการเห็นข้อความจริง

FR-READ-001. **ยืนยันจาก source trace**

`apps/web/src/components/ChatView.tsx:80` markRead เมื่อเอกสาร visible แม้ผู้ใช้กำลังอ่านประวัติเก่า. Effect บรรทัด 127 mark tail เมื่อโหลดสำเร็จโดยไม่วัด viewport และไม่มี throttle 1 วินาทีตามสเปก. จึงขึ้นอ่านแล้วก่อนอ่านข้อความและสร้าง POST/refetch ตามจำนวนข้อความที่เข้า

**แก้ขั้นต่ำ:** ใช้ visibility/focus+intersection ของ latest message และ throttle; ทดสอบ tab background/เลื่อนขึ้น/อ่านข้อความใหม่

### 8. [P2] Workspace badge ใช้ state ที่ไม่ได้รับผลจาก query invalidation

FR-WS-001/002, FR-READ-003. **ยืนยันจาก source trace**

`apps/web/src/components/WorkspaceSwitcher.tsx:4` อ่าน workspaces จาก Zustand. `apps/web/src/state/session.ts:32` โหลดรายการครั้ง bootstrap/login; handler WS invalidate `['workspaces']` แต่ไม่มี useQuery ของ key นี้หรือการ set workspaces จากผล refetch. จึงไม่ทำให้ badge ใน switcher ตรงกับการอ่าน/ข้อความใหม่

**แก้ขั้นต่ำ:** ให้ switcher consume query ที่มีจริงหรือ patch/refetch session.workspaces จาก event; ทดสอบ unread ต่าง workspace และอ่านจากอุปกรณ์ที่สอง

## Reconnect: ยังต้องพิสูจน์เพิ่ม

FR-RT-002 / TC-WEB-REVIEW-002: รอบแรก socket connected และ server มีข้อความ แต่ DOM ไม่มี; รอบสอง DOM มี. ทั้งสองรอบไม่มีข้อพิสูจน์ว่าบริการ queue ส่ง event เสร็จก่อน reconnect และมี HMR จากงานอื่นระหว่างตรวจ. **ไม่นับเป็น stable runtime failure หรือ pass**

Source `apps/web/src/echo/EchoProvider.tsx:81` เปลี่ยนแค่ connected flag; ไม่มี catch-up API call. `useMessages` ดึง gap เมื่อมี event ใหม่ที่ seq กระโดด ซึ่งไม่ครอบกรณีไม่มี event ตามมา. ควรใช้ control subscriber ยืนยัน event ถูก broadcast แล้วขณะ client หลุด จากนั้น reconnect และ assert GET after_seq/edited/deleted reconciliation

## Feature coverage matrix

คำว่า “suite ผ่าน” หมายถึง existing tests ผ่านเฉพาะ scenarios ที่เขียนไว้; ไม่ใช่รับรองทุก AC. แถวรวม IDs ครอบคลุม functional modules ใน §5; native/UI ที่ยังไม่ทดสอบระบุแยก

| Requirements | สถานะและหลักฐาน |
| --- | --- |
| FR-AUTH-001..007 | API auth/login/refresh/reuse/revoke/password/lockout tests ผ่าน; browser login ผ่าน; logout client privacy fail (#1); web ไม่มีหน้ารายการ sessions |
| FR-WS-001..003,005 | WorkspaceTest ผ่าน; directory/group picker มี; switching/cache/badge ยังมี #1/#8; ถอดสมาชิกขณะเปิดแอปยังไม่ certify |
| FR-WS-004 | routes/api.php มี workspace show/members/sync แต่ไม่มี WA mutation routes ตาม API-012..015; ไม่ครบ |
| FR-ROOM-001..003 | API DM/group/list tests ผ่าน; web create dialog มี; owner-only create/send ใช้จริงใน probe; client rooms() ไม่มี cursor จึงโหลดเพียงหน้าแรก 50 ห้อง |
| FR-ROOM-004..008,011 | backend membership/roles/leave/update/delete tests ผ่าน; web ChatView มี title/count/media แต่ไม่มี room-management UI; feature ยังไม่ครบ end-to-end |
| FR-ROOM-009..010 | ไม่มี hide/unhide/pin/unpin routes/UI แม้มีคอลัมน์/filter; ไม่ครบ |
| FR-PROF-001 | MeController update มี แต่ web ไม่มี profile/settings route; avatar ownership/processing และ broadcast update ยังไม่ผ่าน end-to-end verification |
| FR-PROF-002 | P2; ไม่นับเป็น release defect ของ v1 |
| FR-MSG-001 | API text/idempotency ผ่าน, live web send ผ่าน; failed-send path fail (#3); room message body ยังเป็น plain text ไม่ใช้ markdown-lite |
| FR-MSG-002 | backend attachment tests ผ่าน; web picker/render มี; mobile room render แค่ body ไม่มี picker/attachment rendering; multipart #5 |
| FR-MSG-003 | API history ordering/pagination ผ่าน; web scroll behavior #6; mobile room ไม่มี load-older callback |
| FR-MSG-004 | API reply field มี; web Composer ส่ง reply id เป็น undefined และ MessageItem ไม่ render reply quote; mobile ไม่มี reply UI |
| FR-MSG-005..006 | EditDeleteTest ผ่าน; web edit/delete actions มี แต่ต้องพึ่ง WS event อัปเดต store; live edit/delete UX ไม่ได้ตรวจเพิ่ม; mobile ไม่มี actions |
| FR-MSG-007..008 | MentionTest/system-message tests ผ่าน; web @autocomplete มี; system text hardcode และ actor/event mapping ยังไม่ได้ตรวจทุกชนิด; mobile ไม่ render system templates |
| FR-MSG-009 | shared ordering/gap tests ผ่าน แต่ web revisit fail, reconnect unresolved, mobile subscription ขาด |
| FR-MSG-010 | P2 forward/pin message/reactions/link preview; ไม่รับรอง parity Telegram |
| FR-MEDIA-001 | UploadTest/MultipartUploadTest ผ่านฝั่ง backend; client multipart ไม่ครบ (#5) |
| FR-MEDIA-002..003 | image/video processing suite ผ่าน; ไม่ได้ทดสอบ corpus HEIC/GIF/codec และ native compression จริง |
| FR-MEDIA-004 | backend media URL tests ผ่าน; web AttachmentView ไม่มี onError/refetch สำหรับ URL หมดอายุ; processing attachment ใน bubble ไม่มี ready-event handler; ยังไม่ certify |
| FR-MEDIA-005..006 | backend purge/scan scenarios มี tests; ไม่ได้รันจริงกับ worker failure/retention clock/production ClamAV |
| FR-READ-001..003 | server/core tests ผ่าน; DM Seen มี; viewport marking #7, workspace badge #8, group readers UI ไม่มี |
| FR-RT-001 | live two-browser text ผ่าน; private-channel authorization tests ผ่าน; mobile room subscribe ขาด (#4) |
| FR-RT-002 | reconnect ยังไม่ certify; stale cache และ authoritative catch-up ต้องแก้ |
| FR-RT-003..004 | web/mobile ไม่พบ room typing whisper/listeners หรือ presence subscription/render; ไม่ครบ |
| FR-NOTI-001..002 | API token/settings/decision service suite ผ่าน; FCM delivery จริงยังไม่ได้ทดสอบ |
| FR-NOTI-003 | เว็บไม่มี FCM registration/service worker/permission flow; มี notification center ไม่เท่ากับ web push |
| FR-NOTI-004 | mobile routing/registration logic tests ผ่าน; background/killed-device push ยังไม่ได้ทดสอบ |
| FR-NOTI-005 | API tests ผ่าน; mobile notification settings screen มี; web ไม่มี settings UI |
| FR-NOTI-006 | NotificationCenterTest และ browser เปิด panel ผ่าน; ไม่ได้ตรวจ lifecycle ทุก notification type |
| FR-SRCH-001..002 | SearchTest ผ่าน; web text search live ผ่าน; search-to-message navigation #6; file search native ยังไม่ได้ใช้จริง |
| FR-SRCH-003 | directory query/picker มี; room list ไม่มี search/filter input; pagination directory ไม่ครบใน client |
| FR-ADM-001..006 | AdminPanelTest/Auth/TwoFactor tests ผ่าน; admin browser login ผ่าน; CRUD/suspend/reset ต้องถือเป็น API/Filament tests ไม่ใช่คลิกครบทุก flow |
| FR-ADM-007 | ไม่มี Room/Message Filament Resource ใน inventory; moderation console/export/history ไม่ครบ |
| FR-ADM-008..009 | audit/settings page smoke และ suite ผ่าน; export/all settings ไม่ได้ตรวจครบด้วย browser |
| FR-ADM-010..012 | ไม่พบ dedicated storage/room restore/user device management UI; ไม่รับรองครบ |
| FR-ADM-013 | health live ผ่าน; dashboard links/source มี; failed-job recovery/queue outage ยังไม่ได้ทดสอบ |
| FR-OFF-001 | Memory/Dexie/SQLite contract tests ผ่าน; web cross-account memory cache fail (#1); native offline cold start ยังไม่ได้รัน |
| FR-OFF-002 | Outbox unit tests ผ่าน; web ไม่ใช้ (#3); mobile มี sender แต่ network restore/kill-relaunch ยังไม่ได้รันบน device |
| FR-OFF-003 | mobile upload helper มี; room screen ยังไม่มี picker/progress/cancel flow; ไม่ครบ |
| FR-I18N-001 | shared translations/mobile tr() มี; web hardcode Thai/English ไม่ใช้ shared i18n และ timezone profile ไม่ได้ wire; ไม่ครบ |
| FR-AI-001..004 | backend AI tests และ live mock stream ผ่าน; stop/cancel tested backend, browser cancellation ไม่ได้รันเพิ่ม |
| FR-AI-005..007 | compaction/context/memory/consent suite ผ่านกับ fixtures/mock; real provider accuracy/token drift ยังไม่ certify |
| FR-AI-008..010 | title/regenerate/edit/quota tests ผ่าน backend; full UI concurrency/retry ยังไม่ได้ตรวจ |
| FR-AI-011..014 | provider/config/test/usage/admin tests ผ่าน; admin pages live ผ่าน; real provider credentials/connectivity ไม่ได้ใช้ |
| FR-AI-015 | share API/UI มีและ AiExtras tests ผ่าน; ไม่ได้ส่ง AI ข้ามห้องด้วย browser |
| FR-AI-016 | P2 vision/file attachment; ไม่รับรอง |
| FR-AI-017..020 | core stream/markdown และ AI extras tests ผ่าน; multi-device interruption/native reconnect/real provider และ AI search UI ไม่ได้ certify |
| FR-SETUP-001..006 | SetupWizardTest ผ่าน; fresh install บน clean deployment ไม่ได้รันเพื่อไม่แตะ dev installation ปัจจุบัน |
| NFR-PERF/SEC/OPS, TASK-QA | ไม่ได้รัน 500 concurrent, 100k-message pagination p95, soak, backup restore, accessibility, pen-test หรือทุก OS/browser |

## Evidence และงานที่ควรทำต่อ

- `api-tests.log`, `unit-tests.log`, `e2e-tests.log`, `baseline-types.log`, `baseline-build.log`, `latest-web-types.log`
- `reproduce.mjs`: runnable browser probes ใช้ demo accounts และ owner-only room; จะเจอ login rate limit หากรันถี่. ผลเป็น observation ledger ไม่ใช่ acceptance test ที่ควรเขียว
- `reproduction-results.json`, `cache-isolation.png`: หลักฐานรอบที่สอง
- รอบแรก cleanup login ติด rate limit: soft-delete ห้องทดสอบชื่อ `Review isolated 1789060923896` ผ่าน local DB แบบระบุ id/name ตรงตัว; ห้องรอบสองลบผ่าน API สำเร็จ. ไม่มี hard-delete ข้อมูลเดิม
- Regression suite เดิมสร้างข้อความ `pw-*` และ AI conversation ตาม script ของ repo; ไม่ใช่ load test
- การ login ด้วย demo account Tony หลายครั้งชน username/IP rate limiter ตามสเปก จึงอาจถูก 429 ชั่วคราวจน window หมด; ไม่ได้ flush rate limiter กลางหรือเปลี่ยนรหัสผ่าน

ลำดับแก้ที่เสนอ: (1) session/cache isolation (2) canonical message store + persistent outbox (3) realtime/catch-up บน web/mobile (4) room-management/media/push UI ที่ยังขาด (5) device tests และ load tests. เก็บ shared logic ใน packages/chat-core ตามกติกา repo และเพิ่ม TC regression ที่ทดสอบผ่าน app integration จริงทุกข้อก่อนประกาศ feature complete
