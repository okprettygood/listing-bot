import { scrapeEbaySoldComps } from "../lib/ebay-scraper";

const query =
  process.argv[2] ?? "PowerBlock Elite EXP 90 Adjustable Dumbbells";

async function main() {
  console.log(`\n=== test-ebay-scraper ===`);
  console.log(`query: ${query}\n`);

  const t0 = Date.now();
  const result = await scrapeEbaySoldComps(query);
  const elapsed = ((Date.now() - t0) / 1000).toFixed(1);

  console.log(`\n=== FINAL RESULT (${elapsed}s) ===`);
  console.log(JSON.stringify(result, null, 2));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
