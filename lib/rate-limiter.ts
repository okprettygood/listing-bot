import { existsSync, readFileSync, writeFileSync, mkdirSync } from "fs";
import { resolve, dirname } from "path";

const HISTORY_PATH = resolve(process.cwd(), "data", "publish-history.json");

const DAILY_LIMIT = 10;
const MIN_GAP_MS = 60_000;
const DAY_MS = 24 * 60 * 60 * 1000;

type Entry = { platform: string; timestamp: number };

function readHistory(): Entry[] {
  if (!existsSync(HISTORY_PATH)) return [];
  try {
    const raw = readFileSync(HISTORY_PATH, "utf8");
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed?.entries)) return [];
    return parsed.entries.filter(
      (e: unknown): e is Entry =>
        !!e &&
        typeof e === "object" &&
        typeof (e as Entry).platform === "string" &&
        typeof (e as Entry).timestamp === "number",
    );
  } catch {
    return [];
  }
}

function writeHistory(entries: Entry[]): void {
  mkdirSync(dirname(HISTORY_PATH), { recursive: true });
  writeFileSync(
    HISTORY_PATH,
    JSON.stringify({ entries }, null, 2),
    "utf8",
  );
}

export type RateLimitCheck =
  | { ok: true }
  | { ok: false; reason: "daily_limit" | "too_soon"; waitMs?: number };

export function checkRateLimit(platform: string): RateLimitCheck {
  const now = Date.now();
  const entries = readHistory().filter(
    (e) => e.platform === platform && now - e.timestamp < DAY_MS,
  );

  if (entries.length >= DAILY_LIMIT) {
    return { ok: false, reason: "daily_limit" };
  }

  if (entries.length > 0) {
    const last = Math.max(...entries.map((e) => e.timestamp));
    const since = now - last;
    if (since < MIN_GAP_MS) {
      return { ok: false, reason: "too_soon", waitMs: MIN_GAP_MS - since };
    }
  }

  return { ok: true };
}

export function recordPublish(platform: string): void {
  const now = Date.now();
  const fresh = readHistory().filter((e) => now - e.timestamp < 7 * DAY_MS);
  fresh.push({ platform, timestamp: now });
  writeHistory(fresh);
}
