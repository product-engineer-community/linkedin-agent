import * as path from "path";
import * as os from "os";
import * as fs from "fs";
import { chromium, type BrowserContext } from "playwright";

const USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

export function getUserDataDir(): string {
  const dir = path.join(os.homedir(), ".linkedin-agent", "chrome-data");
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

export async function launchBrowser(userDataDir?: string): Promise<BrowserContext> {
  return chromium.launchPersistentContext(userDataDir || getUserDataDir(), {
    headless: false,
    args: ["--disable-blink-features=AutomationControlled"],
    viewport: { width: 1280, height: 900 },
    userAgent: USER_AGENT,
  });
}

export async function ensureLoggedIn(page: import("playwright").Page): Promise<void> {
  await page.goto("https://www.linkedin.com/feed/", { waitUntil: "domcontentloaded" });
  await page.waitForLoadState("networkidle").catch(() => {});
  await page.waitForTimeout(1500);

  const url = page.url();
  if (url.includes("/login") || url.includes("/authwall") || url.includes("/checkpoint")) {
    console.log("🔐 Login required. Please log in via the browser...");
    await page.waitForFunction(
      () => {
        const u = window.location.href;
        return !u.includes("/login") && !u.includes("/authwall") && !u.includes("/checkpoint");
      },
      undefined,
      { timeout: 300_000 },
    );
    await page.waitForLoadState("networkidle").catch(() => {});
    await page.waitForTimeout(1500);
  }
  console.log("✅ Session active.\n");
}
