import { chromium, type Browser } from "playwright";
import {
  type Comp,
  type ScrapeResult,
  computeStats,
  quantile,
  tokenize,
} from "./comp-types";

const USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

function parsePriceText(
  raw: string,
): number | null {
  // Handles "$50.00", "$1,200", "$50.00 to $75.00" (take higher)
  const matches = [
    ...raw.matchAll(/\$\s*([\d,]+(?:\.\d{1,2})?)/g),
  ];
  if (matches.length === 0) return null;

  const lowerHasRange = /\bto\b/i.test(raw);
  const idx = lowerHasRange && matches.length >= 2 ? 1 : 0;
  const value = parseFloat(matches[idx][1].replace(/,/g, ""));
  return Number.isFinite(value) && value > 0 ? value : null;
}

function extractSoldDate(caption: string): string {
  // Caption typically looks like "Sold Nov 14, 2024" or "Sold  Nov 14, 2024"
  const m = caption.match(/Sold\s+([A-Z][a-z]{2}\s+\d{1,2}(?:,\s*\d{4})?)/);
  if (m) return `Sold ${m[1].replace(/,\s*\d{4}$/, "")}`;
  if (/sold/i.test(caption)) return "Sold";
  return "";
}

export async function scrapeEbaySoldComps(
  query: string,
): Promise<ScrapeResult> {
  const url = `https://www.ebay.com/sch/i.html?_nkw=${encodeURIComponent(query)}&LH_Complete=1&LH_Sold=1&_sop=13`;

  await new Promise((r) => setTimeout(r, 1000 + Math.random() * 2000));

  let browser: Browser | null = null;
  try {
    browser = await chromium.launch({
      headless: true,
      args: ["--disable-blink-features=AutomationControlled"],
    });
    const context = await browser.newContext({
      userAgent: USER_AGENT,
      viewport: { width: 1280, height: 800 },
      locale: "en-US",
      extraHTTPHeaders: {
        "Accept-Language": "en-US,en;q=0.9",
        "Sec-Ch-Ua":
          '"Chromium";v="131", "Not_A Brand";v="24", "Google Chrome";v="131"',
        "Sec-Ch-Ua-Mobile": "?0",
        "Sec-Ch-Ua-Platform": '"macOS"',
      },
    });
    await context.addInitScript(() => {
      Object.defineProperty(navigator, "webdriver", { get: () => undefined });
    });
    const page = await context.newPage();

    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 15000 });

    const pageText = (await page.evaluate(() =>
      document.body.innerText.toLowerCase(),
    )) as string;

    const blockedSignals = [
      "pardon our interruption",
      "please verify yourself",
      "captcha",
      "access to this page has been denied",
      "are you a human",
    ];
    if (blockedSignals.some((s) => pageText.includes(s))) {
      return { listings: [], stats: null, error: "blocked" };
    }

    try {
      await page.waitForSelector(
        'li.s-item, li.s-card, .srp-results li, [data-listing-id]',
        { timeout: 8000 },
      );
    } catch {
      return { listings: [], stats: null, error: "no_results" };
    }

    const raw = (await page.evaluate(() => {
      const cards = Array.from(
        document.querySelectorAll(
          'li.s-item, li.s-card, .srp-results li[data-listing-id], .srp-results .s-card',
        ),
      );

      const items: {
        title: string;
        priceText: string;
        soldCaption: string;
        url: string;
        imageUrl: string | null;
      }[] = [];

      const seen = new Set<string>();

      for (const card of cards) {
        const titleEl =
          card.querySelector('.s-item__title, .s-card__title, [role="heading"]') ||
          card.querySelector('h3, .su-styled-text--large');
        const priceEl =
          card.querySelector('.s-item__price, .s-card__price') ||
          card.querySelector('[class*="price"]:not([class*="strike"]):not([class*="original"])');
        const captionEl =
          card.querySelector('.s-item__caption, .s-card__caption, [class*="caption"]');
        const linkEl =
          (card.querySelector('a.s-item__link, a.s-card__link, h3 a, a[href*="/itm/"]') as HTMLAnchorElement | null);
        const imgEl = card.querySelector('img') as HTMLImageElement | null;

        const titleRaw = titleEl?.textContent?.trim() ?? "";
        const title = titleRaw
          .replace(/^new listing\s*/i, "")
          .replace(/\s*opens in a new window or tab\s*$/i, "")
          .trim();

        if (!title || /^shop on ebay$/i.test(title)) continue;

        const priceText = priceEl?.textContent?.trim() ?? "";
        const soldCaption = captionEl?.textContent?.trim() ?? "";
        const rawHref = linkEl?.href ?? "";
        if (!rawHref || !/\/itm\//.test(rawHref)) continue;

        // Dedupe by item ID in URL
        const idMatch = rawHref.match(/\/itm\/(?:[^/]*\/)?(\d+)/);
        const key = idMatch ? idMatch[1] : rawHref;
        if (seen.has(key)) continue;
        seen.add(key);

        // Strip tracking params, keep just /itm/<id>
        const href = idMatch
          ? `https://www.ebay.com/itm/${idMatch[1]}`
          : rawHref;

        const imageUrl =
          imgEl?.getAttribute("src") ||
          imgEl?.getAttribute("data-src") ||
          null;

        items.push({ title, priceText, soldCaption, url: href, imageUrl });
        if (items.length >= 40) break;
      }

      return items;
    })) as Array<{
      title: string;
      priceText: string;
      soldCaption: string;
      url: string;
      imageUrl: string | null;
    }>;

    const parsed: Comp[] = raw
      .map((r) => {
        const price = parsePriceText(r.priceText);
        if (price === null) return null;
        return {
          title: r.title,
          price,
          distance: extractSoldDate(r.soldCaption) || "Sold",
          url: r.url,
          imageUrl: r.imageUrl,
        } as Comp;
      })
      .filter((c): c is Comp => c !== null);

    if (parsed.length === 0) {
      return { listings: [], stats: null, error: "no_results" };
    }

    const queryTokens = new Set(tokenize(query));
    const keywordFiltered =
      queryTokens.size > 0
        ? parsed.filter((c) => {
            const titleTokens = tokenize(c.title);
            return titleTokens.some((t) => queryTokens.has(t));
          })
        : parsed;

    const afterKeyword = keywordFiltered.length > 0 ? keywordFiltered : parsed;

    const provisionalSorted = [...afterKeyword.map((c) => c.price)].sort(
      (a, b) => a - b,
    );
    const q1 = quantile(provisionalSorted, 0.25);
    const q3 = quantile(provisionalSorted, 0.75);
    const iqr = q3 - q1;
    const lowerBound = q1 - 1.5 * iqr;
    const upperBound = q3 + 1.5 * iqr;
    const outlierFiltered = afterKeyword.filter(
      (c) => c.price >= lowerBound && c.price <= upperBound,
    );

    if (outlierFiltered.length === 0) {
      return { listings: [], stats: null, error: "no_results" };
    }

    const top = outlierFiltered.slice(0, 20);
    const stats = computeStats(top.map((c) => c.price));

    return { listings: top, stats };
  } catch {
    return { listings: [], stats: null, error: "failed" };
  } finally {
    if (browser) {
      try {
        await browser.close();
      } catch {
        // ignore
      }
    }
  }
}
