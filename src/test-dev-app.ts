/**
 * E2E test: Full Developer App setup via dev-app.ts module
 */

import { chromium } from "playwright";
import * as path from "path";
import * as os from "os";
import { setupDevApp } from "./dev-app";

const USER_DATA_DIR = path.join(os.homedir(), ".linkedin-agent", "chrome-data-test");
const LOGO_PATH = path.join(__dirname, "..", "assets", "default-logo.png");

async function main() {
  console.log("🚀 E2E: Developer App full setup test\n");

  const context = await chromium.launchPersistentContext(USER_DATA_DIR, {
    headless: false,
    args: ["--disable-blink-features=AutomationControlled"],
    viewport: { width: 1280, height: 900 },
    userAgent:
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
  });

  try {
    const result = await setupDevApp(context, LOGO_PATH);
    console.log("🎉 Setup complete!");
    console.log(`  App ID: ${result.appId}`);
    console.log(`  Client ID: ${result.clientId}`);
    console.log(`  Client Secret: ${result.clientSecret.substring(0, 15)}...`);

    console.log("\n  Browser stays open for 2 min.");
    const page = context.pages()[0];
    await page.waitForTimeout(120_000);
  } catch (err) {
    console.error("\n❌ Error:", err);
    const page = context.pages()[0];
    if (page) {
      await page.screenshot({ path: "/tmp/linkedin-dev-e2e-error.png", fullPage: true });
      console.log("  Error screenshot: /tmp/linkedin-dev-e2e-error.png");
      await page.waitForTimeout(30_000);
    }
  } finally {
    await context.close();
  }
}

main();
