<x-filament-panels::page>
    <div class="bc-pchat-docs">
        <style>
            .bc-pchat-docs pre{background:var(--bc-soft);border:1px solid var(--bc-line);border-radius:12px;padding:14px 16px;overflow-x:auto;font-size:12.5px;line-height:1.55;margin:0}
            .bc-pchat-docs code{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace}
            .bc-pchat-docs h3{font-size:12px;font-weight:700;letter-spacing:.08em;text-transform:uppercase;color:var(--bc-muted);margin:0 0 10px}
            .bc-pchat-docs ol.bc-flow{counter-reset:step;list-style:none;padding:0;margin:0;display:flex;flex-direction:column;gap:10px}
            .bc-pchat-docs ol.bc-flow li{counter-increment:step;display:flex;gap:12px;align-items:baseline;font-size:13.5px;line-height:1.5}
            .bc-pchat-docs ol.bc-flow li::before{content:counter(step);flex-shrink:0;width:22px;height:22px;border-radius:999px;background:var(--bc-ink);color:#fff;font-size:11px;font-weight:700;display:flex;align-items:center;justify-content:center}
            .bc-pchat-docs .bc-example-grid{display:grid;grid-template-columns:1fr;gap:16px}
            .bc-pchat-docs .bc-example-grid>div{min-width:0}
            @media (min-width:900px){.bc-pchat-docs .bc-example-grid{grid-template-columns:1fr 1fr}}
        </style>

        <section class="bc-admin-hero">
            <div>
                <span class="bc-admin-eyebrow">FR-PCHAT · PARTNER INTEGRATION</span>
                <h2>Public Chat, from key to conversation.</h2>
                <p>
                    A partner backend signs one request and gets back a URL. The customer opens it and
                    talks to your support queue in real time. This page is a concise summary — every
                    exact field, error and rate limit is in the downloadable guide below, kept
                    code-verified so an AI agent (or you) can implement against it directly.
                </p>
            </div>
        </section>

        <x-filament::section heading="Choose your integration">
            <div class="bc-admin-grid-three">
                <div class="bc-admin-card">
                    <h3>Hosted link — recommended</h3>
                    <p>Your backend calls Tier 1 (HMAC-signed) to create a room and gets a URL. Deliver it
                    to the customer; the hosted page at <code>/support/&lt;code&gt;</code> handles chat,
                    uploads and realtime. No frontend work on your side.</p>
                </div>
                <div class="bc-admin-card">
                    <h3>Custom visitor UI</h3>
                    <p>Build your own widget against Tier 2 — unauthenticated, the 64-hex room code
                    <em>is</em> the credential. You own every future change to this surface. Full
                    endpoint list in the guide §5.2.</p>
                </div>
                <div class="bc-admin-card">
                    <h3>Staff tooling (internal)</h3>
                    <p>Tier 3 — existing member bearer auth. Not reachable by a partner and not part of
                    an external integration; listed in the guide §5.3 for completeness only.</p>
                </div>
            </div>
        </x-filament::section>

        <x-filament::section heading="Before you start">
            <ol class="bc-flow">
                <li>Enable <code>publicchat.enabled</code> in <a href="/admin/settings">Settings</a> — it ships off by default, so Public Chat conversation writes (create, close, send, status, uploads) 503 until an admin turns it on.</li>
                <li>Issue a key in <a href="/admin/public-chat-api-keys">Public Chat API Keys</a>. You get a <code>key_id</code> (public, safe to log) and a <code>secret</code>.</li>
                <li>The secret is shown exactly once, at issuance. Put it straight into your secret manager — it cannot be read back afterward.</li>
            </ol>
        </x-filament::section>

        <x-filament::section heading="From ticket to conversation">
            <ol class="bc-flow">
                <li><strong>Create</strong> — sign and POST to <code>/api/v1/partner/public-chat/rooms</code> (API-200).</li>
                <li><strong>Save &amp; deliver</strong> — store the returned <code>room.id</code> (ULID) for every later call; deliver <code>url</code> to the customer over TLS.</li>
                <li><strong>Conversation happens</strong> — the customer chats on the hosted page; your support agents reply from their own staff queue (not the hosted page). The room appears in the queue instantly and auto-claims on first reply.</li>
                <li><strong>Poll status</strong> — <code>GET .../rooms/{id}</code> (API-201) whenever you need it; it keeps answering even if the feature is later disabled.</li>
                <li><strong>Close</strong> — <code>POST .../rooms/{id}/close</code> (API-202) when your ticket resolves. While the visitor link is still valid, the transcript stays readable and new sends get <code>409</code>; past the link's own expiry, every visitor route (closed or not) answers <code>410</code> instead.</li>
            </ol>
        </x-filament::section>

        <x-filament::section heading="Create your first room — API-200">
            <div class="bc-example-grid">
                <div>
                    <h3>Request</h3>
                    <pre><code>POST /api/v1/partner/public-chat/rooms HTTP/1.1
Host: {{ $this->baseHost() }}
Content-Type: application/json
X-PChat-Key: &lt;your issued key_id&gt;
X-PChat-Timestamp: &lt;unix seconds&gt;
X-PChat-Nonce: &lt;fresh 16-64 char [A-Za-z0-9_-]&gt;
X-PChat-Signature: v1=&lt;hex hmac-sha256&gt;

{"customer_name":"Somchai Jaidee","provider_name":"Siam Fiber","external_ref":"TCK-48213","locale":"th"}</code></pre>
                </div>
                <div>
                    <h3>201 response</h3>
                    <pre><code>{
  "room": {
    "id": "01JQ8Z3M9WCT7XK2F5B6H4NRDV",
    "code": "30d6e93bd780a33e5382928166a8c46836b0d7cc01557caed354790fd4c5d1da",
    "status": "new",
    "customer_name": "Somchai Jaidee",
    "provider_name": "Siam Fiber",
    "external_ref": "TCK-48213",
    "locale": "th",
    "assigned_display_name": null,
    "created_at": "2026-09-22T10:00:00+00:00",
    "last_message_at": null,
    "closed_at": null,
    "expires_at": "2026-10-22T10:00:00+00:00"
  },
  "url": "{{ $this->baseUrl() }}/support/30d6e93bd780a33e5382928166a8c46836b0d7cc01557caed354790fd4c5d1da"
}</code></pre>
                </div>
            </div>
            <p style="margin-top:14px;font-size:13px;color:var(--bc-muted)">
                Save <code>room.id</code> — every later partner call addresses the room by that ULID, never
                by <code>code</code>. Sending the same <code>external_ref</code> again returns <code>200</code>
                with the same room, not a duplicate.
            </p>
        </x-filament::section>

        <x-filament::section heading="Signing your requests">
            <p style="font-size:13.5px;line-height:1.6">
                Four headers on every Tier 1 request: <code>X-PChat-Key</code>, <code>X-PChat-Timestamp</code>
                (unix seconds), <code>X-PChat-Nonce</code> (16–64 chars, <code>[A-Za-z0-9_-]</code>) and
                <code>X-PChat-Signature</code> (<code>v1=</code> + <strong>lowercase</strong> hex HMAC-SHA256 — the
                server compares case-sensitively). The signature covers this exact six-line, <code>\n</code>-joined
                string:
            </p>
            <pre style="margin-top:10px"><code>v1
&lt;METHOD, uppercase&gt;
&lt;request path, incl. /api/v1, excl. query string&gt;
&lt;X-PChat-Timestamp, after trimming whitespace&gt;
&lt;X-PChat-Nonce, after trimming whitespace&gt;
&lt;lowercase hex sha256 of the RAW request body bytes&gt;</code></pre>
            <p style="margin-top:10px;font-size:13px;color:var(--bc-muted)">
                The server trims surrounding whitespace off every header before using it — send them without
                any to avoid a mismatch. The single most common integration bug: hashing one serialisation of your JSON and sending
                another. Build the byte buffer once, hash that buffer, send that buffer — never
                re-serialise between signing and sending. Worked examples in Node/PHP/Python are in the
                full guide §4.
            </p>
        </x-filament::section>

        <x-filament::section heading="Common errors">
            <div class="bc-admin-table-wrap">
                <table class="bc-admin-table">
                    <thead><tr><th>Code</th><th>HTTP</th><th>Meaning</th><th>Action</th></tr></thead>
                    <tbody>
                        @foreach($this->commonErrors() as $e)
                            <tr>
                                <td><code>{{ $e['code'] }}</code></td>
                                <td>{{ $e['http'] }}</td>
                                <td>{{ $e['meaning'] }}</td>
                                <td>{{ $e['action'] }}</td>
                            </tr>
                        @endforeach
                    </tbody>
                </table>
            </div>
            <p style="margin-top:10px;font-size:13px;color:var(--bc-muted)">
                Full table of every error code, rate limits and a debugging flowchart in the guide §3.3, §6, §7.
            </p>
        </x-filament::section>

        <x-filament::section heading="Full reference & tools">
            <p style="font-size:13.5px;line-height:1.6">
                This page is a summary. The two downloads above (<strong>full guide</strong> and
                <strong>OpenAPI</strong>) are the complete, code-verified source — read them directly if
                you are an AI agent implementing this integration, or if you need the full endpoint,
                error and rate-limit reference. The full guide's package also ships signing examples in
                four languages and a runnable Bruno collection alongside it.
            </p>
            @php($meta = $this->guideMeta())
            @if($meta['exists'])
                <p style="margin-top:8px;font-size:12px;color:var(--bc-muted)">Guide last updated {{ $meta['updated_at'] }}.</p>
            @endif
        </x-filament::section>
    </div>
</x-filament-panels::page>
