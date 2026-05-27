export type Comp = {
  title: string;
  price: number;
  distance: string;
  url: string;
  imageUrl: string | null;
};

export type CompStats = {
  count: number;
  median: number;
  p25: number;
  p75: number;
  min: number;
  max: number;
};

export type ScrapeError =
  | "blocked"
  | "no_results"
  | "failed"
  | "session_expired";

export type ScrapeResult =
  | { listings: Comp[]; stats: CompStats; error?: undefined }
  | { listings: []; stats: null; error: ScrapeError };

export function quantile(sortedAsc: number[], q: number): number {
  if (sortedAsc.length === 0) return 0;
  if (sortedAsc.length === 1) return sortedAsc[0];
  const pos = (sortedAsc.length - 1) * q;
  const base = Math.floor(pos);
  const rest = pos - base;
  const next = sortedAsc[base + 1];
  return next !== undefined
    ? sortedAsc[base] + rest * (next - sortedAsc[base])
    : sortedAsc[base];
}

export function computeStats(prices: number[]): CompStats {
  const sorted = [...prices].sort((a, b) => a - b);
  return {
    count: sorted.length,
    median: Math.round(quantile(sorted, 0.5)),
    p25: Math.round(quantile(sorted, 0.25)),
    p75: Math.round(quantile(sorted, 0.75)),
    min: Math.round(sorted[0]),
    max: Math.round(sorted[sorted.length - 1]),
  };
}

const STOPWORDS = new Set([
  "the", "and", "for", "with", "from", "this", "that", "very", "your",
  "good", "new", "used", "like", "into", "have", "has", "had", "are",
  "was", "were", "will", "all", "only", "but", "out", "not", "one",
  "two", "set", "pcs", "pack", "size",
]);

export function tokenize(s: string): string[] {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter((w) => w.length >= 3 && !STOPWORDS.has(w));
}
