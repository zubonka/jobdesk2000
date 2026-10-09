// Playwright config. Two kinds of tests:
// - flows.spec.mjs: user journeys against the dev server with the AI mock and the Firebase emulators,
//   on a desktop browser (Chromium) and on an iPhone 11 (WebKit, the engine of Safari on iOS);
// - layout.spec.mjs (@layout): every screen of the app on a matrix of phones, tablets and monitors, checked for
//   horizontal scrolling, clipped or overflowing content, unreadable text, small touch targets and overlaps.
import { defineConfig, devices } from "@playwright/test";

const BASE_URL = process.env.E2E_BASE_URL || "http://127.0.0.1:8888";

const android = (name, width, height, scale) => ({
  name,
  use: {
    browserName: "chromium",
    viewport: { width, height },
    deviceScaleFactor: scale,
    isMobile: true,
    hasTouch: true,
    userAgent: "Mozilla/5.0 (Linux; Android 15; Mobile) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0 Mobile Safari/537.36",
  },
});
const monitor = (name, width, height, scale = 1) => ({ name, use: { browserName: "chromium", viewport: { width, height }, deviceScaleFactor: scale } });

const LAYOUT_DEVICES = [
  { name: "iphone-11", use: { ...devices["iPhone 11"] } },
  { name: "iphone-11-landscape", use: { ...devices["iPhone 11 landscape"] } },
  { name: "iphone-15-pro", use: { ...devices["iPhone 15 Pro"] } },
  { name: "iphone-15-pro-max", use: { ...devices["iPhone 15 Pro Max"] } },
  android("galaxy-s24", 384, 832, 2.8125),
  android("pixel-7", 412, 915, 2.625),
  android("galaxy-small", 360, 740, 3),
  { name: "ipad-mini", use: { ...devices["iPad Mini"] } },
  { name: "ipad-pro-11", use: { ...devices["iPad Pro 11"] } },
  { name: "ipad-pro-11-landscape", use: { ...devices["iPad Pro 11 landscape"] } },
  monitor("laptop-1280", 1280, 720),
  monitor("laptop-1366", 1366, 768),
  monitor("desktop-1440", 1440, 900),
  monitor("desktop-1920", 1920, 1080),
  monitor("desktop-2560", 2560, 1440),
  monitor("monitor-4k", 3840, 2160),
  monitor("monitor-4k-hidpi", 1920, 1080, 2),
];

// In Docker (E2E_START_SERVER=1) the tests start the dev server themselves; on a workstation they use the one
// already running (npm run dev with MOCK_AI=1 and FIREBASE_EMULATORS=1).
const webServer = process.env.E2E_START_SERVER === "1"
  ? { command: "node ../scripts/dev-server.js", url: BASE_URL, reuseExistingServer: false, timeout: 30_000, stdout: "ignore", stderr: "pipe" }
  : undefined;

export default defineConfig({
  webServer,
  testDir: "./tests",
  outputDir: "./test-results",
  timeout: 90_000,
  expect: { timeout: 10_000 },
  workers: 4,
  reporter: [["list"], ["html", { open: "never", outputFolder: "report" }]],
  use: {
    baseURL: BASE_URL,
    locale: "uk-UA",
    timezoneId: "Europe/Kyiv",
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
  projects: [
    { name: "flows-desktop", testMatch: /flows\.spec/, use: { ...devices["Desktop Chrome"], viewport: { width: 1440, height: 900 } } },
    { name: "flows-iphone", testMatch: /flows\.spec/, use: { ...devices["iPhone 11"] } },
    ...LAYOUT_DEVICES.map((d) => ({ ...d, name: "layout-" + d.name, testMatch: /layout\.spec/ })),
  ],
});
