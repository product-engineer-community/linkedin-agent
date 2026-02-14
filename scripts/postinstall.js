#!/usr/bin/env node
const { execSync } = require("child_process");

try {
  // Check if chromium is already installed
  execSync("npx playwright install chromium --dry-run", { stdio: "pipe" });
  console.log("Playwright Chromium already installed.");
} catch {
  console.log("Installing Playwright Chromium...");
  execSync("npx playwright install chromium", { stdio: "inherit" });
}
