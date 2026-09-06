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
  ) {}

  async request<T>(path: string, options: RequestOptions = {}): Promise<T> {
    try {
      return await this.doRequest<T>(path, options);
    } catch (e) {
      if (e instanceof ApiError && e.status === 401 && !options._isRetry) {
        const refreshed = await this.tokens.refresh();
        if (refreshed !== null) {
          return this.doRequest<T>(path, { ...options, _isRetry: true });
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
