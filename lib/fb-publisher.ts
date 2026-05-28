import { chromium, type Browser, type Page } from "playwright";
import { existsSync } from "fs";
import { mkdir } from "fs/promises";
import { resolve } from "path";

const USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";

const SESSION_PATH = resolve(process.cwd(), "data/fb-session.json");
const DEBUG_DIR = resolve(process.cwd(), "data/debug");
const DEADLINE_MS = 90_000;

const FB_CONDITIONS: Record<string, string> = {
  new: "New",
  like_new: "Used - Like New",
  good: "Used - Good",
  fair: "Used - Fair",
  poor: "Used - Poor",
};

// Exact top-level category text as FB renders it (verified from live DOM).
// Sub is a subcategory label to click if a second panel appears after
// selecting the top-level; null means stop at the top level.
const CATEGORY_HIERARCHY: [RegExp, [string, string | null]][] = [
  // Most-specific electronics first so headphones don't fall to the generic bucket
  [/headphone|earbud|earphone|airpod/i,                      ["Electronics & computers", "Headphones"]],
  [/iphone|android|smartphone|cell.?phone|mobile.?phone/i,   ["Mobile phones", null]],
  [/laptop|notebook|macbook/i,                               ["Electronics & computers", "Computers & tablets"]],
  [/tablet|ipad/i,                                           ["Electronics & computers", "Computers & tablets"]],
  [/tv\b|television|monitor|projector/i,                     ["Electronics & computers", "TV & video"]],
  [/camera|dslr|mirrorless|camcorder/i,                      ["Electronics & computers", "Cameras"]],
  [/playstation|xbox|nintendo|video.?game|gaming.?console/i, ["Video Games", null]],
  [/speaker|soundbar|subwoofer|amplifier|stereo|audio/i,     ["Electronics & computers", "Audio equipment"]],
  [/electron|computer|laptop|tech/i,                         ["Electronics & computers", null]],
  // Clothing — FB splits by gender; default to women's (broader)
  [/cloth|shirt|pant|dress|skirt|blouse|sweater|coat|jacket|fashion|apparel/i, ["Women's clothing & shoes", null]],
  [/men.?s|suit|tie|blazer/i,                                ["Men's clothing & shoes", null]],
  [/shoe|sneaker|boot|sandal|heel/i,                         ["Women's clothing & shoes", null]],
  [/bag|purse|handbag|backpack|luggage|suitcase/i,           ["Bags & Luggage", null]],
  [/jewelry|ring|necklace|bracelet|earring|watch/i,          ["Jewelry & Accessories", null]],
  // Home
  [/sofa|couch|chair|table|desk|bed|shelf|bookcase|cabinet|dresser|wardrobe|mattress/i, ["Furniture", null]],
  [/appliance|washer|dryer|refrigerator|dishwasher|microwave|vacuum/i, ["Appliances", null]],
  [/kitchen|cookware|bakeware|coffee.?maker|blender|toaster/i, ["Household", null]],
  [/tool|drill|saw|wrench|hammer|power.?tool/i,              ["Tools", null]],
  [/garden|outdoor|patio|lawn|plant|hose|mower/i,            ["Garden", null]],
  [/home|decor|rug|curtain|lamp|lighting|pillow|frame|mirror/i, ["Household", null]],
  // Other
  [/bicycle|bike\b/i,                                        ["Bicycles", null]],
  [/sport|fitness|gym|exercise|camping|hiking|ski|surf|golf|tennis/i, ["Sports & Outdoors", null]],
  [/toy|lego|puzzle|board.?game/i,                           ["Toys & Games", null]],
  [/kid|children|baby|infant|stroller|car.?seat|high.?chair|crib/i, ["Baby & kids", null]],
  [/book|textbook|magazine|novel|dvd|blu.?ray|vinyl|\bcd\b/i, ["Books, Movies & Music", null]],
  [/music|instrument|guitar|piano|drum|keyboard/i,           ["Musical Instruments", null]],
  [/art|craft|painting|sculpture/i,                          ["Arts & Crafts", null]],
  [/collectible|antique|vintage/i,                           ["Antiques & Collectibles", null]],
  [/car\b|vehicle|truck|motorcycle|boat|trailer|atv/i,       ["Vehicles", null]],
  [/auto.?part|car.?part/i,                                  ["Auto parts", null]],
  [/pet|dog|cat|aquarium|cage|leash|collar/i,                ["Pet Supplies", null]],
  [/health|beauty|skincare|makeup|vitamin|supplement/i,      ["Health & beauty", null]],
];

function mapCategoryHierarchy(categoryGuess: string): { top: string; sub: string | null } {
  for (const [re, [top, sub]] of CATEGORY_HIERARCHY) {
    if (re.test(categoryGuess)) return { top, sub };
  }
  return { top: "Miscellaneous", sub: null };
}

export type PublishInput = {
  title: string;
  description: string;
  price: number;
  condition: string;
  category?: string;
  photos: string[];
  /** "review" (default): fill form, leave browser open for manual Next→Publish.
   *  "draft": fill form, click "Save draft", close browser. */
  mode?: "draft" | "review";
};

export type PublishResult = {
  success: boolean;
  url?: string;
  error?: string;
  screenshot?: string;
  /** true when publisher stopped after filling — user must click Next→Publish manually */
  readyToReview?: boolean;
  /** true when "Save draft" was clicked and confirmed */
  drafted?: boolean;
};

async function jitter(min = 300, max = 1500): Promise<void> {
  await new Promise((r) => setTimeout(r, min + Math.random() * (max - min)));
}

async function snapshot(page: Page | null, label: string): Promise<string | undefined> {
  if (!page) return undefined;
  try {
    await mkdir(DEBUG_DIR, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const file = resolve(DEBUG_DIR, `fb-${label}-${stamp}.png`);
    await page.screenshot({ path: file, fullPage: true });
    return file;
  } catch {
    return undefined;
  }
}

function fail(error: string, screenshot?: string): PublishResult {
  return { success: false, error, screenshot };
}

export async function publishToFBMarketplace(input: PublishInput): Promise<PublishResult> {
  if (!existsSync(SESSION_PATH)) {
    return fail("session_not_set_up");
  }
  for (const p of input.photos) {
    if (!existsSync(p)) return fail(`photo_missing: ${p}`);
  }

  let browser: Browser | null = null;
  let page: Page | null = null;
  let keepBrowserOpen = false; // set true when we hand off to the user
  const deadline = Date.now() + DEADLINE_MS;

  try {
    browser = await chromium.launch({
      headless: false,
      args: ["--disable-blink-features=AutomationControlled"],
    });
    const ctx = await browser.newContext({
      storageState: SESSION_PATH,
      userAgent: USER_AGENT,
      viewport: { width: 1280, height: 900 },
      locale: "en-US",
    });
    await ctx.addInitScript(() => {
      Object.defineProperty(navigator, "webdriver", { get: () => undefined });
    });
    page = await ctx.newPage();
    await page.bringToFront();

    await page.goto("https://www.facebook.com/marketplace/create/item", {
      waitUntil: "domcontentloaded",
      timeout: 30_000,
    });
    await jitter(1200, 2000);

    const landedUrl = page.url();
    if (landedUrl.includes("/login") || landedUrl.includes("/checkpoint")) {
      return fail("session_expired", await snapshot(page, "session-expired"));
    }

    // ── Photos ────────────────────────────────────────────────────────────
    // Try filechooser event first (clicking "Add photos" button), then fall
    // back to directly setting files on the hidden input.
    const addPhotosBtn = page
      .getByRole("button", { name: /add photos/i })
      .or(page.locator('[aria-label*="photo" i]').first())
      .first();

    const btnVisible = await addPhotosBtn.isVisible({ timeout: 10_000 }).catch(() => false);
    if (!btnVisible) {
      return fail("selector_failed: add photos button not found", await snapshot(page, "no-add-photos-btn"));
    }

    const chooserPromise = page.waitForEvent("filechooser", { timeout: 5000 }).catch(() => null);
    await addPhotosBtn.click();
    const chooser = await chooserPromise;
    await jitter(400, 800);

    if (chooser) {
      await chooser.setFiles(input.photos);
    } else {
      const fileInput = page.locator('input[type="file"]').first();
      const attached = await fileInput.waitFor({ state: "attached", timeout: 5000 }).then(() => true).catch(() => false);
      if (!attached) {
        return fail("selector_failed: file input not found", await snapshot(page, "no-file-input"));
      }
      await fileInput.setInputFiles(input.photos);
    }

    await jitter(3000, 5000); // photos need time to upload to FB

    if (Date.now() > deadline) {
      return fail("timeout", await snapshot(page, "timeout-after-photos"));
    }

    // ── Title ─────────────────────────────────────────────────────────────
    const titleField = page
      .getByLabel(/^title$/i)
      .or(page.getByPlaceholder(/title/i))
      .first();
    const titleVisible = await titleField.waitFor({ state: "visible", timeout: 8000 }).then(() => true).catch(() => false);
    if (!titleVisible) {
      return fail("selector_failed: title field not found", await snapshot(page, "no-title"));
    }
    await titleField.click();
    await jitter();
    await titleField.fill(input.title);
    await jitter();

    // ── Price ─────────────────────────────────────────────────────────────
    const priceField = page
      .getByLabel(/^price$/i)
      .or(page.getByPlaceholder(/^\$?\s*price/i))
      .or(page.locator('input[type="number"]').first())
      .first();
    const priceVisible = await priceField.waitFor({ state: "visible", timeout: 5000 }).then(() => true).catch(() => false);
    if (!priceVisible) {
      return fail("selector_failed: price not found", await snapshot(page, "no-price"));
    }
    await priceField.click();
    await jitter();
    await priceField.fill(String(input.price));
    await jitter();

    // ── Category ──────────────────────────────────────────────────────────
    // Category is required by FB — Next stays disabled until it's selected.
    const { top: topCategory, sub: subCategory } = mapCategoryHierarchy(input.category ?? "");
    {
      // Open the category selector (could be a <select>, combobox, or plain button)
      const catTrigger = page
        .getByRole("combobox", { name: /category/i })
        .or(page.getByLabel(/category/i))
        .or(page.getByPlaceholder(/category/i))
        .first();

      const catVisible = await catTrigger.waitFor({ state: "visible", timeout: 8000 })
        .then(() => true).catch(() => false);
      if (!catVisible) {
        return fail("selector_failed: category field not found", await snapshot(page, "no-category-field"));
      }
      await catTrigger.click();
      await jitter(500, 900);

      // FB's category panel uses [role="button"] divs — not [role="option"].
      // Some buttons append "Shipping available" to their text content, so we
      // match with filter({ hasText }) rather than an exact name check.
      const topOption = page
        .locator('[role="button"]')
        .filter({ hasText: topCategory })
        .first();

      const topVisible = await topOption.waitFor({ state: "visible", timeout: 5000 })
        .then(() => true).catch(() => false);
      if (!topVisible) {
        return fail(
          `selector_failed: category option "${topCategory}" not found`,
          await snapshot(page, "no-category-option"),
        );
      }
      await topOption.click();
      await jitter(700, 1100);

      // If a subcategory was specified, wait briefly for a second panel and click it.
      if (subCategory) {
        const subOption = page
          .locator('[role="button"]')
          .filter({ hasText: subCategory })
          .first();
        const subVisible = await subOption.waitFor({ state: "visible", timeout: 3000 })
          .then(() => true).catch(() => false);
        if (subVisible) {
          await subOption.click();
          await jitter(400, 700);
        }
        // If subcategory panel didn't appear the top-level selection is still valid.
      }
    }

    // ── Condition ─────────────────────────────────────────────────────────
    const fbCondition = FB_CONDITIONS[input.condition] ?? "Used - Good";
    const condField = page
      .getByLabel(/condition/i)
      .or(page.getByRole("combobox", { name: /condition/i }))
      .first();
    const condVisible = await condField.waitFor({ state: "visible", timeout: 5000 }).then(() => true).catch(() => false);
    if (!condVisible) {
      return fail("selector_failed: condition dropdown not found", await snapshot(page, "no-condition"));
    }
    await condField.click();
    await jitter();
    // Escape special chars in condition label for regex
    const condPattern = new RegExp(fbCondition.replace(/[^a-z0-9\s]/gi, ".*"), "i");
    const condOption = page.getByRole("option", { name: condPattern }).first();
    const condOptionVisible = await condOption.waitFor({ state: "visible", timeout: 3000 }).then(() => true).catch(() => false);
    if (!condOptionVisible) {
      return fail("selector_failed: condition option not found", await snapshot(page, "no-condition-option"));
    }
    await condOption.click();
    await jitter();

    // ── Description ───────────────────────────────────────────────────────
    const descField = page
      .getByLabel(/description/i)
      .or(page.getByPlaceholder(/description/i))
      .first();
    const descVisible = await descField.waitFor({ state: "visible", timeout: 5000 }).then(() => true).catch(() => false);
    if (!descVisible) {
      return fail("selector_failed: description not found", await snapshot(page, "no-description"));
    }
    await descField.click();
    await jitter();
    await descField.fill(input.description);
    await jitter();

    if (Date.now() > deadline) {
      return fail("timeout", await snapshot(page, "timeout-mid-form"));
    }

    // ── Hide from friends ─────────────────────────────────────────────────
    try {
      const hideToggle = page
        .getByLabel(/hide from friends/i)
        .or(page.getByRole("checkbox", { name: /hide from friends/i }))
        .or(page.getByRole("switch", { name: /hide from friends/i }))
        .first();
      if (await hideToggle.isVisible({ timeout: 3000 })) {
        const checked = await hideToggle.isChecked().catch(() => false);
        if (!checked) {
          await hideToggle.click();
          await jitter();
        }
      }
    } catch {
      // optional — skip silently
    }

    // ── Local pickup ──────────────────────────────────────────────────────
    try {
      const localPickup = page
        .getByLabel(/local pickup/i)
        .or(page.getByRole("radio", { name: /local pickup/i }))
        .or(page.getByRole("checkbox", { name: /local pickup/i }))
        .first();
      if (await localPickup.isVisible({ timeout: 2000 })) {
        await localPickup.click();
        await jitter();
      }
    } catch {
      // optional — skip silently
    }

    // ── Hand off or save draft ────────────────────────────────────────────
    await jitter(500, 800); // let any UI settle

    if ((input.mode ?? "review") === "review") {
      const reviewShot = await snapshot(page, "ready");
      keepBrowserOpen = true;
      return { success: true, readyToReview: true, screenshot: reviewShot };
    }

    // ── Draft mode: click "Save draft" ────────────────────────────────────
    const saveDraftBtn = page
      .getByRole("button", { name: /save\s*(?:as\s*)?draft/i })
      .or(page.locator("a", { hasText: /save\s*(?:as\s*)?draft/i }))
      .first();

    const draftBtnVisible = await saveDraftBtn
      .waitFor({ state: "visible", timeout: 8000 })
      .then(() => true)
      .catch(() => false);

    if (!draftBtnVisible) {
      return fail(
        "selector_failed: Save draft button not found — FB may have changed its UI",
        await snapshot(page, "no-save-draft-btn"),
      );
    }

    await saveDraftBtn.click();
    await jitter(1500, 2500); // wait for FB to process the save

    const draftShot = await snapshot(page, "draft-saved");
    return { success: true, drafted: true, screenshot: draftShot };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return fail(`publisher_error: ${msg}`, await snapshot(page, "exception"));
  } finally {
    // If the form was filled successfully and we're handing off to the user,
    // leave Chromium open so they can review and click Next → Publish.
    if (!keepBrowserOpen && browser) await browser.close().catch(() => {});
  }
}
