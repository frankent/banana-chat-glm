import { ApiError, NetworkError } from './error.js';
import type { TokenManager } from './token-manager.js';

interface RequestOptions {
  method?: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE';
  body?: unknown;
  workspaceSlug?: string | null;
  /** internal: prevent infinite refresh loop */
  _isRetry?: boolean;
}

/**
 * Typed fetch wrapper for the /api/v1 surface. Unwraps {data} envelopes,
 * turns §7 error envelopes into ApiError, retries once after a refresh on 401.
 */
export class ApiClient {
  constructor(
    private readonly baseUrl: string,
    private readonly tokens: TokenManager,
    private readonly fetchImpl: typeof fetch = fetch.bind(globalThis),
    /** extra headers on every request — e.g. mobile X-App-Version (BE-025) */
    private readonly extraHeaders: () => Record<string, string> = () => ({}),
    /**
     * R8 — fired for every error this method throws, including one that
     * escapes the 401-retry branch below. A caller wires this to its own
     * navigation/state (e.g. the 426 APP_UPDATE_REQUIRED gate) instead of
     * requiring every call site to check for it individually.
     *
     * KNOWN GAP: TokenManager.doRefresh() hits the refresh endpoint over a
     * raw fetch, not through this method — a 426 on /auth/refresh itself
     * (rather than on the request that triggered the refresh) never reaches
     * this observer. See REVIEW.md R8.
     */
    private readonly onError: (e: unknown) => void = () => {},
  ) {}

  async request<T>(path: string, options: RequestOptions = {}): Promise<T> {
    try {
      return await this.requestInner<T>(path, options);
    } catch (e) {
      this.onError(e);
      throw e;
    }
  }

  private async requestInner<T>(path: string, options: RequestOptions = {}): Promise<T> {
    const epoch = this.tokens.sessionEpoch;
    const current = () => { if (epoch !== this.tokens.sessionEpoch) throw new Error('Session changed'); };
    try {
      const result = await this.doRequest<T>(path, options);
      current();
      return result;
    } catch (e) {
      current();
      if (e instanceof ApiError && e.status === 401 && !options._isRetry) {
        const refreshed = await this.tokens.refresh();
        if (refreshed !== null) {
          current();
          const result = await this.doRequest<T>(path, { ...options, _isRetry: true });
          current();
          return result;
        }
      }
      throw e;
    }
  }

  private async doRequest<T>(path: string, options: RequestOptions): Promise<T> {
    const headers: Record<string, string> = { Accept: 'application/json' };

    const token = this.tokens.getAccessToken();
    if (token !== null) {
      headers.Authorization = `Bearer ${token}`;
    }
    if (options.workspaceSlug !== undefined && options.workspaceSlug !== null) {
      headers['X-Workspace-Id'] = options.workspaceSlug;
    }
    if (options.body !== undefined) {
      headers['Content-Type'] = 'application/json';
    }
    for (const [key, value] of Object.entries(this.extraHeaders())) {
      headers[key] = value;
    }

    let response: Response;
    try {
      response = await this.fetchImpl(this.baseUrl + path, {
        method: options.method ?? 'GET',
        headers,
        body: options.body !== undefined ? JSON.stringify(options.body) : undefined,
      });
    } catch (e) {
      throw new NetworkError(e);
    }

    if (response.status === 204) {
      return undefined as T;
    }

    const text = await response.text();
    const body = text !== '' ? JSON.parse(text) : null;

    if (!response.ok) {
      throw new ApiError(response.status, body?.error ?? { code: 'HTTP_ERROR', message: response.statusText, request_id: null });
    }

    // §7 success envelope {data, meta?} → unwrap; bare objects (auth) pass through
    return (body && typeof body === 'object' && 'data' in body && body.data !== null && !('error' in body) ? body.data : body) as T;
  }
}
