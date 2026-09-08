<!DOCTYPE html>
<html lang="th">
<head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <meta name="robots" content="noindex,nofollow">
    <title>ติดตั้ง Banana Chat</title>
    <style>
        :root {
            --bg: #f0f0f1;
            --card: #fff;
            --ink: #1d2327;
            --muted: #646970;
            --line: #dcdcde;
            --brand: #f5c542;
            --brand-ink: #3a2f00;
            --ok: #00a32a;
            --bad: #d63638;
            --focus: #2271b1;
        }
        * { box-sizing: border-box; }
        body {
            margin: 0; background: var(--bg); color: var(--ink);
            font: 15px/1.6 -apple-system, BlinkMacSystemFont, "Segoe UI", "Noto Sans Thai", Roboto, sans-serif;
        }
        .wrap { max-width: 560px; margin: 40px auto; padding: 0 16px; }
        .logo { text-align: center; margin-bottom: 20px; }
        .logo .mark {
            display: inline-grid; place-items: center; width: 72px; height: 72px;
            background: var(--brand); border-radius: 18px; font-size: 40px;
            box-shadow: 0 2px 8px rgba(0,0,0,.15);
        }
        .logo h1 { font-size: 22px; margin: 12px 0 0; }
        .logo p { margin: 4px 0 0; color: var(--muted); font-size: 13px; }
        .card {
            background: var(--card); border: 1px solid var(--line); border-radius: 8px;
            padding: 24px 28px; margin-bottom: 16px; box-shadow: 0 1px 3px rgba(0,0,0,.04);
        }
        .steps { display: flex; gap: 6px; margin-bottom: 22px; }
        .steps i { flex: 1; height: 4px; border-radius: 2px; background: var(--line); }
        .steps i.on { background: var(--focus); }
        .h { font-size: 18px; font-weight: 700; margin: 0 0 4px; }
        .sub { color: var(--muted); font-size: 13px; margin: 0 0 18px; }
        label { display: block; font-weight: 600; font-size: 13px; margin: 14px 0 4px; }
        label .req { color: var(--bad); }
        input {
            width: 100%; padding: 8px 10px; font: inherit; color: var(--ink);
            border: 1px solid #8c8f94; border-radius: 4px; background: #fff;
        }
        input:focus { outline: 2px solid var(--focus); outline-offset: -1px; }
        .row { display: flex; gap: 12px; }
        .row > div { flex: 1; }
        .row .narrow { flex: 0 0 110px; }
        .btns { display: flex; justify-content: space-between; align-items: center; margin-top: 22px; }
        button {
            font: inherit; font-weight: 600; padding: 9px 18px; border: 0; border-radius: 4px;
            cursor: pointer; background: var(--focus); color: #fff;
        }
        button:hover { background: #135e96; }
        button.ghost { background: transparent; color: var(--focus); padding-left: 0; }
        button.big { width: 100%; padding: 13px; font-size: 16px; background: #3a2f00; }
        button[disabled] { opacity: .55; cursor: wait; }
        .msg { border-radius: 4px; padding: 10px 12px; font-size: 13px; margin-top: 14px; }
        .msg.ok { background: #edfaef; border-left: 4px solid var(--ok); color: #106b21; }
        .msg.bad { background: #fcf0f1; border-left: 4px solid var(--bad); color: #8a2424; white-space: pre-wrap; }
        .checks { list-style: none; margin: 0; padding: 0; }
        .checks li { display: flex; justify-content: space-between; padding: 7px 0; border-bottom: 1px solid #f0f0f1; font-size: 14px; }
        .checks li:last-child { border-bottom: 0; }
        .tag { font-size: 12px; font-weight: 700; }
        .tag.ok { color: var(--ok); }
        .tag.bad { color: var(--bad); }
        .hidden { display: none; }
        .final-creds { background: #f9f9f9; border: 1px dashed var(--line); border-radius: 6px; padding: 14px 16px; font-size: 14px; }
        .final-creds code { background: #fff; border: 1px solid var(--line); border-radius: 3px; padding: 1px 6px; }
        .foot { text-align: center; color: var(--muted); font-size: 12px; }
        a { color: var(--focus); }
    </style>
</head>
<body>
<div class="wrap">
    <div class="logo">
        <div class="mark">🍌</div>
        <h1>Banana Chat</h1>
        <p>ตัวติดตั้งอัตโนมัติครั้งแรก — เหมือน WordPress 5-minute install</p>
    </div>

    <div class="steps"><i id="b0"></i><i id="b1"></i><i id="b2"></i><i id="b3"></i><i id="b4"></i></div>

    {{-- ── Step 0: requirements ─────────────────────────────────────────── --}}
    <section class="card" id="s0">
        <p class="h">ยินดีต้อนรับ</p>
        <p class="sub">ตรวจสอบความพร้อมของเซิร์ฟเวอร์ก่อนเริ่ม แล้วกด "เริ่มติดตั้ง"</p>
        <ul class="checks">
            <li><span>PHP ≥ 8.2 (รันอยู่ {{ $requirements['php_version']['current'] ?? '?' }})</span>
                <span class="tag {{ ($requirements['php_version']['ok'] ?? false) ? 'ok' : 'bad' }}">{{ ($requirements['php_version']['ok'] ?? false) ? 'ผ่าน' : 'ไม่ผ่าน' }}</span></li>
            @foreach (($requirements['extensions'] ?? []) as $ext)
                <li><span>ส่วนขยาย {{ $ext['name'] }}</span>
                    <span class="tag {{ $ext['ok'] ? 'ok' : 'bad' }}">{{ $ext['ok'] ? 'ผ่าน' : 'ไม่พบ' }}</span></li>
            @endforeach
            <li><span>โฟลเดอร์ storage/ เขียนได้</span>
                <span class="tag {{ ($requirements['storage_writable'] ?? false) ? 'ok' : 'bad' }}">{{ ($requirements['storage_writable'] ?? false) ? 'ผ่าน' : 'ไม่ผ่าน' }}</span></li>
            <li><span>ไฟล์ .env เขียนได้</span>
                <span class="tag {{ ($requirements['env_writable'] ?? false) ? 'ok' : 'bad' }}">{{ ($requirements['env_writable'] ?? false) ? 'ผ่าน' : 'ไม่ผ่าน' }}</span></li>
        </ul>
        <div class="btns"><span></span><button type="button" data-next>เริ่มติดตั้ง →</button></div>
    </section>

    {{-- ── Step 1: PostgreSQL ───────────────────────────────────────────── --}}
    <section class="card hidden" id="s1">
        <p class="h">ฐานข้อมูล PostgreSQL</p>
        <p class="sub">ข้อมูลที่กรอกจะถูกเขียนลง .env (DB_HOST, DB_PORT, …) และใช้รัน migration ทันที</p>
        <div class="row">
            <div>
                <label>โฮสต์ <span class="req">*</span></label>
                <input data-f="db.host" value="127.0.0.1" autocomplete="off">
            </div>
            <div class="narrow">
                <label>พอร์ต <span class="req">*</span></label>
                <input data-f="db.port" value="5432" inputmode="numeric">
            </div>
        </div>
        <label>ชื่อฐานข้อมูล <span class="req">*</span></label>
        <input data-f="db.database" value="orgchat" autocomplete="off">
        <label>ชื่อผู้ใช้ <span class="req">*</span></label>
        <input data-f="db.username" value="orgchat" autocomplete="off">
        <label>รหัสผ่าน</label>
        <input data-f="db.password" type="password" autocomplete="new-password">
        <div class="msg ok hidden" id="db-ok"></div>
        <div class="msg bad hidden" id="db-bad"></div>
        <div class="btns">
            <button type="button" class="ghost" data-back>← ย้อนกลับ</button>
            <div style="display:flex;gap:10px">
                <button type="button" id="db-test">ทดสอบการเชื่อมต่อ</button>
                <button type="button" data-next data-gate="db">ถัดไป →</button>
            </div>
        </div>
    </section>

    {{-- ── Step 2: Redis + Mail ─────────────────────────────────────────── --}}
    <section class="card hidden" id="s2">
        <p class="h">Redis และอีเมล</p>
        <p class="sub">Redis ใช้เก็บ cache / queue / session และอีเมลใช้ส่งคำเชิญสมาชิก</p>
        <div class="row">
            <div>
                <label>Redis โฮสต์ <span class="req">*</span></label>
                <input data-f="redis.host" value="127.0.0.1" autocomplete="off">
            </div>
            <div class="narrow">
                <label>พอร์ต <span class="req">*</span></label>
                <input data-f="redis.port" value="6379" inputmode="numeric">
            </div>
        </div>
        <label>Redis รหัสผ่าน (ถ้ามี)</label>
        <input data-f="redis.password" type="password" autocomplete="new-password">
        <div class="msg ok hidden" id="redis-ok"></div>
        <div class="msg bad hidden" id="redis-bad"></div>

        <hr style="border:0;border-top:1px solid var(--line);margin:20px 0">

        <div class="row">
            <div>
                <label>SMTP โฮสต์ <span class="req">*</span></label>
                <input data-f="mail.host" value="127.0.0.1" autocomplete="off">
            </div>
            <div class="narrow">
                <label>พอร์ต <span class="req">*</span></label>
                <input data-f="mail.port" value="1025" inputmode="numeric">
            </div>
        </div>
        <label>อีเมลผู้ส่ง <span class="req">*</span></label>
        <input data-f="mail.from_address" type="email" value="no-reply@example.local">
        <div class="btns">
            <button type="button" class="ghost" data-back>← ย้อนกลับ</button>
            <div style="display:flex;gap:10px">
                <button type="button" id="redis-test">ทดสอบ Redis</button>
                <button type="button" data-next data-gate="redis">ถัดไป →</button>
            </div>
        </div>
    </section>

    {{-- ── Step 3: admin + workspace + room ─────────────────────────────── --}}
    <section class="card hidden" id="s3">
        <p class="h">ผู้ดูแลระบบและ workspace</p>
        <p class="sub">สร้างบัญชี system admin แรก พร้อม workspace และห้องแชทเริ่มต้น</p>
        <div class="row">
            <div>
                <label>ชื่อผู้ใช้ผู้ดูแล <span class="req">*</span></label>
                <input data-f="admin.username" value="admin" autocomplete="off">
            </div>
            <div>
                <label>ชื่อที่แสดง <span class="req">*</span></label>
                <input data-f="admin.display_name" value="ผู้ดูแลระบบ">
            </div>
        </div>
        <label>รหัสผ่านผู้ดูแล (8 ตัวขึ้นไป) <span class="req">*</span></label>
        <input data-f="admin.password" type="password" autocomplete="new-password">

        <div class="row" style="margin-top:6px">
            <div>
                <label>ชื่อ workspace <span class="req">*</span></label>
                <input data-f="ws.name" value="Banana Workspace">
            </div>
            <div>
                <label>slug (a-z, 0-9, -) <span class="req">*</span></label>
                <input data-f="ws.slug" value="banana">
            </div>
        </div>
        <label>ชื่อห้องแรก <span class="req">*</span></label>
        <input data-f="room.name" value="ทั่วไป">
        <div class="btns">
            <button type="button" class="ghost" data-back>← ย้อนกลับ</button>
            <button type="button" id="install">ติดตั้งเลย</button>
        </div>
    </section>

    {{-- ── Step 4: running + success ────────────────────────────────────── --}}
    <section class="card hidden" id="s4">
        <p class="h" id="s4-title">กำลังติดตั้ง…</p>
        <p class="sub" id="s4-sub">เขียน .env รัน migration และสร้างข้อมูลเริ่มต้น — ห้ามปิดหน้านี้</p>
        <div id="s4-progress">กำลังดำเนินการ อาจใช้เวลา 10–60 วินาที…</div>
        <div class="final-creds hidden" id="s4-done">
            ✅ ติดตั้งเสร็จเรียบร้อย — ข้อมูลการเข้าสู่ระบบผู้ดูแล:
            <ul style="margin:8px 0 0;padding-left:18px">
                <li>เข้าสู่ระบบผู้ดูแล: <a href="/admin/login"><code>/admin/login</code></a></li>
                <li>ชื่อผู้ใช้: <code id="done-user">admin</code></li>
                <li>เว็บแชท: <a href="/"><code>/</code></a></li>
            </ul>
            <p style="margin:10px 0 0;color:var(--muted);font-size:12px">ตัวติดตั้งถูกล็อกแล้ว (FR-SETUP-006) — เพื่อเรียกใช้อีกครั้งให้ตั้ง SETUP_COMPLETED=false ใน .env</p>
        </div>
    </section>

    <p class="foot">Banana Chat installer · FR-SETUP · API-120..123</p>
</div>

<script>
(function () {
    'use strict';

    var TOTAL = 5, step = 0;
    var tested = { db: false, redis: false };

    function els(sel) { return document.querySelectorAll(sel); }
    function show(n) {
        step = n;
        for (var i = 0; i < TOTAL; i++) {
            var card = document.getElementById('s' + i);
            if (card) card.classList.toggle('hidden', i !== n);
            var bar = document.getElementById('b' + i);
            if (bar) bar.classList.toggle('on', i <= n);
        }
        window.scrollTo(0, 0);
    }

    function field(name) {
        var el = document.querySelector('[data-f="' + name + '"]');
        return el ? el.value.trim() : '';
    }

    function api(path, body) {
        return fetch('/api/v1/setup' + path, {
            method: body ? 'POST' : 'GET',
            headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
            body: body ? JSON.stringify(body) : undefined,
        }).then(function (r) {
            return r.json().then(function (j) { j.__status = r.status; return j; });
        });
    }

    function say(id, text) {
        var el = document.getElementById(id);
        el.textContent = text;
        el.classList.remove('hidden');
    }

    // ── gate buttons: block "next" until the probe passed ──────────────
    els('[data-gate]').forEach(function (btn) {
        var gate = btn.getAttribute('data-gate');
        function refresh() { btn.disabled = !tested[gate]; }
        refresh();
        setInterval(refresh, 400);
    });

    els('[data-next]').forEach(function (btn) {
        btn.addEventListener('click', function () { show(step + 1); });
    });
    els('[data-back]').forEach(function (btn) {
        btn.addEventListener('click', function () { show(step - 1); });
    });

    // ── probes ──────────────────────────────────────────────────────────
    document.getElementById('db-test').addEventListener('click', function () {
        var b = this; b.disabled = true;
        document.getElementById('db-ok').classList.add('hidden');
        document.getElementById('db-bad').classList.add('hidden');
        api('/test-database', {
            host: field('db.host'), port: parseInt(field('db.port'), 10),
            database: field('db.database'), username: field('db.username'),
            password: field('db.password'),
        }).then(function (j) {
            b.disabled = false;
            var d = j.data || {};
            if (d.ok) { tested.db = true; say('db-ok', '✅ เชื่อมต่อสำเร็จ — ' + (d.server_version || 'PostgreSQL')); }
            else { say('db-bad', '❌ ' + (d.error || j.error && j.error.message || 'เชื่อมต่อไม่ได้')); }
        }).catch(function (e) { b.disabled = false; say('db-bad', '❌ ' + e.message); });
    });

    document.getElementById('redis-test').addEventListener('click', function () {
        var b = this; b.disabled = true;
        document.getElementById('redis-ok').classList.add('hidden');
        document.getElementById('redis-bad').classList.add('hidden');
        api('/test-redis', {
            host: field('redis.host'), port: parseInt(field('redis.port'), 10),
            password: field('redis.password'),
        }).then(function (j) {
            b.disabled = false;
            var d = j.data || {};
            if (d.ok) { tested.redis = true; say('redis-ok', '✅ Redis ตอบ PONG แล้ว'); }
            else { say('redis-bad', '❌ ' + (d.error || j.error && j.error.message || 'เชื่อมต่อไม่ได้')); }
        }).catch(function (e) { b.disabled = false; say('redis-bad', '❌ ' + e.message); });
    });

    // ── install ─────────────────────────────────────────────────────────
    document.getElementById('install').addEventListener('click', function () {
        var b = this; b.disabled = true;
        show(4);

        api('/install', {
            database: {
                host: field('db.host'), port: parseInt(field('db.port'), 10),
                database: field('db.database'), username: field('db.username'),
                password: field('db.password'),
            },
            redis: {
                host: field('redis.host'), port: parseInt(field('redis.port'), 10),
                password: field('redis.password'),
            },
            mail: {
                host: field('mail.host'), port: parseInt(field('mail.port'), 10),
                from_address: field('mail.from_address'),
            },
            admin: {
                username: field('admin.username'), display_name: field('admin.display_name'),
                password: field('admin.password'),
            },
            workspace: { name: field('ws.name'), slug: field('ws.slug') },
            room_name: field('room.name'),
        }).then(function (j) {
            if (j.data && j.data.ok) {
                document.getElementById('s4-progress').classList.add('hidden');
                document.getElementById('s4-done').classList.remove('hidden');
                document.getElementById('s4-title').textContent = 'ติดตั้งสำเร็จ 🎉';
                document.getElementById('s4-sub').textContent = 'ระบบพร้อมใช้งานแล้ว';
                document.getElementById('done-user').textContent = j.data.admin_username;
                return;
            }
            document.getElementById('s4-progress').innerHTML =
                '<div class="msg bad">การติดตั้งล้มเหลว: ' +
                ((j.error && (j.error.message || JSON.stringify(j.error.details || ''))) || JSON.stringify(j)) +
                '</div><button type="button" class="ghost" onclick="location.reload()">← กลับไปแก้ข้อมูล</button>';
        }).catch(function (e) {
            document.getElementById('s4-progress').innerHTML =
                '<div class="msg bad">การติดตั้งล้มเหลว: ' + e.message + '</div>';
        });
    });

    // ── prefill from API-120 (docker-aware defaults when present) ──────
    api('/status').then(function (j) {
        var d = j.data && j.data.defaults;
        if (!d) return;
        if (d.database) {
            if (d.database.host) document.querySelector('[data-f="db.host"]').value = d.database.host;
            if (d.database.port) document.querySelector('[data-f="db.port"]').value = d.database.port;
            if (d.database.database) document.querySelector('[data-f="db.database"]').value = d.database.database;
            if (d.database.username) document.querySelector('[data-f="db.username"]').value = d.database.username;
        }
        if (d.redis) {
            if (d.redis.host) document.querySelector('[data-f="redis.host"]').value = d.redis.host;
            if (d.redis.port) document.querySelector('[data-f="redis.port"]').value = d.redis.port;
        }
        if (d.mail && d.mail.from_address) {
            document.querySelector('[data-f="mail.from_address"]').value = d.mail.from_address;
        }
    }).catch(function () { /* defaults in markup are fine */ });
})();
</script>
</body>
</html>
