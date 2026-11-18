import { defineConfig, devices } from '@playwright/test';

/**
 * End-to-end tests run against the production build (vite preview, with the production
 * security headers), on the three viewports the app is designed for: Pixel 7, iPhone 14
 * and a 1440 px desktop. Golden-file visual tests (golden.spec.ts) run on the desktop
 * project; the throttled performance checks (perf.spec.ts) on Pixel 7.
 *
 * iPhone 14 runs in real WebKit (Safari's engine) on CI and when PW_WEBKIT=1. Playwright's
 * WebKit build does not start on some Windows machines; there the project uses Chromium
 * with the exact iPhone 14 screen, pixel ratio, touch and user agent.
 */
const iphoneEngine = process.env.PW_WEBKIT === '1' || process.env.CI ? 'webkit' : 'chromium';

export default defineConfig({
  testDir: './tests/e2e',
  outputDir: './test-results',
  // Golden PNGs live next to the tests, one folder per OS (font rasterisation differs slightly).
  snapshotPathTemplate: '{testDir}/golden/{platform}/{arg}{ext}',
  timeout: 150_000,
  expect: { timeout: 20_000 },
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  workers: process.env.CI ? 2 : 3,
  reporter: [['list'], ['html', { open: 'never' }]],
  use: {
    baseURL: 'http://localhost:4391',
    trace: 'retain-on-failure',
    acceptDownloads: true,
  },
  projects: [
    { name: 'pixel-7', use: { ...devices['Pixel 7'] }, testIgnore: /golden\.spec\.ts|_look/ },
    { name: 'iphone-14', use: { ...devices['iPhone 14'], browserName: iphoneEngine }, testIgnore: /golden\.spec\.ts|perf\.spec\.ts|_look/ },
    { name: 'desktop-1440', use: { ...devices['Desktop Chrome'], viewport: { width: 1440, height: 900 } }, testIgnore: /perf\.spec\.ts|_look/ },
  ],
  webServer: {
    command: 'npm run build && npm run preview',
    url: 'http://localhost:4391',
    reuseExistingServer: !process.env.CI,
    timeout: 240_000,
  },
});
