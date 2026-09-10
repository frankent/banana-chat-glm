/**
 * DEC-011 — refresh token in localStorage, access token in memory.
 * Single-flight: concurrent 401s share one refresh promise.
 */
export interface TokenStore {
  getRefreshToken(): string | null;
  setRefreshToken(token: string | null): void;
}

export class TokenManager {
  private epoch = 0;

  get sessionEpoch(): number { return this.epoch; }

  private accessToken: string | null = null;
  private refreshInFlight: Promise<string | null> | null = null;

  constructor(
    private readonly refreshUrl: string,
    private readonly store: TokenStore,
    private readonly fetchImpl: typeof fetch = fetch.bind(globalThis),
  ) {}

  getAccessToken(): string | null {
    return this.accessToken;
  }

  setTokens(access: string, refresh: string | null): void {
    this.accessToken = access;
    if (refresh !== null) {
      this.store.setRefreshToken(refresh);
    }
  }

  clear(): void {
    this.epoch += 1;
    this.refreshInFlight = null;
    this.accessToken = null;
    this.store.setRefreshToken(null);
  }

  isLoggedIn(): boolean {
    return this.store.getRefreshToken() !== null;
  }

  /**
   * Rotate the refresh token. Concurrent callers share one request; a failure
   * clears state and returns null (caller treats as logged out).
   */
  refresh(): Promise<string | null> {
    if (!this.refreshInFlight) {
      const request = this.doRefresh().finally(() => {
        if (this.refreshInFlight === request) this.refreshInFlight = null;
      });
      this.refreshInFlight = request;
    }
    return this.refreshInFlight;
  }

  private async doRefresh(): Promise<string | null> {
    const epoch = this.epoch;
    const refreshToken = this.store.getRefreshToken();
    if (refreshToken === null) {
      return null;
    }

    try {
      const response = await this.fetchImpl(this.refreshUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify({ refresh_token: refreshToken }),
      });

      if (epoch !== this.epoch) return null;
      if (!response.ok) {
        this.clear();
        return null;
      }

      const body = (await response.json()) as { access_token: string; refresh_token: string };
      if (epoch !== this.epoch) return null;
      this.setTokens(body.access_token, body.refresh_token);
      return body.access_token;
    } catch {
      return null;
    }
  }
}
