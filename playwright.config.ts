import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  testDir: "test/e2e",
  testMatch: "*.spec.ts",
  fullyParallel: false,
  workers: 1,
  snapshotPathTemplate: "{testDir}/__screenshots__/{testFilePath}/{arg}{ext}",
  expect: {
    toHaveScreenshot: {
      maxDiffPixels: 0,
      animations: "disabled",
      caret: "hide",
    },
  },
  use: {
    baseURL: "http://localhost:4173",
    viewport: { width: 1280, height: 800 },
    deviceScaleFactor: 1,
    colorScheme: "dark",
  },
  projects: [
    {
      name: "chromium",
      use: {
        ...devices["Desktop Chrome"],
        viewport: { width: 1280, height: 800 },
        deviceScaleFactor: 1,
      },
    },
  ],
  webServer: {
    command: "pnpm e2e:server",
    url: "http://localhost:4173/healthz",
    reuseExistingServer: false,
    timeout: 120_000,
  },
});
