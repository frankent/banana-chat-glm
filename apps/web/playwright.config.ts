import { defineConfig, devices } from '@playwright/test';

/**
 * Regression suite (TC-WEB-E2E umbrella) against the live dev stack:
 *   web :5173 (Vite) → api :8000 (docker) → reverb :8088 (docker)
 *   admin panel :8000/admin (Filament, same api container)
 *
 * Run from apps/web:  npx playwright test
 * Artifacts land in   e2e-artifacts/  (screenshots per step + zip)
 */
export default defineConfig({
  testDir: './e2e/regression',
  timeout: 60_000,
  expect: { timeout: 10_000 },
  fullyParallel: false, // same seed data + login rate limiter (5/min/IP)
  workers: 1,
  retries: 0,
  reporter: [['list'], ['json', { outputFile: 'e2e-artifacts/report.json' }], ['html', { outputFolder: 'e2e-artifacts/html', open: 'never' }]],
  outputDir: 'e2e-artifacts/test-results',
  use: {
    baseURL: 'http://localhost:5173',
    trace: 'retain-on-failure',
    screenshot: 'off', // explicit shots per step (below)
    actionTimeout: 10_000,
    locale: 'th-TH',
  },
  projects: [
    { name: 'chromium', use: { ...devices['Desktop Chrome'] } },
  ],
});
