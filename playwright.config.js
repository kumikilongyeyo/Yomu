// @ts-check
/**
 * Runtime gauntlet configuration.
 *
 * The old release gates grepped source files and reported 10/10 while the
 * screenshots in Yomu_Recovery_Spec showed duplicate controls in production.
 * These tests drive the real export in a real browser instead. Every project
 * below is a required viewport from the spec's coverage table.
 */
import { defineConfig, devices } from '@playwright/test';

const PORT = Number(process.env.YOMU_FIXTURE_PORT || 4173);
const BASE = process.env.YOMU_BASE_URL || `http://127.0.0.1:${PORT}`;
const external = !!process.env.YOMU_BASE_URL;

export default defineConfig({
  testDir: './tests',
  testMatch: /.*\.spec\.js/,
  fullyParallel: false,
  workers: 1,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  timeout: 90_000,
  expect: { timeout: 15_000, toHaveScreenshot: { maxDiffPixelRatio: 0.012 } },
  reporter: process.env.CI
    ? [['list'], ['html', { open: 'never', outputFolder: 'playwright-report' }], ['json', { outputFile: 'playwright-report/results.json' }]]
    : [['list'], ['json', { outputFile: 'playwright-report/results.json' }]],
  use: {
    baseURL: BASE,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    video: 'off',
  },
  projects: [
    { name: 'desktop-1440', use: { ...devices['Desktop Chrome'], viewport: { width: 1440, height: 900 } } },
    { name: 'desktop-1920', use: { ...devices['Desktop Chrome'], viewport: { width: 1920, height: 1080 } } },
    { name: 'compact-1280', use: { ...devices['Desktop Chrome'], viewport: { width: 1280, height: 800 } } },
    { name: 'tablet-768', use: { ...devices['Desktop Chrome'], viewport: { width: 768, height: 1024 } } },
    { name: 'phone-390', use: { ...devices['Desktop Chrome'], viewport: { width: 390, height: 844 }, isMobile: false } },
    {
      name: 'reduced-motion',
      use: { ...devices['Desktop Chrome'], viewport: { width: 1440, height: 900 }, contextOptions: { reducedMotion: 'reduce' } },
    },
  ],
  webServer: external ? undefined : {
    command: `node tests/fixtures/server.mjs`,
    env: { PORT: String(PORT) },
    url: `http://127.0.0.1:${PORT}/yomu-library.css`,
    reuseExistingServer: !process.env.CI,
    timeout: 60_000,
  },
});
