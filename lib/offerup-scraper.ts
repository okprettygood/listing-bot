import { chromium, type Browser } from "playwright";
import {
  type Comp,
  type ScrapeResult,
  computeStats,
  quantile,
  tokenize,
} from "./comp-types";

export type { Comp, CompStats, ScrapeError, ScrapeResult } from "./comp-types";

const USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

function parseAnchorText(
  text: string,
): { title: string; price: number; location: string } | null {
  const m = text.match(/^(.*?)\$\s*([\d,]+(?:\.\d{1,2})?)\s*(.*)$/);
  if (!m) return null;
  const title = m[1].trim().replace(/\s+/g, " ");
  const price = parseFloat(m[2].replace(/,/g, ""));
  const location = m[3].trim().replace(/\s+/g, " ");
  if (!title || !Number.isFinite(price) || price <= 0) return null;
  return { title, price, location };
}

export async function scrapeOfferUpComps(
  query: string,
  zip: string,
  radiusMiles: number,
): Promise<ScrapeResult> {
  const url = `https://offerup.com/search?q=${encodeURIComponent(query)}&radius=${radiusMiles}&postal_code=${zip}`;

  await new Promise((r) => setTimeout(r, 1000 + Math.random() * 2000));

  let browser: Browser | null = null;
  try {
    browser = await chromium.launch({ headless: true });
    const context = await browser.newContext({
      userAgent: USER_AGENT,
      viewport: { width: 1280, height: 800 },
      locale: "en-US",
    });
    const page = await context.newPage();

    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 12000 });

    const pageText = (await page.evaluate(() =>
      document.body.innerText.toLowerCase(),
    )) as string;

    const blockedSignals = [
      "verify you are human",
      "verify you're human",
      "are you a robot",
      "captcha",
      "access denied",
      "sign in to continue",
      "log in to continue",
    ];
    if (blockedSignals.some((s) => pageText.includes(s))) {
      return { listings: [], stats: null, error: "blocked" };
    }

    try {
      await page.waitForSelector(
        'a[href*="/item/detail/"], [data-testid*="item"], [data-testid*="ItemBubble"]',
        { timeout: 8000 },
      );
    } catch {
      return { listings: [], stats: null, error: "no_results" };
    }

    const raw = (await page.evaluate(() => {
      const anchors = Array.from(
        document.querySelectorAll<HTMLAnchorElement>('a[href*="/item/detail/"]'),
      );
      const seen = new Set<string>();
      const items: { text: string; url: string; imageUrl: string | null }[] = [];

      for (const a of anchors) {
        const href = a.href;
        if (seen.has(href)) continue;
        seen.add(href);

        const text = (a.textContent ?? "").replace(/\s+/g, " ").trim();
        const imgEl = a.querySelector("img");
        const imageUrl =
          imgEl?.getAttribute("src") ||
          imgEl?.getAttribute("data-src") ||
          null;

        if (text) items.push({ text, url: href, imageUrl });
        if (items.length >= 30) break;
      }
      return items;
    })) as Array<{ text: string; url: string; imageUrl: string | null }>;

    const parsed: Comp[] = raw
      .map((r) => {
        const parts = parseAnchorText(r.text);
        if (!parts) return null;
        return {
          title: parts.title,
          price: parts.price,
          distance: parts.location || "—",
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
        // ignore close errors
      }
    }
  }
}
