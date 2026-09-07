import { test, expect } from './fixtures';

/**
 * Admin panel regression — Filament at :8000/admin (api container).
 * FR-ADM-001 login, FR-AI-014 AI Usage dashboard, provider list,
 * system settings, audit log.
 */

const ADMIN = 'http://localhost:8000/admin';

async function adminLogin(page: import('@playwright/test').Page): Promise<void> {
  await page.goto(`${ADMIN}/login`);
  // custom Filament login: statePath "data" ⇒ ids data.login / data.password
  // (users table has no email; data.totp left empty — admin has no TOTP secret)
  await page.fill('#data\\.login', 'admin');
  await page.fill('#data\\.password', 'Admin12345!');
  await page.click('button[type="submit"]');
  await expect(page).not.toHaveURL(/login$/, { timeout: 30_000 });
}

test('admin login → dashboard widgets render', async ({ page, shot }) => {
  await adminLogin(page);
  await shot(page, '01-admin-dashboard');
  await expect(page.locator('main')).toBeVisible();
});

test('AI Usage dashboard shows this month + provider health (FR-AI-014)', async ({ page, shot }) => {
  await adminLogin(page);
  await page.goto(`${ADMIN}/ai-usage`);
  await expect(page.getByRole('heading', { name: 'AI Usage' })).toBeVisible();
  await expect(page.getByText('Tokens in').first()).toBeVisible();
  await shot(page, '02-ai-usage');
  await expect(page.getByText('สุขภาพ model').first()).toBeVisible();
});

test('AI providers list shows the mock provider (FR-AI-011)', async ({ page, shot }) => {
  await adminLogin(page);
  await page.goto(`${ADMIN}/ai-providers`);
  await expect(page.getByText('Mock AI (regression)').first()).toBeVisible({ timeout: 15_000 });
  await shot(page, '03-providers');
});

test('audit log page renders (FR-AUD)', async ({ page, shot }) => {
  await adminLogin(page);
  await page.goto(`${ADMIN}/audit-logs`);
  await expect(page.locator('main')).toBeVisible();
  await shot(page, '04-audit-logs');
});

test('system settings page renders (FR-ADM-009)', async ({ page, shot }) => {
  await adminLogin(page);
  await page.goto(`${ADMIN}/settings`);
  await expect(page.locator('main')).toBeVisible();
  await shot(page, '05-settings');
});
