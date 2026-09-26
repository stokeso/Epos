import { defineConfig } from '@playwright/test';

const executablePath = process.env.PW_CHROMIUM_PATH ?? '/opt/pw-browsers/chromium';
// PW_PORT lets several agents run the suite side by side; each gets its own build folder.
const port = Number(process.env.PW_PORT ?? 4173);
const outDir = port === 4173 ? 'dist' : `dist-e2e-${port}`;

export default defineConfig({
  testDir: 'tests/e2e',
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 60_000,
  reporter: [['list']],
  use: {
    baseURL: `http://localhost:${port}`,
    trace: 'retain-on-failure',
    launchOptions: { executablePath },
  },
  projects: [
    { name: 'tablet-landscape', use: { viewport: { width: 1280, height: 800 }, hasTouch: true } },
    { name: 'phone-portrait', use: { viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true } },
  ],
  webServer: {
    command: `npx vite build --outDir ${outDir} --emptyOutDir && npx vite preview --outDir ${outDir} --port ${port} --strictPort`,
    url: `http://localhost:${port}`,
    reuseExistingServer: !process.env.CI,
    timeout: 180_000,
  },
});
