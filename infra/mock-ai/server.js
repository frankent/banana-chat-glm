// TASK-INF-014 — mock OpenAI-compatible provider for dev/CI/load tests.
// Zero-dependency Node HTTP server implementing just enough of the API:
//   POST /v1/chat/completions  (stream + non-stream)
//   GET  /v1/models
//
// Failure injection via query params or env (env = default, ?key= overrides):
//   delay_ms=N          first-token delay (default 0)
//   delta_ms=N          per-delta delay (default 25)
//   error_1in=N         every Nth request → 500 provider error (0 = never)
//   overflow_1in=N      every Nth request → 400 context_length_exceeded
//   trunc_1in=N         every Nth stream ends without [DONE]
//   stream_tokens=N     tokens to stream (default 40)
//   status_429_1in=N    every Nth request → 429 rate limit
// Example: curl localhost:8787/v1/chat/completions?error_1in=2 ...
const http = require('http');

const envInt = (name, dflt) => {
  const v = parseInt(process.env[name] ?? '', 10);
  return Number.isFinite(v) ? v : dflt;
};

const OPTS = {
  delay_ms: envInt('MOCK_DELAY_MS', 0),
  delta_ms: envInt('MOCK_DELTA_MS', 25),
  error_1in: envInt('MOCK_ERROR_1IN', 0),
  overflow_1in: envInt('MOCK_OVERFLOW_1IN', 0),
  trunc_1in: envInt('MOCK_TRUNC_1IN', 0),
  status_429_1in: envInt('MOCK_STATUS_429_1IN', 0),
  stream_tokens: envInt('MOCK_STREAM_TOKENS', 40),
};

let counter = 0;

function pick(opts, url, key) {
  const q = url.searchParams.get(key);
  if (q !== null) {
    const v = parseInt(q, 10);
    if (Number.isFinite(v)) return v;
  }
  return opts[key];
}

const every = (n) => n > 0 && ++counter % n === 0;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const TOKENS = 'นี่คือการตอบกลับจาก mock provider เพื่อการทดสอบ streaming '.split(' ');

function json(res, code, body) {
  res.writeHead(code, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
}

async function handle(req, res) {
  const url = new URL(req.url, 'http://localhost');
  counter++;

  if (req.method === 'GET' && url.pathname.endsWith('/models')) {
    return json(res, 200, {
      object: 'list',
      data: [{ id: 'mock-glm' }, { id: 'mock-glm-mini' }],
    });
  }

  if (req.method === 'POST' && url.pathname.endsWith('/chat/completions')) {
    let body = '';
    for await (const chunk of req) body += chunk;

    if (every(pick(OPTS, url, 'error_1in'))) {
      return json(res, 500, { error: { message: 'mock injected failure', type: 'server_error' } });
    }
    if (every(pick(OPTS, url, 'status_429_1in'))) {
      return json(res, 429, { error: { message: 'mock rate limit', type: 'rate_limit_error' } });
    }
    if (every(pick(OPTS, url, 'overflow_1in'))) {
      return json(res, 400, {
        error: {
          message: "This model's maximum context length is 200000 tokens. However, you requested 231412 tokens.",
          type: 'invalid_request_error',
          code: 'context_length_exceeded',
        },
      });
    }

    let payload = {};
    try { payload = JSON.parse(body || '{}'); } catch { /* fall through */ }
    const isStream = payload.stream === true;
    const n = pick(OPTS, url, 'stream_tokens');
    const delay = pick(OPTS, url, 'delay_ms');
    const deltaMs = pick(OPTS, url, 'delta_ms');
    const trunc = every(pick(OPTS, url, 'trunc_1in'));

    if (!isStream) {
      await sleep(delay);
      const text = TOKENS.slice(0, Math.max(1, n)).join(' ');
      return json(res, 200, {
        id: 'chatcmpl-mock',
        object: 'chat.completion',
        choices: [{ index: 0, message: { role: 'assistant', content: text }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 42, completion_tokens: n, total_tokens: 42 + n },
      });
    }

    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    });
    await sleep(delay);
    const prompt = (payload.messages ?? []).map((m) => m.content).join(' ').length;

    for (let i = 0; i < n; i++) {
      res.write(`data: ${JSON.stringify({ id: 'chatcmpl-mock', choices: [{ index: 0, delta: { content: `${TOKENS[i % TOKENS.length]} ` } }] })}\n\n`);
      await sleep(deltaMs);
    }

    res.write(`data: ${JSON.stringify({ id: 'chatcmpl-mock', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] })}\n\n`);
    res.write(`data: ${JSON.stringify({ id: 'chatcmpl-mock', choices: [], usage: { prompt_tokens: Math.ceil(prompt / 3.5), completion_tokens: n, total_tokens: Math.ceil(prompt / 3.5) + n } })}\n\n`);

    if (!trunc) {
      res.write('data: [DONE]\n\n');
    }
    return res.end();
  }

  return json(res, 404, { error: { message: `no route: ${req.method} ${url.pathname}` } });
}

const server = http.createServer((req, res) => {
  handle(req, res).catch((e) => {
    try { json(res, 500, { error: { message: String(e) } }); } catch { /* headers sent */ }
  });
});

server.listen(envInt('PORT', 8787), () => {
  console.log(`mock-ai listening on :${envInt('PORT', 8787)} opts=${JSON.stringify(OPTS)}`);
});
