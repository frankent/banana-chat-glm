import { describe, expect, it, vi } from 'vitest';
import { ApiClient } from '../src/client.js';
import { ApiError, NetworkError } from '../src/error.js';
import { TokenManager } from '../src/token-manager.js';

function memoryStore() {
  let token: string | null = null;
  return {
    getRefreshToken: () => token,
    setRefreshToken: (t: string | null) => {
      token = t;
    },
  };
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

describe('TC-CORE-012 envelope unwrap', () => {
  it('unwraps {data} success envelopes', async () => {
    const tokens = new TokenManager('/api/v1/auth/refresh', memoryStore());
    tokens.setTokens('access-1', 'refresh-1');
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse(200, { data: { hello: 'world' } }));
    const api = new ApiClient('http://x', tokens, fetchImpl as unknown as typeof fetch);

    await expect(api.request('/api/v1/workspace', { workspaceSlug: 'acme' })).resolves.toEqual({ hello: 'world' });
    expect(fetchImpl.mock.calls[0]![1].headers['X-Workspace-Id']).toBe('acme');
    expect(fetchImpl.mock.calls[0]![1].headers.Authorization).toBe('Bearer access-1');
  });

  it('turns error envelopes into ApiError with code + request_id', async () => {
    const tokens = new TokenManager('/api/v1/auth/refresh', memoryStore());
    const api = new ApiClient('http://x', tokens, vi.fn().mockResolvedValue(
      jsonResponse(422, { error: { code: 'MSG_TOO_LONG', message: 'ยาวเกิน', request_id: 'rid-1' } }),
    ) as unknown as typeof fetch);

    const err = await api.request<ApiError>('/api/v1/rooms/r/messages', { method: 'POST' }).catch((e) => e as ApiError);
    expect(err).toBeInstanceOf(ApiError);
    expect(err.status).toBe(422);
    expect(err.code).toBe('MSG_TOO_LONG');
    expect(err.requestId).toBe('rid-1');
  });

  it('network failure → NetworkError', async () => {
    const tokens = new TokenManager('/api/v1/auth/refresh', memoryStore());
    const api = new ApiClient('http://x', tokens, vi.fn().mockRejectedValue(new TypeError('fetch failed')) as unknown as typeof fetch);

    const err = await api.request<never>('/x').catch((e) => e as ApiError);
    expect(err).toBeInstanceOf(NetworkError);
  });
});

describe('TC-CORE-013 refresh single-flight', () => {
  it('concurrent 401s share one refresh request and retry once', async () => {
    const store = memoryStore();
    let refreshCalls = 0;
    let apiCalls = 0;
    const fetchImpl = vi.fn(async (url: string, init?: RequestInit): Promise<Response> => {
      if (url.endsWith('/auth/refresh')) {
        refreshCalls += 1;
        return jsonResponse(200, { access_token: 'fresh-access', refresh_token: 'refresh-2' });
      }
      apiCalls += 1;
      const auth = (init?.headers as Record<string, string>).Authorization;
      return auth === 'Bearer stale-access'
        ? jsonResponse(401, { error: { code: 'AUTH_TOKEN_EXPIRED', message: 'expired', request_id: null } })
        : jsonResponse(200, { data: { ok: true } });
    });

    const tokens = new TokenManager('http://x/api/v1/auth/refresh', store, fetchImpl as unknown as typeof fetch);
    tokens.setTokens('stale-access', 'refresh-1');

    const api = new ApiClient('http://x', tokens, fetchImpl as unknown as typeof fetch);
    const [a, b] = await Promise.all([
      api.request('/api/v1/rooms'),
      api.request('/api/v1/me'),
    ]);

    expect(a).toEqual({ ok: true });
    expect(b).toEqual({ ok: true });
    expect(refreshCalls).toBe(1);
    expect(apiCalls).toBe(4); // 2 initial 401s + 2 retries
    expect(tokens.getAccessToken()).toBe('fresh-access');
    expect(store.getRefreshToken()).toBe('refresh-2');
  });

  it('refresh failure clears tokens and surfaces the 401', async () => {
    const store = memoryStore();
    const fetchImpl = vi.fn(async (url: string): Promise<Response> =>
      url.endsWith('/auth/refresh')
        ? jsonResponse(401, { error: { code: 'AUTH_REFRESH_REUSED', message: 'reused', request_id: null } })
        : jsonResponse(401, { error: { code: 'AUTH_TOKEN_INVALID', message: 'invalid', request_id: null } }),
    );

    const tokens = new TokenManager('http://x/api/v1/auth/refresh', store, fetchImpl as unknown as typeof fetch);
    tokens.setTokens('stale', 'dead-refresh');

    const api = new ApiClient('http://x', tokens, fetchImpl as unknown as typeof fetch);
    const err = await api.request<ApiError>('/api/v1/me').catch((e) => e as ApiError);

    expect(err).toBeInstanceOf(ApiError);
    expect(tokens.isLoggedIn()).toBe(false);
  });
});
