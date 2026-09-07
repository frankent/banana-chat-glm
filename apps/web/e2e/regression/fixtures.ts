import { test as base, expect, type Page } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SHOTS = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../e2e-artifacts/shots');
fs.mkdirSync(SHOTS, { recursive: true });

/**
 * FR-AUTH-002 rotates refresh tokens with reuse (theft) detection, so a
 * refresh token must NEVER be seeded into two pages — the second boot
 * trips reuse detection and REVOKES the whole session. Each uiLogin does
 * a fresh API login (own session), then seeds that session's refresh
 * token (DEC-011: `orgchat.refresh` in localStorage; the app mints its
 * own access token via /auth/refresh on boot).
 *
 * FR-AUTH-006 login throttling (5/min/IP, 10/15min/username) — a full
 * run stays under the per-username cap (~7 logins for tony incl. the
 * api.spec wrong-password test). A 429 is retried once after Retry-After.
 */
const API = 'http://localhost:8000/api/v1';

async function apiLogin(username: string, password: string): Promise<string> {
  let res = await fetch(`${API}/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username, password, platform: 'web', name: 'Playwright regression' }),
  });

  if (res.status === 429) {
    const wait = Math.min(Number(res.headers.get('retry-after') ?? 30), 65);
    await new Promise((r) => setTimeout(r, wait * 1000 + 500));
    res = await fetch(`${API}/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, password, platform: 'web', name: 'Playwright regression' }),
    });
  }

  if (res.status !== 200) {
    throw new Error(`api login ${username} → ${res.status}: ${await res.text()}`);
  }
  const { refresh_token: token } = await res.json();
  if (typeof token !== 'string' || token === '') {
    throw new Error(`api login ${username}: no refresh_token in response`);
  }

  return token;
}

export const test = base.extend<{
  shot: (page: Page, name: string) => Promise<void>;
  uiLogin: (page: Page, username: string, password: string) => Promise<void>;
}>({
  shot: async ({ }, use, testInfo) => {
    let n = 0;
    await use(async (page, name) => {
      n += 1;
      const file = `${testInfo.title.replace(/\W+/g, '-').slice(0, 40)}-${String(n).padStart(2, '0')}-${name}.png`;
      await page.screenshot({ path: path.join(SHOTS, file), fullPage: false });
    });
  },
  uiLogin: async ({ }, use) => {
    await use(async (page, username, password) => {
      const refresh = await apiLogin(username, password);
      // Seed ONLY when empty — addInitScript re-runs on every navigation and
      // re-seeding the (now rotated-out) token trips FR-AUTH-002 reuse
      // detection, revoking the session mid-test.
      await page.addInitScript((token: string) => {
        if (window.localStorage.getItem('orgchat.refresh') === null) {
          window.localStorage.setItem('orgchat.refresh', token);
        }
      }, refresh);
      await page.goto('/');
      await expect(page.locator('aside').first()).toBeVisible({ timeout: 30_000 });
    });
  },
});

export { expect };
