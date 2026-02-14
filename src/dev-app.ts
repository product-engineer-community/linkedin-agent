/**
 * LinkedIn Developer App automation via Playwright
 *
 * Selector Strategy (resilience to UI changes):
 *  1. Semantic class names (.editable-block__update-btn, .editable-list__add-btn)
 *  2. Stable IDs (#createAppNameInput, #clientIdInput)
 *  3. ARIA/role attributes (role="combobox", aria-label)
 *  4. Icon types (li-icon[type="pencil-icon"])
 *  5. Placeholder text as last resort
 *
 * Input Strategy:
 *  - Always use keyboard.type() for Ember app compatibility
 *  - Use Playwright native click() instead of evaluate-based clicks
 *
 * Never rely on:
 *  - Ember dynamic IDs (#ember41, #ember79, etc.)
 *  - Text content (language-dependent)
 *  - Element index/position without context
 */

import { type Page, type BrowserContext } from "playwright";
import { ensureLoggedIn } from "./browser";

export interface DevAppResult {
  appId: string;
  clientId: string;
  clientSecret: string;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Try multiple selectors in order, return the first one that matches.
 * This provides resilience when LinkedIn changes one selector but not others.
 */
async function findElement(page: Page, selectors: string[], description: string) {
  for (const selector of selectors) {
    const loc = page.locator(selector).first();
    if ((await loc.count()) > 0 && (await loc.isVisible().catch(() => false))) {
      return loc;
    }
  }
  throw new Error(`Could not find: ${description}. Tried: ${selectors.join(", ")}`);
}

/**
 * Wait for page to settle (network idle + short delay).
 */
async function settle(page: Page, ms = 1500) {
  await page.waitForLoadState("networkidle").catch(() => {});
  await page.waitForTimeout(ms);
}

/**
 * Type into an input field using keyboard.type() for Ember compatibility.
 * Clears existing value first.
 */
async function typeInto(page: Page, selector: string, value: string) {
  const input = page.locator(selector).first();
  await input.click();
  await page.keyboard.press("Meta+a");
  await page.keyboard.press("Backspace");
  await page.keyboard.type(value, { delay: 30 });
}

// ---------------------------------------------------------------------------
// Step 1: Create Developer App
// ---------------------------------------------------------------------------

const DEFAULT_COMPANY_PAGE = "https://www.linkedin.com/company/103290544/";

export async function createDevApp(page: Page, logoPath: string, companyPageUrl?: string): Promise<string> {
  console.log("📝 Creating Developer App...");
  await page.goto("https://www.linkedin.com/developers/apps/new", { waitUntil: "domcontentloaded" });
  await settle(page);

  const url = page.url();
  if (!url.includes("/developers/apps")) {
    throw new Error(`Unexpected redirect: ${url}. Login may be required.`);
  }

  // App name — stable semantic ID, fallback to placeholder
  const appName = `social-agent-${Date.now().toString(36)}`;
  const nameInput = await findElement(page, [
    "#createAppNameInput",
    'input[placeholder*="app name" i]',
  ], "App name input");
  await nameInput.click();
  await page.keyboard.type(appName, { delay: 30 });
  console.log(`  App name: ${appName}`);

  // LinkedIn Page — typeahead accepts company name or page URL
  const companyQuery = companyPageUrl || DEFAULT_COMPANY_PAGE;
  const companyInput = await findElement(page, [
    "#associateCompanyTypeaheadInput",
    'input[role="combobox"]',
    'input[placeholder*="company" i]',
  ], "Company typeahead input");
  await companyInput.click();
  await page.keyboard.type(companyQuery, { delay: 20 });
  await page.waitForTimeout(3000);

  // Company may auto-select (shown as a card) or show a dropdown.
  // Check if already selected first (card with dismiss button appears, input disappears).
  const alreadySelected = await page.evaluate(() => {
    // A selected company shows as a card — the typeahead input gets hidden/removed
    const input = document.querySelector<HTMLInputElement>("#associateCompanyTypeaheadInput, input[role='combobox']");
    if (!input || !input.offsetParent) return true; // input gone = selected
    // Also check for a dismiss/remove button next to company name
    const dismissBtn = document.querySelector("button[aria-label*='dismiss' i], button[aria-label*='remove' i]");
    if (dismissBtn) return true;
    return false;
  });

  if (alreadySelected) {
    console.log(`  LinkedIn Page: auto-selected from ${companyQuery}`);
  } else {
    // Select first typeahead result from dropdown
    const typeaheadOption = await findElement(page, [
      '[role="option"]',
      ".basic-typeahead__selectable",
      ".search-typeahead-v2__hit",
      '[role="listbox"] li',
    ], "Typeahead option");
    await typeaheadOption.click();
    await page.waitForTimeout(500);
    console.log(`  LinkedIn Page: ${companyQuery}`);
  }

  // Privacy policy URL — stable semantic ID, fallback to placeholder
  const privacyInput = await findElement(page, [
    "#createAppPrivacyUrlInput",
    'input[placeholder*="http:// or https://" i]',
  ], "Privacy policy URL input");
  await privacyInput.click();
  await page.keyboard.type("https://example.com/privacy", { delay: 30 });
  console.log("  Privacy URL: set.");

  // App logo — file input
  const logoInput = await findElement(page, [
    'input[type="file"]',
    "#appLogoImageUpload",
  ], "Logo file input");
  await logoInput.setInputFiles(logoPath);
  await page.waitForTimeout(1000);
  console.log("  Logo: uploaded.");

  // Terms checkbox — click the <label> (Ember checkboxes intercept pointer on input)
  const termsLabel = page.locator('label:has-text("agree")').first();
  if ((await termsLabel.count()) > 0) {
    await termsLabel.click();
  } else {
    // Fallback: click any checkbox label near "terms"
    await page.evaluate(() => {
      const labels = Array.from(document.querySelectorAll("label"));
      const target = labels.find((l) => l.textContent?.toLowerCase().includes("agree"));
      target?.click();
    });
  }
  console.log("  Terms: accepted.");

  // Submit — data-control-name is stable, fallback to form submit button
  const createBtn = await findElement(page, [
    '[data-control-name="create_app_form_save_btn"]',
    'button[type="submit"][form="createAppForm"]',
    'button[type="submit"]:has-text("Create")',
  ], "Create app button");
  await createBtn.click();
  await settle(page, 5000);

  // Extract app ID from redirect URL
  const afterUrl = page.url();
  const appIdMatch = afterUrl.match(/\/apps\/(\d+)/);
  if (!appIdMatch) {
    throw new Error(`App creation may have failed. URL: ${afterUrl}`);
  }

  console.log(`  ✅ App created! ID: ${appIdMatch[1]}\n`);
  return appIdMatch[1];
}

// ---------------------------------------------------------------------------
// Step 2: Extract Credentials
// ---------------------------------------------------------------------------

export async function extractCredentials(page: Page, appId: string): Promise<{ clientId: string; clientSecret: string }> {
  console.log("🔑 Extracting credentials...");
  await page.goto(`https://www.linkedin.com/developers/apps/${appId}/auth`, { waitUntil: "domcontentloaded" });
  await settle(page);

  // Client ID — stable semantic ID
  const clientId = await page.locator("#clientIdInput").first().inputValue().catch(async () => {
    // Fallback: find input near "Client ID" label
    return page.evaluate(() => {
      const labels = Array.from(document.querySelectorAll("label, span, div"));
      for (const label of labels) {
        if (label.textContent?.trim() === "Client ID:") {
          const input = label.parentElement?.querySelector("input");
          if (input) return input.value;
        }
      }
      return "";
    });
  });

  // Client Secret — stable semantic ID, need to reveal first
  let clientSecret = "";
  const secretInput = page.locator("#primaryClientSecret").first();
  if ((await secretInput.count()) > 0) {
    clientSecret = await secretInput.inputValue();
  }

  if (!clientId) throw new Error("Could not extract Client ID");
  if (!clientSecret) throw new Error("Could not extract Client Secret");

  console.log(`  Client ID: ${clientId}`);
  console.log(`  Client Secret: ${clientSecret.substring(0, 10)}...`);
  console.log("  ✅ Credentials extracted.\n");

  return { clientId, clientSecret };
}

// ---------------------------------------------------------------------------
// Step 3: Configure Redirect URI
// ---------------------------------------------------------------------------

export async function configureRedirectUri(page: Page, appId: string, redirectUri: string): Promise<void> {
  console.log("🔧 Configuring redirect URI...");
  await page.goto(`https://www.linkedin.com/developers/apps/${appId}/auth`, { waitUntil: "domcontentloaded" });
  await settle(page);

  // Check if URI already exists
  const alreadyConfigured = await page.evaluate((uri) => {
    return document.body.textContent?.includes(uri) ?? false;
  }, redirectUri);

  if (alreadyConfigured) {
    console.log(`  Already configured: ${redirectUri}`);
    console.log("  ✅ Skipped.\n");
    return;
  }

  // Find the editable block containing "redirect" and click its edit button
  // Strategy: find the section by heading text, then find the pencil button inside the same form/block
  const editClicked = await page.evaluate(() => {
    // Find all form/editable-block containers
    const blocks = Array.from(document.querySelectorAll("form"));
    for (const block of blocks) {
      const heading = block.querySelector("h3, h4");
      if (heading?.textContent?.toLowerCase().includes("redirect")) {
        // Find edit button: look for pencil icon button or edit-btn class
        const editBtn =
          block.querySelector(".editable-block__edit-btn--enabled") ||
          block.querySelector('.editable-block__edit-btn button') ||
          block.querySelector('button:has(li-icon[type="pencil-icon"])') ||
          block.querySelector("button");
        if (editBtn) {
          (editBtn as HTMLElement).click();
          return true;
        }
      }
    }
    return false;
  });

  if (!editClicked) throw new Error("Could not find redirect URI edit button");
  await page.waitForTimeout(1000);
  console.log("  Edit mode entered.");

  // Click "+ Add redirect URL" — semantic class is most stable
  const addBtn = await findElement(page, [
    ".editable-list__add-btn",
    'button:has(li-icon[type="plus-icon"])',
  ], "Add redirect URL button");
  await addBtn.click();
  await page.waitForTimeout(1000);
  console.log("  Add button clicked.");

  // Fill the input — scope to editable-list container
  const input = await findElement(page, [
    '.editable-list__entry-container input[type="text"]',
    'input[placeholder*="http"]',
  ], "Redirect URL input");
  await input.click();
  await page.keyboard.type(redirectUri, { delay: 30 });
  await page.waitForTimeout(500);
  console.log(`  Typed: ${redirectUri}`);

  // Click Update — semantic class
  const updateBtn = await findElement(page, [
    ".editable-block__update-btn",
    'button[type="submit"]:visible',
  ], "Update button");
  await updateBtn.click();
  await settle(page, 3000);

  // Verify save succeeded (no Cancel button means we exited edit mode)
  const stillEditing = (await page.locator(".editable-block__cancel-btn").count()) > 0;
  if (stillEditing) {
    throw new Error("Redirect URI save failed — still in edit mode");
  }

  console.log("  ✅ Redirect URI saved.\n");
}

// ---------------------------------------------------------------------------
// Step 4: Request Products
// ---------------------------------------------------------------------------

export async function requestProducts(page: Page, appId: string, productNames: string[]): Promise<void> {
  console.log("📦 Requesting products...");

  for (const productName of productNames) {
    await page.goto(`https://www.linkedin.com/developers/apps/${appId}/products`, { waitUntil: "domcontentloaded" });
    await settle(page);

    // Check if product is already in "Added products" section
    const alreadyAdded = await page.evaluate((name) => {
      // "Added products" section appears at the top when products are added
      const addedSection = Array.from(document.querySelectorAll("h2, h3")).find(
        (h) => h.textContent?.toLowerCase().includes("added"),
      );
      if (addedSection) {
        const parent = addedSection.closest("div, section");
        if (parent?.textContent?.includes(name)) return true;
      }
      return false;
    }, productName);

    if (alreadyAdded) {
      console.log(`  ${productName}: already added.`);
      continue;
    }

    // Find the product card and its "Request access" button
    // Strategy: find h2 with product name, walk up to card, find button
    const clicked = await page.evaluate((name) => {
      const headings = Array.from(document.querySelectorAll("h2, h3, h4"));
      for (const h of headings) {
        if (h.textContent?.trim() === name) {
          // Walk up to find the product card container
          let el: HTMLElement | null = h as HTMLElement;
          for (let i = 0; i < 8 && el; i++) {
            el = el.parentElement;
            if (el) {
              const btn = el.querySelector("button");
              if (btn?.textContent?.trim() === "Request access") {
                btn.click();
                return true;
              }
            }
          }
        }
      }
      return false;
    }, productName);

    if (!clicked) {
      console.log(`  ${productName}: not found or no "Request access" button.`);
      continue;
    }

    await page.waitForTimeout(2000);

    // Handle modal (terms agreement)
    const modal = page.locator('[role="dialog"]').first();
    if ((await modal.count()) > 0 && (await modal.isVisible())) {
      // Accept terms — click label (avoid Ember checkbox interception)
      const label = modal.locator("label").first();
      if ((await label.count()) > 0) {
        await label.click();
        await page.waitForTimeout(300);
      }

      // Confirm — find submit/confirm button inside modal
      const confirmClicked = await page.evaluate(() => {
        const modal = document.querySelector('[role="dialog"]');
        if (!modal) return false;
        const btns = Array.from(modal.querySelectorAll("button"));
        const confirmBtn = btns.find((b) => {
          const t = b.textContent?.trim() || "";
          return t.includes("Request access") || t.includes("Submit") || t.includes("Agree");
        });
        if (confirmBtn) { confirmBtn.click(); return true; }
        return false;
      });

      if (confirmClicked) {
        await settle(page, 3000);
        console.log(`  ${productName}: ✅ requested.`);
      } else {
        console.log(`  ${productName}: ⚠️ modal appeared but could not confirm.`);
      }
    } else {
      console.log(`  ${productName}: ✅ auto-approved (no modal).`);
    }
  }

  console.log("");
}

// ---------------------------------------------------------------------------
// Step 5: Verify Scopes
// ---------------------------------------------------------------------------

export async function verifyScopes(page: Page, appId: string): Promise<string[]> {
  console.log("🔍 Verifying OAuth scopes...");
  await page.goto(`https://www.linkedin.com/developers/apps/${appId}/auth`, { waitUntil: "domcontentloaded" });
  await settle(page);

  const scopes = await page.evaluate(() => {
    const results: string[] = [];
    // Scopes are bold text (scope name) + description in the scopes section
    const blocks = Array.from(document.querySelectorAll("div, section"));
    for (const block of blocks) {
      const heading = block.querySelector("h2, h3");
      if (heading?.textContent?.toLowerCase().includes("scope")) {
        // Find scope name elements (bold text)
        const scopeEls = Array.from(block.querySelectorAll("b, strong, [class*='bold']"));
        for (const el of scopeEls) {
          const name = el.textContent?.trim() || "";
          if (name && !name.includes("scope") && !name.includes("OAuth") && name.length < 30) {
            results.push(name);
          }
        }
        break;
      }
    }
    return results;
  });

  if (scopes.length > 0) {
    console.log("  Scopes:");
    for (const s of scopes) console.log(`    ✅ ${s}`);
  } else {
    console.log("  ⚠️ No scopes detected (products may need approval time).");
  }

  console.log("");
  return scopes;
}

// ---------------------------------------------------------------------------
// Full Flow: Create + Configure
// ---------------------------------------------------------------------------

const REQUIRED_PRODUCTS = [
  "Share on LinkedIn",
  "Sign In with LinkedIn using OpenID Connect",
];

const REDIRECT_URI = "http://localhost:3000/callback";

export async function setupDevApp(
  context: BrowserContext,
  logoPath: string,
  companyPageUrl?: string,
): Promise<DevAppResult> {
  const page = context.pages()[0] || (await context.newPage());
  await ensureLoggedIn(page);

  const appId = await createDevApp(page, logoPath, companyPageUrl);
  const creds = await extractCredentials(page, appId);
  await configureRedirectUri(page, appId, REDIRECT_URI);
  await requestProducts(page, appId, REQUIRED_PRODUCTS);
  await verifyScopes(page, appId);

  return { appId, clientId: creds.clientId, clientSecret: creds.clientSecret };
}
