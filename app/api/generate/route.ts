import { NextResponse } from "next/server";
import Anthropic from "@anthropic-ai/sdk";
import sharp from "sharp";
import { randomUUID } from "crypto";
import { mkdir, writeFile } from "fs/promises";
import { resolve } from "path";
import { scrapeOfferUpComps } from "@/lib/offerup-scraper";
import { scrapeFBMarketplaceComps } from "@/lib/fb-marketplace-scraper";
import { scrapeEbaySoldComps } from "@/lib/ebay-scraper";
import type { ScrapeResult, CompStats } from "@/lib/comp-types";

const PHOTOS_DIR = resolve(process.cwd(), "data", "photos");

const USER_ZIP = "91780";
const USER_RADIUS_MILES = 25;
const SCRAPE_TIMEOUT_MS = 15000;

export const runtime = "nodejs";
export const maxDuration = 60;

const MODEL = "claude-sonnet-4-6";

const SYSTEM_PROMPT = `You are a resale listing assistant. Given photos of an item, generate a draft listing optimized for OfferUp and Facebook Marketplace.

Output a single JSON object matching the schema. No prose, no markdown fences, just JSON.

Guidelines:
- Title: 60-80 chars. Lead with brand and model if visible. Front-load keywords buyers would search.
- Description: Use a short bulleted format, not paragraphs. Keep it scannable. Buyers on OfferUp and FB Marketplace skim, they don't read.
  Format:
  - One-line opener: what it is, brand/model
  - Then bullet points for key details, each one line max
  - Use bullet character (•) not markdown dashes
  - Cover: condition, any flaws or damage, what's included, what's NOT included, size/specs if relevant
  - Max 6-8 bullets total
  - No em dashes, no filler phrases, no corporate tone
  - Write like a real person, casual and direct
  - Every flaw or missing part must be mentioned

  Example output style:
  Apple AirPods Pro 2nd Gen with MagSafe charging case.

  • Good condition, light wear on case
  • Both earbuds work, ANC and transparency mode tested
  • Includes charging case and one set of ear tips
  • No box or cable included
  • USB-C version
  • Battery holds charge well, roughly 4-5 hrs per session
- Condition: be conservative. 'good' is the default for used items with light wear. Reserve 'like_new' for items that look unused.
- Price: suggest a single list price based on comp data and condition. Aim for a price that balances selling quickly with getting fair value. Don't suggest a floor or range, just one number. The UI will show the user how their price compares to the market. If you can't confidently price, set suggested_price to null and explain in price_reasoning.
- Never claim authenticity of branded items from photos alone. Use 'appears to be Brand' if uncertain.
- Never invent dimensions. Omit if you can't estimate.

Schema:
{
  "title": string,
  "description": string,
  "condition": "new" | "like_new" | "good" | "fair" | "poor",
  "suggested_price": number | null,
  "price_reasoning": string,
  "identified_item": {
    "brand": string | null,
    "model": string | null,
    "category_guess": string
  },
  "confidence": "high" | "medium" | "low",
  "notes_for_seller": string
}`;

const CONDITIONS = ["new", "like_new", "good", "fair", "poor"] as const;
const CONFIDENCES = ["high", "medium", "low"] as const;

type Condition = (typeof CONDITIONS)[number];
type Confidence = (typeof CONFIDENCES)[number];

export type Listing = {
  title: string;
  description: string;
  condition: Condition;
  suggested_price: number | null;
  price_reasoning: string;
  identified_item: {
    brand: string | null;
    model: string | null;
    category_guess: string;
  };
  confidence: Confidence;
  notes_for_seller: string;
};

function stripFences(s: string): string {
  const trimmed = s.trim();
  if (trimmed.startsWith("```")) {
    return trimmed
      .replace(/^```(?:json)?\s*/i, "")
      .replace(/\s*```$/, "")
      .trim();
  }
  return trimmed;
}

function validateListing(data: unknown): Listing {
  if (!data || typeof data !== "object") {
    throw new Error("Response is not an object");
  }
  const d = data as Record<string, unknown>;

  if (typeof d.title !== "string" || !d.title.trim()) {
    throw new Error("Missing or invalid 'title'");
  }
  if (typeof d.description !== "string" || !d.description.trim()) {
    throw new Error("Missing or invalid 'description'");
  }
  if (
    typeof d.condition !== "string" ||
    !CONDITIONS.includes(d.condition as Condition)
  ) {
    throw new Error("Missing or invalid 'condition'");
  }
  if (
    d.suggested_price !== null &&
    typeof d.suggested_price !== "number"
  ) {
    throw new Error("Invalid 'suggested_price'");
  }
  if (typeof d.price_reasoning !== "string") {
    throw new Error("Missing 'price_reasoning'");
  }
  if (
    !d.identified_item ||
    typeof d.identified_item !== "object"
  ) {
    throw new Error("Missing 'identified_item'");
  }
  const item = d.identified_item as Record<string, unknown>;
  if (item.brand !== null && typeof item.brand !== "string") {
    throw new Error("Invalid 'identified_item.brand'");
  }
  if (item.model !== null && typeof item.model !== "string") {
    throw new Error("Invalid 'identified_item.model'");
  }
  if (typeof item.category_guess !== "string") {
    throw new Error("Missing 'identified_item.category_guess'");
  }
  if (
    typeof d.confidence !== "string" ||
    !CONFIDENCES.includes(d.confidence as Confidence)
  ) {
    throw new Error("Missing or invalid 'confidence'");
  }
  if (typeof d.notes_for_seller !== "string") {
    throw new Error("Missing 'notes_for_seller'");
  }

  return {
    title: d.title,
    description: d.description,
    condition: d.condition as Condition,
    suggested_price: d.suggested_price as number | null,
    price_reasoning: d.price_reasoning,
    identified_item: {
      brand: item.brand as string | null,
      model: item.model as string | null,
      category_guess: item.category_guess as string,
    },
    confidence: d.confidence as Confidence,
    notes_for_seller: d.notes_for_seller,
  };
}

export async function POST(req: Request) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    return NextResponse.json(
      { error: "ANTHROPIC_API_KEY is not set. Add it to .env.local." },
      { status: 500 },
    );
  }

  let form: FormData;
  try {
    form = await req.formData();
  } catch {
    return NextResponse.json(
      { error: "Could not parse form data." },
      { status: 400 },
    );
  }

  const photos = form.getAll("photos").filter((v): v is File => v instanceof File);
  const context = (form.get("context") as string | null)?.trim() ?? "";

  if (photos.length === 0) {
    return NextResponse.json(
      { error: "Upload at least one photo." },
      { status: 400 },
    );
  }
  if (photos.length > 8) {
    return NextResponse.json(
      { error: "Up to 8 photos at a time." },
      { status: 400 },
    );
  }

  const listingId = randomUUID();
  const listingDir = resolve(PHOTOS_DIR, listingId);

  let resized: {
    base64: string;
    mediaType: "image/jpeg";
    path: string;
  }[];
  try {
    await mkdir(listingDir, { recursive: true });
    resized = await Promise.all(
      photos.map(async (file, i) => {
        const buf = Buffer.from(await file.arrayBuffer());
        const jpeg = await sharp(buf)
          .rotate()
          .resize(2048, 2048, { fit: "inside", withoutEnlargement: true })
          .jpeg({ quality: 85 })
          .toBuffer();
        const path = resolve(listingDir, `photo-${i}.jpg`);
        await writeFile(path, jpeg);
        return {
          base64: jpeg.toString("base64"),
          mediaType: "image/jpeg" as const,
          path,
        };
      }),
    );
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Unknown error";
    return NextResponse.json(
      { error: `Could not process photos: ${msg}` },
      { status: 400 },
    );
  }

  const client = new Anthropic({ apiKey });

  const userContent: Anthropic.ContentBlockParam[] = resized.map((img) => ({
    type: "image",
    source: {
      type: "base64",
      media_type: img.mediaType,
      data: img.base64,
    },
  }));

  const instructionText = context
    ? `Extra context from the seller: ${context}\n\nGenerate the listing JSON now.`
    : "Generate the listing JSON now.";

  userContent.push({ type: "text", text: instructionText });

  let firstMessage: Anthropic.Message;
  try {
    firstMessage = await client.messages.create({
      model: MODEL,
      max_tokens: 2048,
      system: SYSTEM_PROMPT,
      messages: [{ role: "user", content: userContent }],
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Unknown error";
    return NextResponse.json(
      { error: `Claude API request failed: ${msg}` },
      { status: 500 },
    );
  }

  const firstTextBlock = firstMessage.content.find(
    (b): b is Anthropic.TextBlock => b.type === "text",
  );
  if (!firstTextBlock) {
    return NextResponse.json(
      { error: "Claude returned no text. Try again." },
      { status: 500 },
    );
  }

  const firstRaw = firstTextBlock.text;
  let firstListing: Listing;
  try {
    firstListing = validateListing(JSON.parse(stripFences(firstRaw)));
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Unknown error";
    return NextResponse.json(
      { error: `Response did not match schema: ${msg}`, raw: firstRaw },
      { status: 500 },
    );
  }

  const compQuery = buildCompQuery(firstListing);

  const [offerupSettled, fbSettled, ebaySettled] = await Promise.allSettled([
    runWithTimeout(
      scrapeOfferUpComps(compQuery, USER_ZIP, USER_RADIUS_MILES),
      SCRAPE_TIMEOUT_MS,
    ),
    runWithTimeout(
      scrapeFBMarketplaceComps(compQuery, USER_ZIP, USER_RADIUS_MILES),
      SCRAPE_TIMEOUT_MS,
    ),
    runWithTimeout(
      scrapeEbaySoldComps(compQuery),
      SCRAPE_TIMEOUT_MS,
    ),
  ]);

  const offerupResult = settledToResult(offerupSettled);
  const fbResult = settledToResult(fbSettled);
  const ebayResult = settledToResult(ebaySettled);

  const offerupUsable = isUsable(offerupResult);
  const fbUsable = isUsable(fbResult);
  const ebayUsable = isUsable(ebayResult);

  let finalListing = firstListing;
  if (offerupUsable || fbUsable || ebayUsable) {
    const compText = buildCompPromptText(
      offerupUsable ? offerupResult.stats : null,
      fbUsable ? fbResult.stats : null,
      ebayUsable ? ebayResult.stats : null,
    );
    try {
      const secondMessage = await client.messages.create({
        model: MODEL,
        max_tokens: 2048,
        system: SYSTEM_PROMPT,
        messages: [
          { role: "user", content: userContent },
          { role: "assistant", content: [{ type: "text", text: firstRaw }] },
          { role: "user", content: [{ type: "text", text: compText }] },
        ],
      });
      const secondTextBlock = secondMessage.content.find(
        (b): b is Anthropic.TextBlock => b.type === "text",
      );
      if (secondTextBlock) {
        try {
          finalListing = validateListing(
            JSON.parse(stripFences(secondTextBlock.text)),
          );
        } catch {
          // Keep first listing if refinement is malformed
        }
      }
    } catch {
      // Refinement failed; fall back to first listing
    }
  }

  return NextResponse.json({
    listingId,
    listing: finalListing,
    comps: {
      query: compQuery,
      offerup: offerupResult,
      facebook: fbResult,
      ebay: ebayResult,
    },
  });
}

function isUsable(
  r: ScrapeResult,
): r is { listings: ScrapeResult["listings"]; stats: CompStats } {
  return !r.error && r.stats !== null && r.listings.length > 0;
}

function settledToResult(
  s: PromiseSettledResult<ScrapeResult | null>,
): ScrapeResult {
  if (s.status === "fulfilled" && s.value !== null) return s.value;
  return { listings: [], stats: null, error: "failed" };
}

function buildCompQuery(listing: Listing): string {
  const brand = listing.identified_item.brand?.trim();
  const category = listing.identified_item.category_guess?.trim();
  const model = listing.identified_item.model?.trim();

  if (brand && model) return `${brand} ${model}`;
  if (brand && category) return `${brand} ${category}`;
  if (category) return category;

  const titleTokens = listing.title.split(/\s+/);
  return titleTokens.slice(0, 5).join(" ");
}

function buildCompPromptText(
  offerupStats: CompStats | null,
  fbStats: CompStats | null,
  ebayStats: CompStats | null,
): string {
  const sections: string[] = ["Market comp data:"];

  if (offerupStats) {
    sections.push(
      `OfferUp (active listings within ${USER_RADIUS_MILES}mi):
- Found ${offerupStats.count} listings, Median: $${offerupStats.median}, P25: $${offerupStats.p25}, P75: $${offerupStats.p75}`,
    );
  }

  if (fbStats) {
    sections.push(
      `Facebook Marketplace (active listings nearby):
- Found ${fbStats.count} listings, Median: $${fbStats.median}, P25: $${fbStats.p25}, P75: $${fbStats.p75}`,
    );
  }

  if (ebayStats) {
    sections.push(
      `eBay (recently SOLD, national, actual sale prices):
- Found ${ebayStats.count} sold, Median: $${ebayStats.median}, P25: $${ebayStats.p25}, P75: $${ebayStats.p75}

IMPORTANT: eBay data represents actual completed sales. Weight it more heavily than asking prices. Local pickup items can command a small premium over shipped eBay prices.`,
    );
  }

  sections.push(
    `Active asking prices typically run 15-25% above actual sale prices. Use the combined comp data to anchor your suggested_price. If sources diverge significantly, note it in price_reasoning.

Return the full updated listing JSON, same schema as before. No prose, no markdown fences, just JSON.`,
  );

  return sections.join("\n\n");
}

async function runWithTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
): Promise<T | null> {
  let timer: NodeJS.Timeout | undefined;
  const timeoutPromise = new Promise<null>((resolve) => {
    timer = setTimeout(() => resolve(null), timeoutMs);
  });
  try {
    return await Promise.race([promise, timeoutPromise]);
  } catch {
    return null;
  } finally {
    if (timer) clearTimeout(timer);
  }
}
