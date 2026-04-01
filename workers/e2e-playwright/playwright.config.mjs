import { defineConfig } from '@playwright/test';

const APP_BASE_URL = process.env.APP_BASE_URL || 'https://app-sssaham.mkemalw.workers.dev';
const API_BASE_URL = process.env.API_BASE_URL || 'https://api-saham.mkemalw.workers.dev';

export default defineConfig({
  testDir: './tests',
  timeout: 60_000,
  expect: {
    timeout: 10_000
  },
  fullyParallel: false,
  retries: process.env.CI ? 1 : 0,
  reporter: [
    ['list'],
    ['html', { open: 'never' }]
  ],
  use: {
    baseURL: APP_BASE_URL,
    trace: 'on-first-retry',
    screenshot: 'only-on-failure',
    video: 'retain-on-failure'
  },
  projects: [
    {
      name: 'chromium',
      use: {
        browserName: 'chromium'
      }
    }
  ]
});
