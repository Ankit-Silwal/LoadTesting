import { defineConfig } from '@playwright/test';
export default defineConfig({
  testDir: './e2e',
  fullyParallel: false,
  workers: 1,
  retries: process.env.CI ? 1 : 0,
  use: { baseURL: 'http://127.0.0.1:4399', channel: process.env.PLAYWRIGHT_CHANNEL || undefined, headless: true, viewport: { width:1440,height:1100 }, screenshot:'only-on-failure', trace:'retain-on-failure' },
  webServer: { command:'node packages/cli/src/index.js web --port 4399 --out test-results/logs', url:'http://127.0.0.1:4399', reuseExistingServer:false, timeout:15000 },
});
