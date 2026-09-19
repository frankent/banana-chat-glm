import { existsSync } from 'node:fs';
import { defineConfig } from '@playwright/test';

const cachedChromium = '/home/frankent/.cache/ms-playwright/chromium-1223/chrome-linux64/chrome';
const executablePath = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH
  ?? (existsSync(cachedChromium) ? cachedChromium : undefined);

/** Deterministic frontend coverage: API and Reverb are synthetic, never production. */
export default defineConfig({
  testDir: './e2e/ui',
  timeout: 30_000,
  expect: { timeout: 7_000 },
  workers: 1,
  reporter: 'list',
  outputDir: 'e2e-artifacts/ui/test-results',
  use: {
    baseURL: 'http://127.0.0.1:5180',
    viewport: { width: 1440, height: 900 },
    launchOptions: { executablePath },
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  webServer: {
    command: 'node --run dev -- --host 127.0.0.1 --port 5180 --strictPort',
    url: 'http://127.0.0.1:5180',
    reuseExistingServer: !process.env.CI,
    env: { VITE_REVERB_APP_KEY: 'ui-fixture-key' },
  },
});
