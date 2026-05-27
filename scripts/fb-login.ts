import { chromium } from "playwright";
import { mkdir } from "fs/promises";
import { dirname, resolve } from "path";
import * as readline from "readline";

const SESSION_PATH = resolve(process.cwd(), "data/fb-session.json");
const USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

async function main() {
  console.log("\n=== Facebook login session capture ===");
  console.log(`Session will be saved to: ${SESSION_PATH}`);
  console.log("Launching Chromium (headless: false)...");

  const browser = await chromium.launch({ headless: false });
  console.log("Browser launched. Creating context...");

  const context = await browser.newContext({
    userAgent: USER_AGENT,
    viewport: { width: 1280, height: 800 },
    locale: "en-US",
  });
  const page = await context.newPage();
  await page.bringToFront();

  console.log("Navigating to facebook.com...");
  try {
    await page.goto("https://www.facebook.com/", {
      waitUntil: "domcontentloaded",
      timeout: 30000,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.log(`Initial goto failed (${msg}). Retrying with no wait condition…`);
    await page.goto("https://www.facebook.com/", { timeout: 30000 });
  }
  console.log("Page loaded. Browser window should be visible.\n");

  console.log("==> Log in manually (including 2FA if prompted).");
  console.log("==> Then come back here and press Enter to save the session.\n");
  await waitForEnter();

  await mkdir(dirname(SESSION_PATH), { recursive: true });
  await context.storageState({ path: SESSION_PATH });

  console.log(`\nSession saved to ${SESSION_PATH}`);
  console.log("You can close this window. The scraper will reuse this session.\n");

  await browser.close();
}

function waitForEnter(): Promise<void> {
  return new Promise((resolve) => {
    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
    });
    rl.question("", () => {
      rl.close();
      resolve();
    });
  });
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
