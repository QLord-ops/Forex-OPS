import { defineConfig, devices } from '@playwright/test'

const localChromiumPath = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH
// Lets e2e/pwa.spec.ts cut the network for the service worker too (its own requests are not routed otherwise).
process.env.PW_EXPERIMENTAL_SERVICE_WORKER_NETWORK_EVENTS = '1'

export default defineConfig({
  testDir: './e2e',
  fullyParallel: true,
  forbidOnly: Boolean(process.env.CI),
  retries: process.env.CI ? 2 : 0,
  reporter: process.env.CI ? 'github' : 'list',
  use: {
    baseURL: 'http://127.0.0.1:4173',
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    // The production build registers a service worker; tests that mock /api run without it (e2e/pwa.spec.ts allows it).
    serviceWorkers: 'block',
  },
  projects: [
    {
      name: 'chromium',
      use: {
        ...devices['Desktop Chrome'],
        launchOptions: localChromiumPath ? { executablePath: localChromiumPath } : undefined,
      },
    },
  ],
  webServer: {
    command: 'npm run build -w @ops/web && npm run preview -w @ops/web',
    url: 'http://127.0.0.1:4173',
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
  },
})
