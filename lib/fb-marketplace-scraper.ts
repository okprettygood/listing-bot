import { chromium, type Browser } from "playwright";
import { existsSync } from "fs";
import { resolve } from "path";
import {
  type Comp,
  type ScrapeResult,
  computeStats,
  quantile,
  tokenize,
} from "./comp-types";

const USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

const SESSION_PATH = resolve(process.cwd(), "data/fb-session.json");

function parseFBAnchorText(
  text: string,
): { title: string; price: number; location: string } | null {
  const priceMatch = text.match(/\$\s*([\d,]+(?:\.\d{1,2})?)/);
  if (!priceMatch || priceMatch.index === undefined) return null;
  const price = parseFloat(priceMatch[1].replace(/,/g, ""));
  if (!Number.isFinite(price) || price <= 0) return null;

  const before = text.slice(0, priceMatch.index).trim();
  const after = text.slice(priceMatch.index + priceMatch[0].length).trim();

  const locationRegex =
    /\b([A-Z][a-zA-Z]+(?:[\s'-][A-Z][a-zA-Z]+)*),\s*([A-Z]{2}|[A-Z][a-z]+(?:\s[A-Z][a-z]+)*)\b/;
  let location = "";
  let titleParts: string[] = [];

  const afterLoc = after.match(locationRegex);
  const beforeLoc = before.match(locationRegex);

  if (afterLoc) {
    location = afterLoc[0];
    const afterMinusLoc = after.replace(location, "").trim();
    titleParts = [before, afterMinusLoc].filter(Boolean);
  } else if (beforeLoc) {
    location = beforeLoc[0];
    const beforeMinusLoc = before.replace(location, "").trim();
    titleParts = [beforeMinusLoc, after].filter(Boolean);
  } else {
    titleParts = [before, after].filter(Boolean);
  }

  const title = titleParts
    .join(" ")
    .replace(/\bListed (just now|\d+\s+\w+\s+ago)\b/gi, "")
    .replace(/\bShipping available\b/gi, "")
    .replace(/\s+/g, " ")
    .trim();

  if (!title) return null;
  return { title, price, location };
}

export async function scrapeFBMarketplaceComps(
  query: string,
  _zip: string,
  _radiusMiles: number,
): Promise<ScrapeResult> {
  if (!existsSync(SESSION_PATH)) {
    return { listings: [], stats: null, error: "session_expired" };
  }

  const url = `https://www.facebook.com/marketplace/search/?query=${encodeURIComponent(query)}`;

  await new Promise((r) => setTimeout(r, 2000 + Math.random() * 2000));

  let browser: Browser | null = null;
  try {
    browser = await chromium.launch({ headless: true });
    const context = await browser.newContext({
      storageState: SESSION_PATH,
      userAgent: USER_AGENT,
      viewport: { width: 1280, height: 800 },
      locale: "en-US",
    });
    const page = await context.newPage();

    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 15000 });

    const finalUrl = page.url();
    if (
      finalUrl.includes("/login") ||
      finalUrl.includes("/checkpoint") ||
      finalUrl.includes("login.php")
    ) {
      return { listings: [], stats: null, error: "session_expired" };
    }

    const pageText = (await page.evaluate(() =>
      document.body.innerText.toLowerCase(),
    )) as string;

    const sessionSignals = [
      "log in to facebook",
      "log into facebook",
      "create new account",
      "you must log in",
    ];
    if (sessionSignals.some((s) => pageText.includes(s))) {
      return { listings: [], stats: null, error: "session_expired" };
    }

    const blockedSignals = [
      "verify you are human",
      "verify you're human",
      "we suspect",
      "unusual activity",
      "captcha",
      "security check",
    ];
    if (blockedSignals.some((s) => pageText.includes(s))) {
      return { listings: [], stats: null, error: "blocked" };
    }

    try {
      await page.waitForSelector('a[href*="/marketplace/item/"]', {
        timeout: 8000,
      });
    } catch {
      return { listings: [], stats: null, error: "no_results" };
    }

    const raw = (await page.evaluate(() => {
      const anchors = Array.from(
        document.querySelectorAll<HTMLAnchorElement>(
          'a[href*="/marketplace/item/"]',
        ),
      );
      const seen = new Set<string>();
      const items: { text: string; url: string; imageUrl: string | null }[] = [];

      for (const a of anchors) {
        const idMatch = a.href.match(/\/marketplace\/item\/(\d+)/);
        const key = idMatch ? idMatch[1] : a.href;
        if (seen.has(key)) continue;
        seen.add(key);

        const text = (a.textContent ?? "").replace(/\s+/g, " ").trim();
        const imgEl = a.querySelector("img");
        const imageUrl =
          imgEl?.getAttribute("src") ||
          imgEl?.getAttribute("data-src") ||
          null;

        const cleanUrl = idMatch
          ? `https://www.facebook.com/marketplace/item/${idMatch[1]}/`
          : a.href;

        if (text) items.push({ text, url: cleanUrl, imageUrl });
        if (items.length >= 30) break;
      }
      return items;
    })) as Array<{ text: string; url: string; imageUrl: string | null }>;

    const parsed: Comp[] = raw
      .map((r) => {
        const parts = parseFBAnchorText(r.text);
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
        // ignore
      }
    }
  }
}
