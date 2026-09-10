# Review: DM creation and background-room unread

Commit reviewed: `537fed43d4cd4594a9a7fff0592e67506eeeebc0` (11 September 2026).

**สอง bug ที่แจ้งผ่านการทดสอบบน local dev stack แล้ว.** ยังมีปัญหาเดิมของ workspace badge ซึ่งไม่ได้ถูกแก้ใน commit นี้; แยกจาก unread badge ของห้องที่แก้สำเร็จ

## Intent และแนวทาง

เป้าหมายคือให้ผู้รับเห็น DM ใหม่และ preview/unread ของห้องที่ไม่ได้เปิด โดยไม่ reload และไม่บังคับเปลี่ยนห้องที่ผู้รับกำลังอ่าน

แนวทางของ patch เล็กและตรงจุด: ใช้ event ที่ backend ส่งอยู่แล้วเพื่อ refetch room list ที่เป็น authoritative แทนเพิ่ม polling หรือสร้าง state ของ unread ซ้ำอีกชุด. Leading/trailing throttle 2 วินาทีใช้ร่วมกันระหว่าง room.activity และ workspace.unread_changed; cleanup ยกเลิก timer และ listener ครบ

## Trace ที่ตรวจ

- FR-ROOM-001 / EVT-001: NewRoomDialog → createDm → CreateRoomAction → RoomCreated บน private-user ของสมาชิกทั้งสอง → EchoProvider.tsx:159 → invalidate rooms → useRooms → RoomList แสดง DM ใหม่
- FR-ROOM-003 / FR-READ-003 / EVT-015/024: Composer → MessageWriter::write → fanOut → RoomActivity และ WorkspaceUnreadChanged บน private-user → EchoProvider.tsx:168/181 → shared throttle → invalidate rooms → preview/unread จาก REST
- ห้องที่เปิดอยู่ยังรับ message.created ผ่าน ChatView; room.activity ข้าม refresh สำหรับ openRoomId แต่ workspace.unread_changed ยัง refresh ผ่าน throttle จึงไม่ตัดข้อมูล unread ทั้งหมดทิ้ง
- การ unsubscribe และ clearTimeout ตอน cleanup ตรวจจาก diff แล้ว; build ไม่พบ TypeScript errors

## ทดสอบจริง

Chromium 2 browser contexts, React/Vite :5173 → API :8000 → PostgreSQL/Redis/queue → Reverb :8088. บัญชีและ workspace ใหม่ทุกครั้ง ไม่มี DM เดิม. Receiver เปิด Waiting room ค้างไว้และไม่มีการ reload ระหว่างสองกรณีหลัก. Sender สร้าง DM และส่งข้อความผ่าน UI จริง. ไม่ mock response หรือ broadcast event

Local DB ไม่มี `tony2` จึงใช้ isolated Review sender/Review receiver ที่มี role และ flow เทียบเท่ากัน ไม่เปลี่ยนรหัสหรือประวัติของ Tony. ผลนี้ไม่ใช่การทดสอบ deployment production หรือบัญชี Tony2 ที่อาจอยู่คนละ environment

| Scenario | ผล |
| --- | --- |
| TC-ROOM-006: DM ไม่เคยมี → sender กดสร้าง | **ผ่าน** REST 201; receiver มี room row เอง; ยังอยู่ Waiting room; reload=0 |
| TC-READ-011: ส่งข้อความแรกขณะ receiver เปิดอีกห้อง | **ผ่าน** preview ใหม่และ unread=1; reload=0 |
| TC-READ-011: ส่งเพิ่ม 5 ข้อความต่อเนื่อง | **ผ่าน** unread=6; preview เป็นข้อความสุดท้าย; GET room list เพียง 2 ครั้งในช่วงส่งและรอ settle |
| TC-READ-001: เปิด DM เพื่ออ่าน | **ผ่าน** badge หายและ API unread=0 |
| TC-RT-001: ส่งขณะ receiver เปิด DM | **ผ่าน** รับข้อความสดหนึ่ง bubble; badge คง 0 |
| TC-MSG-009: ออกไปอีกห้อง → ส่งเพิ่ม → เปิด DM กลับ | **ผ่านใน scenario นี้** preview/unread อัปเดตและข้อความใหม่ปรากฏตอนเปิดกลับ; ไม่ได้ลบล้าง cache findings จาก review ก่อนหน้าที่ใช้ navigation คนละรูปแบบ |
| TC-RT-001: browser runtime errors | **ผ่าน** ไม่พบ pageerror |
| FR-READ-003: workspace switcher badge | **ไม่ผ่าน — pre-existing** API unread_rooms_count=1 แต่ switcher ไม่แสดงจำนวน |

Positive scenarios รันสองรอบ: สอง bug หลักผ่านทั้งสองรอบ. รอบแรกตรวจ total_unread พบ 0; รอบสองปรับ assertion ให้ตรงสเปก workspace badge ซึ่งนับจำนวนห้อง unread (คาดหวัง 1) และยืนยัน UI ไม่แสดงตัวเลข

Backend targeted tests: **54 passed, 191 assertions**, ครอบคลุม RoomTest, MessageTest, RealtimeTest. `pnpm build:web` ผ่าน TypeScript และ production build; มี bundle-size warning เดิม

## Finding ที่ยังค้าง

**[P2] Workspace unread ยังไม่อัปเดต แม้ room unread ทำงานแล้ว — FR-WS-002 / FR-READ-003.**

Evidence: receiver มี 6 unread messages ใน 1 DM; room row แสดง 6 ถูกต้อง, GET /me/workspaces คืน unread_rooms_count=1 และ total_unread=0; option ที่เลือกแสดงเพียง “DM verification”

Trace:

1. `apps/web/src/echo/EchoProvider.tsx:106` invalidate key `['workspaces']` แต่เว็บไม่มี useQuery สำหรับ key นี้
2. `apps/web/src/components/WorkspaceSwitcher.tsx:4` อ่าน Zustand session.workspaces ที่โหลดตอน login/bootstrap ไม่ได้รับค่าจาก query invalidation
3. `apps/web/src/components/WorkspaceSwitcher.tsx:16` ใช้ total_unread ขณะที่ `apps/api/app/Domain/Workspace/WorkspaceSummaryBuilder.php:56` hardcode ค่านี้เป็น 0; สเปก workspace badge ต้องใช้ unread_rooms_count

Suggested change: ให้ workspace list มี query/state ที่ update จาก event จริงและให้ switcher อ่านแหล่งนั้น; render unread_rooms_count ตามสเปก. การ invalidate query ที่ไม่มี observer/queryFn ไม่อัปเดต session store. เพิ่ม test ข้าม workspace และอ่านจากอีกอุปกรณ์

Finding นี้มีอยู่ก่อน commit และไม่ทำให้สอง room-list fixes ที่ทดสอบผ่านกลายเป็น fail แต่ห้ามอ้างว่า workspace/app badge ถูกแก้ครบแล้ว

## Reproduction และหลักฐาน

Run จาก root:

```sh
node docs/reviews/2026-09-11/dm-fix/verify.mjs
DM_REVIEW_NEGATIVE=1 node docs/reviews/2026-09-11/dm-fix/verify.mjs
```

Normal mode จงใจ exit 1 เมื่อ workspace-badge assertion ยัง fail. Negative mode ปิดเฉพาะ user-channel listeners 3 ตัวที่ patch เพิ่มใน browser หลัง subscribe สำเร็จ เพื่อทดสอบเหตุและผล; ไม่แก้ application source และไม่เปลี่ยน backend. สำหรับ control ของ bug ข้อ 2 โหลด DM ที่มีแล้วก่อนปิด listeners และส่งข้อความ จึงไม่พึ่ง failure ของข้อ 1. Control ที่ดีต้องไม่อัปเดต UI ขณะที่ backend ส่ง event ตามปกติ

**ผล negative control ล่าสุด:** new-DM row ไม่ปรากฏภายใน 10 วินาที; หลังโหลด DM เดิมเข้ารายการแล้ว ปิด listeners และส่งข้อความ พบว่า row ยังมีแต่ชื่อผู้ส่ง ไม่มี preview ใหม่ภายใน 10 วินาที. ทั้งสอง assertions fail ตามคาด ยืนยันความต่างจาก normal mode. Fixture cleanup สำเร็จ

Artifacts: `results.json`, `negative-results.json`, PNG แต่ละ scenario, `live.log`, `negative.log`, `api-tests.log`, `build.log`. Scripts สร้างและลบเฉพาะ fixture ของ run นั้นผ่าน workspace/user IDs และ prefix เฉพาะ. ไม่ flush rate limiter กลาง

Verdict: **ship สำหรับสอง bug ของ room list ที่แจ้ง**; เปิด follow-up workspace badge แยก. ไม่ใช่การรับรอง all-feature readiness, mobile, browser tab ที่ถูก OS suspend หรือ production deployment
