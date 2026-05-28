import { NextResponse } from "next/server";
import { readdir } from "fs/promises";
import { existsSync } from "fs";
import { resolve } from "path";
import { publishToFBMarketplace, type PublishInput } from "@/lib/fb-publisher";
import { checkRateLimit, recordPublish } from "@/lib/rate-limiter";

export const runtime = "nodejs";
export const maxDuration = 120;

const PHOTOS_DIR = resolve(process.cwd(), "data", "photos");

type Body = {
  platform?: string;
  listingId?: string;
  mode?: "draft" | "review";
  listing?: {
    title?: string;
    description?: string;
    price?: number | null;
    condition?: string;
    category?: string;
  };
};

export async function POST(req: Request) {
  let body: Body;
  try {
    body = (await req.json()) as Body;
  } catch {
    return NextResponse.json({ success: false, error: "invalid_json" }, { status: 400 });
  }

  if (body.platform !== "facebook") {
    return NextResponse.json({ success: false, error: "unsupported_platform" }, { status: 400 });
  }

  const listingId = body.listingId;
  if (!listingId || !/^[a-f0-9-]{36}$/i.test(listingId)) {
    return NextResponse.json({ success: false, error: "invalid_listing_id" }, { status: 400 });
  }

  const l = body.listing ?? {};
  if (
    typeof l.title !== "string" || !l.title.trim() ||
    typeof l.description !== "string" || !l.description.trim() ||
    typeof l.price !== "number" || l.price <= 0 ||
    typeof l.condition !== "string"
  ) {
    return NextResponse.json({ success: false, error: "invalid_listing_fields" }, { status: 400 });
  }

  // Rate-limit only applies to live publishes, not drafts.
  const effectiveMode = body.mode === "draft" ? "draft" : "review";
  if (effectiveMode === "review") {
    const limit = checkRateLimit("facebook");
    if (!limit.ok) {
      return NextResponse.json(
        {
          success: false,
          error: limit.reason,
          waitMs: limit.reason === "too_soon" ? limit.waitMs : undefined,
        },
        { status: 429 },
      );
    }
  }

  const listingDir = resolve(PHOTOS_DIR, listingId);
  if (!existsSync(listingDir)) {
    return NextResponse.json({ success: false, error: "photos_not_found" }, { status: 400 });
  }

  let photoPaths: string[];
  try {
    const files = await readdir(listingDir);
    photoPaths = files
      .filter((f) => /\.jpe?g$/i.test(f))
      .sort()
      .map((f) => resolve(listingDir, f));
  } catch {
    return NextResponse.json({ success: false, error: "photos_read_failed" }, { status: 500 });
  }

  if (photoPaths.length === 0) {
    return NextResponse.json({ success: false, error: "no_photos_on_disk" }, { status: 400 });
  }

  const input: PublishInput = {
    title: l.title.trim(),
    description: l.description.trim(),
    price: l.price,
    condition: l.condition,
    category: l.category,
    photos: photoPaths,
    mode: effectiveMode,
  };

  const result = await publishToFBMarketplace(input);

  // Only record in rate-limit history for live publishes (not drafts).
  if (result.success && effectiveMode === "review") recordPublish("facebook");

  return NextResponse.json(result, { status: result.success ? 200 : 500 });
}
