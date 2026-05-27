import { scrapeOfferUpComps } from "../lib/offerup-scraper";

const query = process.argv[2] ?? "PowerBlock Elite EXP 90 Adjustable Dumbbells";
const zip = process.argv[3] ?? "91780";
const radius = Number(process.argv[4] ?? 25);

async function main() {
  console.log(`\n=== test-scraper ===`);
  console.log(`query: ${query}`);
  console.log(`zip:   ${zip}`);
  console.log(`radius: ${radius} mi\n`);

  const t0 = Date.now();
  const result = await scrapeOfferUpComps(query, zip, radius);
  const elapsed = ((Date.now() - t0) / 1000).toFixed(1);

  console.log(`\n=== FINAL RESULT (${elapsed}s) ===`);
  console.log(JSON.stringify(result, null, 2));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
