# PLAN_ASTRA — ปรับ UI/UX ห้องแชท Banana Chat

วันที่: 19 กันยายน 2026 · บทบาท: Product Owner ร่วมกับ UX/UI, Tech Lead และ QA

สถานะ: **แผนพร้อมนำไปทำ prototype และแตกงานพัฒนา — ยังไม่ได้ implement หรือ deploy**

## 1. ข้อเสนอของ PO

ปรับห้องแชทให้ **ค้นหาห้องง่าย อ่านบทสนทนาต่อเนื่อง และมีเครื่องมือเท่าที่จำเป็นในแต่ละจังหวะ** ใช้ความคุ้นเคยจาก Telegram/LINE เป็นแนวทาง โดยรักษาเอกลักษณ์ Banana Chat ด้วยพื้นกลางที่สะอาดและสีเหลืองอ่อนสำหรับข้อความของเรา

สามผลลัพธ์หลัก:

1. **Chat list:** ชื่อห้อง ข้อความล่าสุด เวลา และ unread อ่านเป็นลำดับเดียวกันทุกแถว
2. **Message bubble:** เนื้อหาเด่นกว่าเครื่องมือ ระยะห่างสม่ำเสมอ ผู้ส่งและสถานะเข้าใจง่าย
3. **Message list UX:** อ่านย้อนหลังได้โดยตำแหน่งไม่กระโดด รู้ว่ามีข้อความใหม่ และกลับมาล่าสุดได้ในหนึ่งครั้ง

การเปลี่ยนสีอย่างเดียวไม่พอ: ปัญหาหลักที่พบคือการจัดลำดับข้อมูลและพื้นที่ที่เครื่องมือใช้ โดยเฉพาะมือถือ ควรปรับองค์ประกอบเดิมและพฤติกรรมการอ่าน ไม่ต้องเปลี่ยน framework หรือเขียนระบบแชทใหม่

**ขนาดงาน:** LARGE สำหรับการส่งมอบครบสามส่วน; **ความเสี่ยง:** MEDIUM เพราะกระทบ scrolling, unread/read receipts, focus และ shared CSS แม้เป้าหมายเป็น UI

## 2. ขอบเขตและสมมติฐาน

| ช่วง | ขอบเขต |
| --- | --- |
| P0 — ส่งมอบรอบแรก | Web ห้องภายใน workspace: DM/group/secret room ทั้ง desktop และ responsive mobile; ปรับสามเป้าหมายข้างต้นพร้อม accessibility และ error states |
| P0 — งานประกอบที่จำเป็น | ลดความซ้ำซ้อนของ sidebar/header รอบห้องแชท; ปรับพื้นที่ composer เฉพาะ geometry, keyboard และ reply/edit state ที่เกี่ยวกับ timeline |
| P1 — งานต่อที่ระบุไว้ | Native Expo parity, first-unread landing, เพิ่มข้อมูล preview ที่ API ยังไม่มี, group read details และ performance optimization ตามผลวัด |
| ไม่รวมในรอบนี้ | รีแบรนด์ทั้งแอป, AI conversation redesign, Kanban, public support queue/visitor redesign, calls/media viewer redesign, folders/archive แบบใหม่, stickers/reactions ใหม่, dark theme หรือ theme customization ใหม่ |

คำว่า “มือถือ” ใน P0 หมายถึง **mobile web**; แอป Expo เป็นงาน P1 แยก มีเกณฑ์ทดสอบบนเครื่องจริง ไม่ถือว่าการแก้ CSS ทำให้ native เปลี่ยนแล้ว

Public chat และ AI อาจใช้ CSS/renderer ร่วมกัน: ต้อง regression test และไม่ทำให้พฤติกรรมเดิมเปลี่ยนโดยไม่ได้ตั้งใจ แต่ไม่ขยายเป็นการออกแบบทุกหน้าพร้อมกัน

คง API ordering, authorization, permissions, seq/idempotency, expiry และการเปิดอ่านตามข้อกำหนดเดิม หากต้องเปลี่ยนพฤติกรรมที่ PRODUCT_SPEC ระบุ ให้จัดทำ proposed DEC/FR และอัปเดต §15/§16 ในงาน implementation ก่อนเปลี่ยนจริง เอกสารนี้ยังไม่ถือว่าแก้ source of truth แล้ว

## 3. หลักฐานของ UI ปัจจุบัน

### 3.1 วิธีตรวจและขอบเขตความเชื่อมั่น

- อ่าน `AGENTS.md`, `CLAUDE.md`, workflow กลาง, PRODUCT_SPEC ส่วน ROOM/MSG/READ/OFF/SRCH และโค้ด component, shared logic, CSS, API types และ E2E ที่เกี่ยวข้อง
- เปิด **existing local dist build ลงวันที่ 18 กันยายน** ด้วย Playwright Chromium ที่ 1440×900 และ 390×844 โดยใช้ห้อง/ข้อความไทยจำลอง ไม่มีข้อมูลลูกค้าจริง
- API ถูก intercept ทั้งหมดและปิด external requests/WebSockets; Reverb key ที่หายถูกแทนเฉพาะ response ของ JS ใน test harness ด้วยค่า fixture เพื่อให้ render ได้ ไม่แก้ source/build บนดิสก์
- มี reconnect banner เพราะไม่ได้ต่อ Reverb จริง; ไม่ใช้ภาพนี้ตัดสินว่า production เชื่อมต่อเสีย และไม่ใช้ข้อความ disclosure ของ build เก่าเป็นข้อกำหนดใหม่
- ภาพชั่วคราว: `/tmp/banana-current-desktop.png`, `/tmp/banana-current-mobile.png`; harness: `/tmp/banana-plan-inspect.cjs` — เป็นหลักฐานประกอบใน session นี้ ไม่ใช่ visual baseline ถาวรหรือภาพ production ปัจจุบัน
- ผู้ตรวจอิสระ Codex ตรวจ source ของทั้งสามเป้าหมายซ้ำ; Claude/OpenCode ไม่ได้ถูกใช้ในงานนี้ เพราะยังไม่ได้ยืนยัน preferred runtime/model configurations

### 3.2 สิ่งที่ควรปรับและสิ่งที่ต้องรักษา

| หลักฐานปัจจุบัน | ผลต่อผู้ใช้ / ข้อเสนอ |
| --- | --- |
| `AppShell.tsx:146` มี workspace, Messages/caption, search, AI card; `RoomList.tsx:59` เพิ่มปุ่มสร้างห้องและ section label | ภาพจำลองยืนยันว่าต้องผ่านหลายชั้นก่อนเห็นแชทแรก → รวม header และ action สร้างห้อง ลดข้อความตกแต่ง; AI ยังเข้าถึงจาก navigation ได้ |
| `RoomList.tsx:25` แสดงชื่อและ preview body แต่ไม่มีเวลา/muted; null fallback เป็น `…`; backend `RoomController.php:661` มี image/video/file preview แล้ว | เพิ่ม two-line row, timestamp, unread/muted และปรับ preview formatting/fallback ให้สม่ำเสมอ โดย reuse semantic labels ที่ server มี ไม่อ้างว่าไฟล์ทุกข้อความปัจจุบันแสดง `…` |
| `index.css:109` title/preview ใช้ 12px/10px; `index.css:212` message text 13px | ตัวอักษรรองเล็กและภาพรวมสีใกล้กัน → เพิ่ม typography hierarchy/contrast โดยไม่เพิ่ม padding เกินจำเป็น |
| `MessageItem.tsx:288` และ `index.css:284` ทำ touch actions แสดงทุกข้อความ | ภาพมือถือมีหลายปุ่มใต้แต่ละ bubble → single more action + action sheet; long press เป็นทางลัด ไม่ใช่ทางเข้าเดียว |
| `buttons.css:14` ใช้ global `#root` selector คุม geometry; ซ้อนกับ `index.css:120,210,279`; media rules ใน buttons.css ใช้ touch target 44px และ mobile header min-height 104px | ภาพมือถือยืนยัน header หลายแถวและ action boxes ใหญ่; ไม่ประเมิน computed size จาก declaration เดียว; แก้ด้วย scoped chat rules และตรวจ specificity ไม่เพิ่ม override ทับไปเรื่อย ๆ |
| `ChatView.tsx:328` แสดง Seen ใน header | สถานะไม่ติดกับข้อความที่เกี่ยวข้อง → ย้ายลงใต้ข้อความล่าสุดของเรา ตาม FR-READ-002 |
| `message-layout.ts:3`, `ChatView.tsx:376`, `index.css:225` มี same-sender grouping แล้ว | ปรับ geometry ของ group เดิม ไม่สร้าง grouping ซ้ำ; เก็บเงื่อนไขผู้ส่ง/ห้อง/เวลา/system/deleted |
| `ChatView.tsx:187` มี prepend anchor และ follow เฉพาะใกล้ bottom; `:199` gate read ตาม focus/visibility | เป็นของเดิมที่ต้องรักษาและเพิ่ม regression สำหรับ delayed media/resize ไม่ใช่เสนอว่าเริ่มจากศูนย์ |
| `ChatView.tsx:349` มี Back to latest เฉพาะ search/reply anchor; ไม่มี ordinary-history new-message affordance | เพิ่ม jump-to-latest/new arrivals เมื่อเลื่อนอ่านด้านบน โดยไม่ auto-jump |
| Web map ทุกข้อความ (`ChatView.tsx:363`); native มี FlashList แล้ว (`apps/mobile/app/room/[id].tsx:268`) | เริ่มจากปรับ paginator/anchor และ benchmark; ไม่ย้ายทั้งสอง platform ไป library ใหม่โดยไม่มีหลักฐาน |

Paths ที่ไม่ระบุ prefix ในตารางอยู่ใต้ `apps/web/src/components`, `apps/web/src` หรือ `packages/chat-core/src` ตามชื่อไฟล์ ข้อสรุปเรื่อง “สวย/รก” เป็น design diagnosis จาก source และภาพจำลอง ยังต้องทดสอบความชอบกับลูกค้า

### 3.3 ตรวจ UI จริงบน deployment ที่ผู้ใช้ระบุเพิ่มเติม

**Target ที่ถูกต้องสำหรับการตรวจครั้งนี้: `https://chat.cloudnds.com`** ผู้ใช้แก้ target จาก `chat.gamecoms.net` และอนุญาตใช้บัญชีเดิม วันที่ 19 กันยายน 2026 ล็อกอินผ่านหน้าเว็บจริงสำเร็จ (`POST /api/v1/auth/login` → 200) ดูรายการแชทและเปิดห้องกลุ่มหนึ่งห้อง จากนั้นตรวจ desktop Chromium ที่ viewport 1440×900, 390×844 และ 320×740

รอบนี้ใช้ assets และข้อมูลจาก deployment จริง ไม่แทน Reverb key หรือใช้ fixture แบบ §3.1 แต่ intercept คำขอเขียนข้อมูลที่ไม่ใช่ auth/channel authorization ให้ไม่ถึง server รวม read receipt จึงเป็น **live visual inspection แบบจำกัด side effects** ไม่ใช่ live messaging/read-state E2E ทดสอบเปิดเมนู more และปิดด้วย Escape โดยไม่เรียก action แล้ว logout เฉพาะ session ที่ใช้ตรวจสำเร็จ (204)

| สิ่งที่วัด/เห็นจริง | ผล / การปรับลำดับงาน |
| --- | --- |
| Desktop 1440px | list row ที่วัดสูง 74px; message text 13px; incoming bubble ตัวอย่างสูงประมาณ 81px เทียบกับ body หนึ่งบรรทัดประมาณ 23px — ลดพื้นที่ footer/action ของข้อความสั้น โดยยังมี touch target ที่เข้าถึงได้ |
| Viewport 390/320px | left rail ยังกว้าง 56px ทำให้พื้นที่ห้องเหลือ 334/264px; room header สูงประมาณ 107px และมี top bar/disclosure เพิ่ม — ยืนยัน P0 ให้ mobile conversation เต็มจอและรวมเครื่องมือ header |
| Actions บนจอแคบ | ปุ่มหลายตัวเรียงใต้ข้อความและ action row ที่วัดสูง 44px — ให้ single more + sheet เป็นงานหลัก ไม่ใช่ปรับสีอย่างเดียว |
| Sidebar desktop | ยังมี title/caption, AI card, create buttons และ section label ก่อนรายการจริง — ยืนยันลดชั้นข้อมูลและคง AI ผ่าน navigation |
| Desktop more menu | เปิดได้ 1 เมนู; Escape แล้วเหลือ 0 เมนูเปิด — ต้องรักษาพฤติกรรมนี้ ไม่ระบุเป็น feature ที่ยังไม่มี |
| Horizontal page overflow | ไม่พบทั้งสาม viewport ที่ตรวจ — ไม่อ้างว่ามี page overflow ใน production ปัจจุบัน; long-content/reflow ยังเป็น regression scenario |
| ข้อความยาวและ quote | พบในห้องจริงและกินพื้นที่อ่านมากบนหน้าจอแคบ; ต้องทดสอบ long text/quote ด้วย fixture ที่ไม่ใช้ข้อมูลลูกค้าในการทำ baseline ถาวร |

**ข้อจำกัด:** ตรวจหนึ่งห้องกลุ่ม ไม่ได้ตรวจทุก DM/secret room หรือทุก state; resize desktop viewport ไม่ใช่ iOS/Android จริงและไม่ได้จำลอง native keyboard/coarse pointer ดังนั้น computed composer 13px ในรอบนี้ไม่ใช่ข้อพิสูจน์ว่า iOS font safeguard เสีย ไม่มีการส่งข้อความใหม่ จึงยังไม่ยืนยัน scroll preservation เมื่อ incoming/reconnect หรือ read receipt semantics แบบ end-to-end การนับปุ่ม jump ด้วย regex กว้างได้ผลที่อาจรวม quote/content buttons จึงไม่นำมาอ้างว่า production มีหรือไม่มี ordinary-history jump control; ข้อนั้นยังอ้างอิง source และต้องตรวจ targeted test ต่อ

ไม่ใส่ชื่อห้อง ชื่อสมาชิก เนื้อหาข้อความ ภาพ production รหัสผ่าน หรือ token ลง repo; เก็บเฉพาะข้อสังเกต layout แบบไม่ระบุตัวบุคคล ผลนี้ยืนยัน priority ของ CL-001/005, MB-001/004 และ mobile layout แต่ไม่แทน customer preference test ใน TASK-UI-002

## 4. Research และสิ่งที่เลือกนำมาใช้

เข้าถึงแหล่งข้อมูลวันที่ 19 กันยายน 2026 ใช้เอกสารทางการเป็นหลัก แหล่ง Telegram บางส่วนเป็นบทความแนะนำ feature ในอดีต ใช้ศึกษารูปแบบปฏิสัมพันธ์ ไม่อ้างว่าเป็น pixel specification ของแอปทุก platform ในเวอร์ชันล่าสุด

| Reference | ข้อเท็จจริงที่แหล่งข้อมูลรองรับ | การประยุกต์ใน Banana Chat |
| --- | --- | --- |
| [Telegram — Chat Folders](https://telegram.org/blog/folders) | แยกแชทตามประเภท/unread และใช้พื้นที่ desktop เพิ่มการเข้าถึงหมวด | รอบแรกใช้ All/Unread จาก filter ที่มีอยู่ ไม่สร้างระบบ folders ใหม่ |
| [Telegram — Replies 2.0](https://telegram.org/blog/reply-revolution) | แตะ quote เพื่อกลับไปยังตำแหน่งต้นฉบับ และมี contextual actions | ทำ quote ให้เห็นความสัมพันธ์ชัด มี jump/highlight และกลับจุดเดิม; ไม่เพิ่ม cross-room reply |
| [LINE — Getting more out of chats](https://help.line.me/line/smartphone/pc?contentId=20005810&lang=en) | จัดการแชทด้วย pin/sort และมี indicator ของ draft | ยึดรายการที่สแกนง่าย แสดง draft เฉพาะเมื่อผูกกับแหล่งข้อมูลเดิมได้; pin เป็น dependency ไม่ใส่ปุ่มหลอก |
| [LINE — Sent / Read / Unread](https://help.line.me/line/?contentId=20021705&lang=en) | แยกสถานะข้อความและมี marker จุดเริ่ม unread | ผูกสถานะกับ bubble; first-unread divider ต้องใช้ read cursor จริง ไม่เดาจากจำนวน unread |
| [WCAG 2.2 — Contrast Minimum](https://www.w3.org/WAI/WCAG22/Understanding/contrast-minimum.html) | ข้อความทั่วไปต้อง contrast อย่างน้อย 4.5:1; large text 3:1 | ตรวจทั้ง body, metadata, selected row และ error ไม่ใช้สีจางจนอ่านไม่ได้ |
| [WCAG 2.2 — Target Size Minimum](https://www.w3.org/WAI/WCAG22/Understanding/target-size-minimum.html) | เป้าขั้นต่ำ 24×24 CSS px โดยมีข้อยกเว้นด้าน spacing ฯลฯ | กำหนด product target 44×44 สำหรับ touch controls; ไม่อ้างว่า WCAG AA บังคับ 44px ทุกกรณี |
| [WCAG 2.2 — Focus Not Obscured](https://www.w3.org/WAI/WCAG22/Understanding/focus-not-obscured-minimum.html) | focused control ต้องไม่ถูก content ที่ผู้พัฒนาสร้างบังทั้งหมด | เมนู, sticky header/composer และ keyboard ต้องไม่ซ่อน focus; ตั้งเป้าให้เห็น control เต็มใน flow หลัก |

**ข้อสรุปเชิงออกแบบของ PO:** ใช้โครงสร้างที่คุ้นเคย คือ incoming ซ้าย/outgoing ขวา, รายการสองบรรทัด, metadata รอง, contextual actions และการอ่านย้อนหลังที่ไม่ถูกขัดจังหวะ สี ขนาด และระยะด้านล่างเป็นข้อเสนอของเรา ไม่ใช่ค่าที่คัดลอกจาก Telegram/LINE ไม่เลือก wallpaper/animation/theme picker ในรอบแรก เพราะไม่ช่วยแก้ปัญหาการสแกนข้อมูลที่พบ

## 5. Visual specification ที่เสนอ

### 5.1 Layout และ design tokens

ค่าต่อไปนี้เป็น prototype starting point; designer ปรับได้เมื่อมีผลทดสอบ แต่ต้องบันทึก token ชุดเดียวและผ่าน accessibility gate

| รายการ | Specification |
| --- | --- |
| Desktop ≥1200px | rail 64px + chat list 320px + conversation ที่เหลือ; timeline inner column กว้างสูงสุด 880px จัดกลาง เพื่อไม่ให้สายตาวิ่งข้ามจอไกล |
| Tablet 768–1199px | rail 56px + list 280px; เมื่อเปิด detail panel ให้เป็น overlay ไม่บีบ bubble จนอ่านยาก |
| Mobile <768px | แสดง list หรือ conversation ทีละหน้า; เมื่อเปิดห้องซ่อน persistent left rail ใช้ Back กลับ list และคืน scroll/filter เดิม; navigation อื่นยังเข้าถึงได้จาก list/menu |
| Header | 64px desktop, 56px mobile เป็นค่าเริ่มต้น; สูงเพิ่มได้เมื่อ text scaling; title truncate, full title อยู่ใน room info |
| Composer | textarea computed font ≥16px บนมือถือ; safe-area + visual viewport/keyboard; ขยายหลายบรรทัดได้โดยไม่ดัน header ออก; ไม่เพิ่ม formatting toolbar ถาวร |
| Spacing | 4/8/12/16/24/32px; padding row 12–16px; message padding 10px 14px; grouped gap 4px, new-sender gap 12px |
| Typography | เลือก family ที่มี Thai glyph จริง เช่น self-host Noto Sans Thai + system fallback; title 15px/600, preview 13px, message 15px desktop / 16px mobile, line-height 1.5–1.6; metadata 12px |
| Surface | app/list `#FFFFFF`; timeline `#F5F7FA`; incoming `#FFFFFF`; outgoing `#FFF3C4`; border `#E2E8F0` |
| Text/brand | primary `#17212B`; secondary `#526170`; brand `#F4D35A` ใช้กับ dark text; selected row `#FFF3C4` + structural indicator; focus `#2563EB` |
| Shape | bubble radius 16px; group joining corner 6px ตามฝั่ง; no decorative tail ในรอบแรก; avatar circle 44px ใน list, 28–32px ใน group timeline |
| Shadow/motion | ไม่มีเงาหนักในทุก bubble; shadow เฉพาะ floating menu/dialog; transition 120–180ms; เคารพ prefers-reduced-motion |

ใช้ `--chat-*` tokens ภายใต้ chat shell/component scope แทนเปลี่ยนสี global `slate` ให้กระทบทุกหน้าของแอป วัด contrast จาก computed styles ของจริงก่อนรับงาน ไม่ถือว่าตาราง hex เป็นผลตรวจผ่าน

### 5.2 Wireframe เชิงโครงสร้าง

```text
Desktop
┌──────┬────────────────────────┬──────────────────────────────────────┐
│ Nav  │ Workspace        [+]   │ Avatar  ชื่อห้อง     โทร  ค้นหา  […] │
│      │ ค้นหา…                 ├──────────────────────────────────────┤
│      │ ทั้งหมด  ยังไม่อ่าน     │       หมุด 1 รายการ / ดูทั้งหมด       │
│      ├────────────────────────┤                 วันนี้              │
│      │ Avatar ชื่อห้อง  14:32 │ Anna                                 │
│      │        preview    [3]  │ [ข้อความของคู่สนทนา]                 │
│      │ Avatar ชื่อห้อง  เมื่อวาน│                  [ข้อความของเรา]    │
│      │        preview         │                         14:33 อ่านแล้ว│
│      │                        │                [↓ ข้อความใหม่ 3]     │
│      │                        ├──────────────────────────────────────┤
│      │                        │ [+] พิมพ์ข้อความ…              [ส่ง] │
└──────┴────────────────────────┴──────────────────────────────────────┘

Mobile: [← ชื่อห้อง  โทร  …] → timeline เต็มความกว้าง → composer ติดล่าง
More บน bubble เปิด action sheet; ไม่มีแถว Reply/Pin/Edit/Delete ใต้ทุกข้อความ
```

ภาพนี้แสดง hierarchy เท่านั้น ไม่ใช่ mockup ที่ผ่านลูกค้า และ “ค้นหาในห้อง” ต้องผูก scope ของ room จริงก่อนแสดงเป็น action

## 6. Functional UX specification

IDs `FR-UI-*`, `TC-UI-*`, `TASK-UI-*` ต่อไปนี้เป็น **proposed IDs ในแผน** ต้องตรวจชนกับ registry/PRODUCT_SPEC ก่อนนำไปรวม

### 6.1 Chat list

| ID / Priority | Requirement และ acceptance criteria |
| --- | --- |
| FR-UI-CL-001 / P0 | แต่ละ row มี avatar, ชื่อห้อง, เวลา, preview และ unread เป็น grid สองบรรทัด; min-height 72px desktop / 76px touch ที่ default font; ชื่อ/preview จำกัดอย่างละหนึ่งบรรทัด แต่ text scaling ต้องไม่ clip; เวลา/badge ไม่ผลักชื่อออกนอกกรอบ |
| FR-UI-CL-002 / P0 | Preview แปลงเป็น plain text ไม่แสดง markdown syntax; ข้อความของเราเติม “คุณ:”; attachment-only ใช้ “รูปภาพ / วิดีโอ / ไฟล์” ตาม type; ไม่มีข้อมูลใช้ “ยังไม่มีข้อความ”; ไม่ใช้ `…` เป็นความหมายของไฟล์; group sender name แสดงเฉพาะเมื่อมีข้อมูลที่เชื่อถือได้ |
| FR-UI-CL-003 / P0 | เวลาใช้ last_message.created_at หรือ room.last_message_at; วันนี้ HH:mm, เมื่อวาน “เมื่อวาน”, ภายใน 7 วันชื่อวัน, เก่ากว่านั้น d MMM และใส่ปีเมื่อคนละปี; locale/timezone เดียวกับ timeline; วันเต็มใน accessible label |
| FR-UI-CL-004 / P0 | Unread ใช้ server count, capped 99+; ชื่อ unread หนาขึ้นและมี badge; muted มี icon+label และ badge แบบรอง; selected มีพื้น+indicator+aria-current ไม่ใช้สีอย่างเดียว; expiry secret room คงมองเห็นและไม่แปลความว่า E2EE |
| FR-UI-CL-005 / P0 | Header เหลือ workspace, title/action “แชทใหม่”, search และ All/Unread; ใช้ filter ที่ API รองรับ; เข้าถึง AI จาก rail/menu เดิม; ย้าย marketing caption/duplicate heading ออก; filter ไม่ทำให้ active conversation ปิดแม้ row หลุดจาก unread list |
| FR-UI-CL-006 / P0 | เปิดห้อง 1 click/tap; mobile Back คืน list offset, filter และคำค้นเดิม; เมื่อ list reorder จาก realtime ไม่ steal focus และไม่เปลี่ยน active room; keyboard ใช้ semantic navigation links ไม่อ้าง listbox ถ้ายังไม่มี listbox interaction |
| FR-UI-CL-007 / P0 | Loading ใช้ skeleton 5–6 rows; มี empty workspace/empty filter/no search results แยกกัน; error มี retry; ถ้ามี cache แสดงข้อมูลเดิมพร้อม offline/stale indicator ไม่เคลียร์เป็นหน้าว่าง |
| FR-UI-CL-008 / P1 | Draft/pinned-room presentation เปิดใช้เมื่อยืนยัน data source และ persistence semantics; message pin กับ room pin เป็นคนละ feature; ห้ามวาด pinned-room state จาก message pins |

**Search contract รอบแรก:** ช่องค้นหา list กรองชื่อห้อง/ชื่อ DM เฉพาะชุดที่โหลดอยู่ และบอกว่า “ค้นหาในรายการนี้”; มี action “ค้นหาข้อความทั้งหมด” ไปหน้า search เดิม ไม่สัญญา full-workspace room search หาก endpoint ยังไม่รองรับ pagination/query ครบ หลีกเลี่ยง label เดิมที่บอกค้นหาห้องแต่เปิดค้นหาเนื้อหาข้อความอย่างเดียว

**Sorting:** รักษาลำดับที่ server ส่งมา ไม่ resort ตามชื่อหรือ unread โดยปริยาย; การเลื่อนแถวเพราะข้อความใหม่ไม่ควรทำให้ click/tap ที่เริ่มไปแล้วเปลี่ยนเป้าหมาย

### 6.2 Message bubble

| ID / Priority | Requirement และ acceptance criteria |
| --- | --- |
| FR-UI-MB-001 / P0 | Incoming ซ้าย/outgoing ขวา; bubble กว้างตามเนื้อหา สูงสุด min(72% ของ inner column, 560px) desktop และ 86% mobile; ข้อความสั้นไม่ยืดเต็มแถว; URL ยาว wrap; code/table overflow เฉพาะภายใน ไม่เกิด horizontal scroll ทั้งหน้า |
| FR-UI-MB-002 / P0 | ใช้ continuesMessage เดิม: ผู้ส่ง/ห้องเดียวกัน ช่องว่าง <5 นาที และไม่ข้ามวัน/system/deleted; ชื่อ/รูปแสดงครั้งเดียวต่อ incoming group; DM ไม่จำเป็นต้องแสดงชื่อซ้ำทุก group แต่ screen reader ยังทราบผู้ส่ง; outgoing ไม่มี avatar; joining corner ต้องถูกฝั่ง |
| FR-UI-MB-003 / P0 | Metadata ขนาด 12px อยู่หลังเนื้อหา ไม่แย่งบรรทัดอ่าน; แสดงเวลา/edited; pending, failed, retry ใช้ state จริงของ outbox; “ส่งแล้ว” หมายถึง server ยืนยัน ไม่ใช่ delivered-to-device; DM “อ่านแล้ว” อยู่ใต้ข้อความล่าสุดของเราตาม FR-READ-002; group read count ไม่สร้างเองจาก online status |
| FR-UI-MB-004 / P0 | Desktop มี more control ที่ keyboard เข้าถึงได้ และแสดงเพิ่มเมื่อ hover/focus; touch มี more control เดียวขนาดแตะ 44px โดยไม่สร้าง toolbar 3–4 ปุ่มทุกข้อความ; เมนูแสดงข้อความ+icon, action ตามสิทธิ์เดิม; long press/right click เป็นทางลัดเสริม; Escape/outside click ปิดและคืน focus |
| FR-UI-MB-005 / P0 | Reply quote มี accent border, snippet สูงสุด 2 บรรทัด, parent sender เมื่อมีข้อมูล, deleted fallback; กดแล้วไป parent seq พร้อม highlight 1.5s (reduced motion ใช้สีคงที่ชั่วคราว); ถ้าเข้าถึงไม่ได้แสดง inline explanation ไม่สร้าง placeholder ที่ดูเหมือนต้นฉบับจริง |
| FR-UI-MB-006 / P0 | ภาพ/วิดีโอ reserve aspect ratio ก่อนโหลด; preview max-height 320px desktop / 280px mobile เป็นค่าเริ่มต้น; file card มีชื่อ, ประเภท, ขนาด; processing/failed มีข้อความชัด; attachment processing ที่ล้มเหลวให้คำอธิบายและแนบใหม่ผ่าน upload เดิม ไม่แสดง processing-retry หากยังไม่มี authorized API; outbox retry เป็นอีก state หนึ่ง; ใช้ renderer/sanitization/media permission เดิม |
| FR-UI-MB-007 / P0 | System events เป็นข้อความกลางขนาดรอง ไม่มี bubble ผู้ส่ง; deleted tombstone คงตำแหน่ง seq; error อยู่ใกล้ action ที่เกิด; edit/reply mode มี cancel ที่เห็นชัด ไม่เพิ่มแถบเครื่องมือถาวร |

**Menu contents:** Reply, Pin/unpin, Edit, Delete ตาม capability/handler ที่มีจริง; destructive action แยกจาก action ทั่วไปและมี confirm ก่อนลบใน UI ใหม่ (บันทึก proposed DEC หากเปลี่ยน interaction เดิม) ไม่เพิ่ม Forward/Reaction/Copy-rich-content โดยไม่มี scope และ test

**ข้อควรระวังข้อมูล:** `Message.reply_to` มี sender_id/snippet แต่ไม่รับประกัน display_name; resolve จาก roster/cache ที่ authorized อยู่แล้ว หรือใช้ label “ตอบกลับข้อความ” ห้ามยิง directory request ต่อ bubble เพื่อเติมชื่อ

### 6.3 Message list UX

| ID / Priority | Requirement และ acceptance criteria |
| --- | --- |
| FR-UI-ML-001 / P0 | เปิดห้องครั้งแรกที่ latest ตามเดิม; ถ้ากลับห้องเดิมใน session ให้ restore message ID/seq + viewport offset ที่เก็บไว้แบบ user/workspace/room scoped; ถ้า anchor ถูกลบ/expiry ให้ fallback อย่างชัดเจน; ไม่ใช้ global offset ข้ามบัญชี |
| FR-UI-ML-002 / P0 | Near-bottom ใช้ threshold 40px เดิมเป็นค่าตั้งต้น; incoming ขณะอยู่ใกล้ bottom ให้ตามล่าสุด; ขณะอ่าน history ให้คงตำแหน่ง และแสดง floating “↓ ข้อความใหม่ N”; ถ้าไม่มีข้อความใหม่แต่ไม่อยู่ล่างให้แสดง “↓ ไปล่าสุด”; ไม่วางปุ่มทับ composer |
| FR-UI-ML-003 / P0 | N เป็น session-local unseen incoming arrivals, dedupe ตาม message ID/seq; ไม่นับ optimistic echo, ข้อความเราเองหรือ replay ซ้ำ; ไม่เรียกว่า server unread ทั้งหมด; เข้า latest แล้ว reset local count และให้ read reporter เดิมเป็นผู้ส่ง receipt |
| FR-UI-ML-004 / P0 | โหลดก่อนหน้าเมื่อเข้าใกล้บน 160px หลัง initial positioning พร้อมปุ่ม manual fallback; single-flight, has_more_before guard, in-place spinner/error/retry; เก็บ message anchor+pixel offset ไม่ใช่พึ่ง scrollHeight อย่างเดียว; เมื่อ prepend/ภาพโหลด/แก้ข้อความ/composer resize ตำแหน่งเดิมคลาด ≤4 CSS px ใน fixture test |
| FR-UI-ML-005 / P0 | Search/quote jump เป็น anchor mode: fetch around_seq, center/highlight เป้าหมาย, มี “กลับจุดที่อ่าน” และ “ไปล่าสุด”; incoming ไม่แย่งตำแหน่ง; parent missing/403/expired แสดงเหตุผลตาม policy; ไม่ mark latest read จากการเปิด search result |
| FR-UI-ML-006 / P0 | Date separator ใช้วันท้องถิ่นเดียวกับ timestamp; “วันนี้/เมื่อวาน/วันที่” อ่านชัด; group/system/date ไม่ซ้อนซ้ำ; sticky current-date chip เป็น P1 หากรอบแรกยังมีปัญหา layout |
| FR-UI-ML-007 / P0 | รักษา read condition: latest sentinel มองเห็น, document visible + focused, ไม่อยู่ anchor mode, throttle ตาม FR-READ-001; เปิดห้องใน background/เลื่อนดู history/preview hover ต้องไม่ clear unread |
| FR-UI-ML-008 / P0 | Reconnect แสดง banner เดียว ไม่เพิ่มข้อความ error ทุก bubble; gap-fill มี retry; pending/failed queue แสดงบน timeline อย่างแยกแยะ แต่ไม่ซ้ำเมื่อ server echo กลับ; expiry/removed member ใช้ flow eviction เดิม |
| FR-UI-ML-009 / P1 | First-unread divider/landing ใช้ authoritative last_read_seq ของผู้ใช้ ณ เปิดห้อง; freeze boundary ระหว่างอ่าน; หากไม่มี cursor หรือ fetch context ไม่ครบ ให้ fallback latest และบอกว่ากำลังเปิดล่าสุด ไม่ใช้ last_seq − unread_count เพื่อเดาตำแหน่ง |

**เมื่อกดส่งขณะอ่าน history:** พาไป latest หลัง enqueue สำเร็จซึ่งเป็นการกระทำโดยตรงของผู้ใช้ พร้อมข้อความเรา; หาก enqueue ล้มเหลวให้ draft ยังอยู่และไม่เปลี่ยนตำแหน่ง ส่วนข้อความ incoming ไม่ทำแบบเดียวกัน

**Performance:** P0 รักษา cursor API และวัดที่ 50/500/2,000 loaded messages กับ media หลากหลาย; ไม่อ้างว่า render DOM 100k ข้อความได้เพราะ API รองรับประวัติ 100k หากเกิน budget ให้ทำ bounded/windowed rendering หรือ virtualization เป็นงาน dependency ก่อน release; native ใช้ FlashList ต่อ

## 7. State model และ accessibility

| State | พฤติกรรมที่ผู้ใช้เห็น |
| --- | --- |
| Initial loading | Skeleton รูปร่างเดียวกับ content, ไม่แสดง unread เป็น 0 ชั่วคราวแล้วสลับ |
| Empty room | “เริ่มบทสนทนาในห้องนี้” และ composer ตามสิทธิ์ ไม่มี promotional illustration ขนาดใหญ่ |
| Cached/offline | ประวัติที่มีอยู่ยังอ่านได้, status สั้นหนึ่งตำแหน่ง, ส่งตาม outbox policy เดิม |
| Failed send | bubble + “ส่งไม่สำเร็จ” และ retry/remove ที่เข้าถึงได้; ไม่ใช้สีแดงอย่างเดียว |
| Loading older failed | error ณ ขอบบนพร้อม retry; ข้อความที่โหลดแล้วและตำแหน่งอ่านคงอยู่ |
| Removed/expired | แสดงข้อความสถานะตาม existing flow และ purge content ตาม policy; ไม่เก็บ snapshot เป็นช่องทางอ่านต่อ |
| Touch keyboard | composer เหนือ keyboard, ส่ง/cancel เข้าถึงได้, header ไม่หาย, ยุบ keyboard ไม่กระโดดไปต้นรายการ |

- Body/preview/metadata ที่จำเป็น contrast ≥4.5:1; focus/non-text UI ใช้ contrast ที่เหมาะสมและตรวจจริงทุก state
- Touch target เป้าหมาย 44×44px; icon 18–20px; bubble content ต้องไม่ถูกบังคับ min-height ตาม global button rule
- ตรวจ keyboard-only: Tab, Enter/Space, Escape, focus return; touch action sheet trap focus และปิดแล้วคืนปุ่มเดิม หาก message หายให้ focus ไปตำแหน่งที่สมเหตุผล
- Screen reader อ่าน sender/content/time/status แบบไม่ซ้ำ; ไม่ตั้ง aria-live บน history ทั้งหมด; announce เฉพาะข้อความใหม่/สถานะสั้น ๆ และไม่อ่านย้อนหลังซ้ำตอน prepend
- ทดสอบไทย/อังกฤษ, ชื่อยาว, emoji, mixed script, 200% zoom, 320px reflow และ text scaling; input ≥16px บน iOS เป็น safeguard เดิมที่ต้องรักษา
- ลด animation ตาม preference; ไม่ใช้ smooth auto-scroll ทุกครั้งที่มี stream/media update

## 8. Data/API และแผนเทคนิค

### 8.1 ใช้ของเดิมก่อน

| ความต้องการ | ของเดิม / dependency |
| --- | --- |
| Chat row title/time/type/unread/muted | `RoomListItem`, `Room`, `last_message` มีข้อมูลพอสำหรับ P0; ไม่เพิ่ม request ต่อแถว |
| All/Unread | `useRooms(slug, filter)` และ `Endpoints.rooms()` มี filter อยู่แล้ว; ตรวจ realtime invalidation/cached scope เมื่อเปลี่ยน filter |
| Preview sender/draft/pinned | `last_message` มี sender_id แต่ไม่มี display_name; list type ไม่ expose pinned state; draft ต้องใช้แหล่งเดียวกับ Composer และเคลียร์ logout; enhanced fields เป็น P1 ไม่เดาข้อมูล |
| Bubble status/group | shared Outbox, MessageStore, continuesMessage, readStatus; query DM receipt ด้วย seq ของข้อความล่าสุดของเราที่แสดงสถานะ ไม่ใช้ค่า default room latest หากเป็นข้อความคนอื่น; pending และ confirmed ใช้ presenter เดียวให้ geometry ไม่กระโดด |
| Jump/history | `useMessages.ts`, RoomSync, before_seq/after_seq/around_seq; คง seq order และ dedupe เดิม |
| First unread | RoomDetail type มี unread_count แต่ไม่ expose own last_read_seq; backend `MessageController.php:244` รับ seq filter และ `Endpoints.readStatus(roomId, slug, 0)` คืน active members รวมผู้ใช้ปัจจุบันพร้อม cursor จริง: ทดลอง reuse แล้วเลือก self.user_id ก่อน; default seq=room latest อาจไม่คืน self ที่ยังอ่านไม่ถึง; capture/freeze cursor ก่อน mark-read side effect; ถ้า contract นี้ไม่พอจึงพิจารณา explicit cursor แบบ backward-compatible ใน P1 |
| Room-local search | ยืนยัน search endpoint scope ก่อนเปลี่ยนปุ่มใน header; หากไม่พร้อมให้ใช้ existing search พร้อม filter ที่รองรับ ห้ามแสดงผลข้ามห้องโดยไม่บอก |

P0 ตั้งเป้าไม่เปลี่ยน schema/API; หากพบข้อมูลไม่พอให้ลด presentation เป็น fallback ที่ซื่อสัตย์ ไม่เพิ่ม N+1 queries เพื่อความสวยงาม

### 8.2 ไฟล์และ responsibility

| พื้นที่ | งานที่คาดว่าจะเปลี่ยน |
| --- | --- |
| `apps/web/src/components/AppShell.tsx`, `RoomList.tsx` | sidebar hierarchy, mobile list/detail navigation, row composition, All/Unread/search states |
| `apps/web/src/components/MessageItem.tsx`, `ChatView.tsx` | bubble/menu/status placement, timeline controls, anchor lifecycle, loading/error states |
| `apps/web/src/components/Composer.tsx` | layout/safe-area/reply-edit geometry; ไม่ย้าย send business logic เข้า component ใหม่ |
| `apps/web/src/index.css`, `buttons.css` | consolidate chat rules; เพิ่ม scoped tokens/explicit opt-out จาก generic button geometry; ตรวจ public chat/AI/calls consumers |
| `apps/web/src/hooks/useMessages.ts`, `useRooms.ts` | pagination loading/error/single-flight state และ reuse filter contract |
| `packages/chat-core/src/message-layout.ts`, `room-sync.ts`, `outbox.ts` | reuse; เพิ่ม pure presentation/anchor-state helpers เฉพาะที่ platform-agnostic; DOM measurements อยู่ web adapter |
| `packages/shared/i18n/th.json`, `en.json` | string keys ของ menu, status, dates, empty/error states ไม่ hardcode สลับภาษา |
| `apps/web/e2e/regression/web.spec.ts`, `mobile.spec.ts` | targeted behavior assertions และ visual fixture coverage; mobile.spec คือ browser ไม่ใช่ Expo QA |
| `apps/mobile/app/rooms.tsx`, `room/[id].tsx` | P1 parity โดยใช้ native interaction/FlashList; ไม่นำ web CSS ไปฝืนใช้ |

## 9. Delivery plan และ dependency

ประมาณการต่อไปนี้เป็น **engineering estimate ก่อนทำ prototype** ไม่ใช่ commitment วันส่ง: 12–18 person-days สำหรับ P0 เมื่อมี frontend 1 คน, designer/PO และ QA ช่วยเป็นช่วง ๆ; มี buffer 20–30% สำหรับ scroll/media/CSS regression งาน native/API enhancement ไม่รวม

| Task | Owner | งาน / Deliverable | Dependency | เกณฑ์จบ |
| --- | --- | --- | --- | --- |
| TASK-UI-001 | PO + UX | เก็บ baseline จาก current-source build ด้วย QA fixtures; desktop/mobile, DM/group; walkthrough pain points กับลูกค้า 5–7 คน | ไม่มี | baseline และ task scenarios บันทึก ไม่ใช้ screenshot build เก่าเป็น final baseline |
| TASK-UI-002 | UX + PO | Prototype “Calm Banana” ตาม tokens นี้; desktop/list/mobile/detail + loading/error/action sheet | 001 | ลูกค้าทดลอง 3 tasks หลัก; เลือก hierarchy/spacing และลง decision; ไม่ขยายไปสอง design systems |
| TASK-UI-003 | Tech Lead | ตรวจ CSS cascade/data contract/scroll ownership; แผนย่อยและ proposed DEC ที่เปลี่ยน interaction; Codex final plan review | 002 | file ownership + test strategy + fallback ครบ |
| TASK-UI-004 | Frontend | Scoped tokens, sidebar, chat rows, All/Unread/search; localized states | 003 | CL P0 ผ่าน visual/keyboard criteria |
| TASK-UI-005 | Frontend | Bubble geometry/status/menu/media/quote; pending renderer สอดคล้อง | 003 และ token contract | MB P0 ผ่าน; permission actions ไม่เปลี่ยน |
| TASK-UI-006 | Frontend + QA | New-message control, anchors, paginator, restore, delayed-media/keyboard cases | 005 | ML P0 และ read receipt invariants ผ่าน |
| TASK-UI-007 | QA อิสระ | Playwright desktop/mobile + accessibility + real-device keyboard + regression shared consumers | 004–006 | ไม่มี critical/high; evidence before/after และ defect list |
| TASK-UI-008 | PO + Tech Lead | Customer validation, correction loop, rollout readiness และ Codex final review | 007 | success metrics + release gates ผ่าน; rollback พร้อม |
| TASK-UI-009 / P1 | Mobile + Backend ตามจำเป็น | Expo parity, authoritative first-unread cursor, enhanced previews, benchmark-driven virtualization | P0 stable | scope/estimate แยกและ native device evidence |

งาน 004/005 ทำขนานได้เมื่อ token contract คงที่และแยกไฟล์เจ้าของ; `ChatView.tsx`, `index.css`, `buttons.css` ให้ผู้รับผิดชอบหลักคนเดียวลด merge conflict ไม่ให้ worker แต่ละคนเพิ่ม global overrides เอง

## 10. Acceptance test plan

| Test ID | Scenario / ผลที่ต้องได้ | Trace |
| --- | --- | --- |
| TC-UI-001 | 30 rooms: DM/group/secret, long Thai name, attachment-only, muted, unread 0/1/100; row alignment คงที่ เวลาไม่ดันชื่อ; selection ชัด | CL-001–004 |
| TC-UI-002 | All → Unread → เปิดห้อง → receipt เปลี่ยน unread → Back; active room ไม่หลุด, filter/scroll คงเดิม | CL-005–006 |
| TC-UI-003 | empty/no-result/loading/error/offline cache; retry คืนรายการโดยไม่ทำลาย room selection | CL-007 |
| TC-UI-004 | consecutive sender, gap ≥5 นาที, midnight, system/deleted; avatar/name/corner grouping ถูกต้อง | MB-001–002 |
| TC-UI-005 | keyboard และ touch เปิด more → reply/edit/delete cancel → Escape/back; focus คืน ถูกสิทธิ์ ไม่มี toolbar ถาวร | MB-004,007 |
| TC-UI-006 | ไทยหลายบรรทัด, URL/code ยาว, edited/deleted/reply/image/video/file; ไม่มี horizontal viewport overflow หรือ metadata ทับ content | MB-001,003,005–007 |
| TC-UI-007 | อ่านกลาง history แล้ว incoming 3 ข้อความ + replay 1; ไม่กระโดด, count 3; กดลงแล้วเห็น latest | ML-002–003 |
| TC-UI-008 | prepend 50 messages + delayed image + edit height + composer resize; anchor เดิมคลาด ≤4px; concurrent load ไม่ซ้ำ; failure มี retry | ML-004 |
| TC-UI-009 | quote/search jump ไปข้อความเก่า, รับ incoming, return anchor/latest; deleted/forbidden parent ไม่ crash | ML-005 |
| TC-UI-010 | background tab, unfocused window, history scroll, around_seq; ไม่ยิง receipt ของ latest; focus+bottom จึงส่งตาม throttle | ML-007 / FR-READ-001 |
| TC-UI-011 | offline send → retry → server ack/echo; ไม่เกิดสอง bubble และ status ไม่อ้าง delivered/read ก่อนมีหลักฐาน | MB-003 / ML-008 |
| TC-UI-012 | 1440×900, 1280×720, 768×1024, 390×844, 360×800, 320px + zoom; iOS Safari/Android keyboard; safe-area/focus/send ใช้ได้ | layout/accessibility |
| TC-UI-013 | logout/user switch/workspace switch/secret expiry/removed member ขณะ fetch; ไม่มี anchor/draft/content รั่วข้าม scope | ML-001,008 |
| TC-UI-014 | AI/public chat/notes/media/calls smoke หลังแก้ shared CSS; ปุ่มไม่เสีย geometry และ permission ไม่เปลี่ยน | shared-style regression |
| TC-UI-015 | 50/500/2,000 messages บน reference desktop/mid-range phone; วัด scroll/input/DOM count ตาม budget ด้านล่าง | performance |

### Release gates และ success metrics

- ลูกค้า 5–7 คนทำ tasks เดิมก่อน/หลัง: หาห้อง unread ที่กำหนด, reply ไปข้อความเก่า, อ่านย้อนหลังแล้วกลับ latest; randomize ลำดับ old/new ลด learning bias
- เป้าหมายเชิง usability: task completion ≥90% ของ attempts รวม, median เวลาหาห้องลด ≥20% จาก baseline, คะแนน “อ่านง่าย/เป็นระเบียบ” median ≥4/5 และไม่ด้อยกว่า baseline; sample นี้เป็น formative validation ไม่ใช่ข้อพิสูจน์เชิงสถิติ
- 100% ของ critical scroll/read/permission tests ผ่าน; ไม่มี unresolved HIGH/BLOCKER; contrast/keyboard/focus หลักผ่าน
- Candidate client budgets บน device/browser ที่ระบุใน evidence: p95 input-to-next-paint ≤200ms ระหว่างใช้งาน fixture; p95 scroll frame interval ≤32ms ใน scripted scroll 10s หลัง warm-up; ทุก fixture anchor drift ≤4px หลัง settle; วัดใหม่ก่อนใช้เป็น release budget ถ้า reference hardware ยังไม่ตกลง
- API/realtime NFR เดิมไม่เปลี่ยน: client paint budgets ไม่ใช่การรับประกัน latency ของ network และห้ามใช้แทน NFR-PERF-001–003
- ตรวจ relevant shared tests + `pnpm typecheck`, web lint/build และ Playwright; ถ้า environment ขาด native dependencies/PHP ให้แสดง BLOCKED ของชุดนั้น ไม่สรุปว่าทั้งระบบผ่าน
- Screenshot approval ใช้ deterministic current-source build/QA data/theme/viewport/font เดียวกัน มี DM/group และ action-open/failed-send/mobile-keyboard states; ไม่ใช้ production data ใน baseline

## 11. Rollout, risks และ open decisions

**Rollout ที่เสนอสำหรับงาน implementation:** QA/local → staging fixtures → กลุ่มใช้งานภายใน → ลูกค้านำร่อง → rollout เต็มเมื่อ metrics ผ่าน มี release image/build เดิมพร้อม rollback; ถ้า repo ไม่มี UI flag ให้ใช้ staging/release rollback แทนเพิ่มระบบ flags ใหม่เพียงเพื่อการ redesign ครั้งนี้ การเขียนแผนนี้ไม่ใช่การ deploy

| ความเสี่ยง | วิธีลด / เจ้าของ |
| --- | --- |
| ลดปุ่มแล้วผู้ใช้หา action ไม่พบ | more control ต้อง discoverable; label ใน sheet, keyboard access และ task test / UX |
| Layout สวยแต่ receipt อ่านผิดหรือ scroll กระโดด | แยก navigation state จาก read state; รักษา reporter เดิม; deterministic event/media tests / Frontend + QA |
| Global button/CSS rules ดัน bubble สูงอีก | Audit computed styles, scoped overrides/opt-outs, single owner และ regression shared consumers / Tech Lead |
| ภาษาไทย font fallback หรือบรรทัดแน่น | bundle/font decision ชัดเจน, test shaping/line-height/text scale และจำลอง font load ช้า / UX + QA |
| P0 ขยายไปทุก feature ของ Telegram/LINE | feature gate ตาม data contract; no dummy online/read/pin state; P1 แยก estimate / PO |
| Native offline/reply issues จาก REVIEW.md | ถ้ายังไม่แก้ ต้องเป็น dependency ก่อนรับ native parity ว่าสมบูรณ์ ไม่ถือว่าแก้แล้วจาก redesign / Mobile |
| API/media security findings ใน REVIEW.md | ติดตามเป็น release risk แยกจาก UI; ลูกค้ารับ visual design ไม่เท่ากับอนุมัติ security readiness / Tech Lead |

**ค่าเริ่มต้นที่ PO เสนอเพื่อเริ่มงานได้:** Light “Calm Banana”, responsive web ก่อน, All/Unread, latest-on-first-open, contextual more menu และ no decorative wallpaper

**OQ-UI-001:** ลูกค้าต้องการ native Expo พร้อม web ใน release เดียวหรือไม่? ปัจจุบันแผนจัด native เป็น P1; ถ้าจำเป็นต้องพร้อมกันให้เพิ่ม estimate/owner/device QA ไม่แอบนับรวม

**OQ-UI-002:** หลังทดลอง prototype ควรเปิดห้องที่ first unread หรือ latest? P0 คง latest เดิม; first unread ต้องตกลง product behavior และยืนยัน cursor contract ก่อน

**OQ-UI-003:** ต้องการ custom font self-host หรือ system Thai font เป็นหลัก? ใช้ prototype เปรียบเทียบความอ่านง่ายและต้นทุนโหลดก่อนลง token final

Open decisions เหล่านี้ไม่ขัดขวางการทำ prototype ตามค่าเริ่มต้น แต่ต้องปิดข้อที่เกี่ยวข้องก่อนส่งมอบ phase นั้น

## 12. สถานะการตรวจแผน

งานเอกสารนี้ใช้ source inspection, official-source research, local mock-render screenshots และ independent source audit จริง ต่อมาเพิ่ม authenticated live visual inspection ที่ `chat.cloudnds.com` ตาม §3.3 แล้ว ยังไม่มี customer interview, full build/test suite หรือ native device test ผล independent planning review ด้านล่างเป็นของแผนก่อนเพิ่มหลักฐาน live; ส่วนเพิ่มเติมนี้ Codex ตรวจทานเอง

**Document QA:** proposed requirement IDs 24 ข้อและ test IDs 15 ข้อไม่ซ้ำ; ตรวจ Markdown fences/trailing whitespace และ git status แล้ว พบเพิ่มเฉพาะ `PLAN_ASTRA.md` ในงานนี้ ผู้ตรวจอิสระให้ planning PASS โดยไม่มี BLOCKER/HIGH; แก้ clarification เรื่อง server attachment preview, readStatus seq=0 และ processing retry แล้ว

ตรวจ current UI แล้วในขอบเขตหลักฐานข้างต้น; acceptance metrics, revised UI และ release gates เป็น **สิ่งที่จะตรวจเมื่อพัฒนา** ไม่ใช่ผล PASS ที่เกิดขึ้นแล้ว เอกสารนี้เป็น handoff ให้ PO/UX/engineering เริ่ม TASK-UI-001–003 โดยยังคง application code เดิม

### Follow-up: การตรวจ production หลังได้รับบัญชีจากผู้ใช้

ครั้งแรกวันที่ 19 กันยายน 2026 ลองบัญชีที่ผู้ใช้อนุญาตบน `https://chat.gamecoms.net` หนึ่งครั้ง ได้ **401 Unauthorized** โดยยังไม่ได้เข้าถึงห้อง ต่อมาผู้ใช้แก้ target เป็น `https://chat.cloudnds.com` และล็อกอินสำเร็จ **200** ตรวจ UI จริงแล้วตาม §3.3 ดังนั้นข้อจำกัด “ยังเข้า deployment ไม่ได้” ของความพยายามแรกถูกปลดแล้ว ไม่ต้องลองบัญชีซ้ำบนโดเมนเดิม

ไม่ได้ส่งข้อความหรือแก้ไขข้อมูลแชท ปิดกั้น read receipt และคำขอเขียนข้อมูลแชทระหว่างตรวจ ไม่บันทึกรหัสผ่าน/token ลงเอกสารหรือไฟล์โปรเจกต์ และ logout session ที่ใช้ตรวจแล้ว ขั้นถัดไปคือสร้าง prototype และทดสอบกับ QA fixtures ตามแผน ไม่สรุปจาก 401 บนโดเมนแรกว่า credential ผิดหรือ auth ของโดเมนที่ถูกต้องมีบั๊ก


## Implementation follow-up — 19 กันยายน 2026

รอบแก้ต่อจาก handoff commit `4097d2e`: ปรับ web chat list, message bubble และ message-list UX ตาม DEC-078 แล้วใน working tree รายละเอียดหลักฐาน/ข้อจำกัดอยู่ใน [UI_REVIEW_ASTRA.md](UI_REVIEW_ASTRA.md)

- รายการแชท: ลดส่วนตกแต่งที่แย่งพื้นที่, search ในรายการ, All/Unread, คงข้อมูล cache เมื่อ refresh ล้มเหลว; กลับจากห้องบนมือถือแล้วยังรักษา filter
- ห้องแชท: mobile เต็มจอพร้อม Back; typography/spacing และสี bubble ชุดเดียว; รวม tools ในเมนู; contextual actions มีชื่อ, focus trap/Escape และยืนยันก่อนลบ
- Timeline: รักษา seq+pixel offset เมื่อ prepend/edit/resize, single-flight pagination พร้อม retry, new-arrival count และ latest, scope การจำตำแหน่งตาม user/workspace/room, quote highlight/return และ read gating
- Verification: browser fixtures แยกจาก production; รายละเอียดคำสั่งและผลอยู่ใน report ไม่ถือว่า fixture PASS คือ customer acceptance
- ยังไม่ปิด TASK-UI-008: ไม่มี customer usability session/ความเห็นชอบด้านความสวยงามจากผู้ใช้ และยังไม่มี real iOS/Android keyboard acceptance ของรอบนี้
- P1 ตามแผนเดิม: native Expo parity, authoritative first-unread landing, sticky date และ virtualization หาก benchmark จำเป็น

รายการนี้ไม่แก้สถานะ historical planning evidence ด้านบน และไม่อ้างว่า FR-UI ทั้งหมดหรือ production rollout ผ่านแล้ว


### Beauty-first refinement

ตามคำสั่งล่าสุด ให้เน้นความสวยงามก่อน: ปรับ filter เป็น pill ขนาดพอดีข้อความ, selected row มี edge indicator, bubble/timeline ใช้เส้นขอบอ่อน, composer โค้งมนและปุ่มส่งวงกลม, mobile Back ไม่มีกรอบ และ self-host Noto Sans Thai พร้อม license เวลาแสดงตาม locale ของแอป รายละเอียด/preview อยู่ใน `UI_REVIEW_ASTRA.md` รอบนี้ full browser suite17/17 ผ่าน และ visual review อิสระไม่พบ blocking issue แต่ยังเป็น local preview ไม่ใช่ customer sign-off หรือ staging deployment
