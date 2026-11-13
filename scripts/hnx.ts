/**
 * Lists recent HNX disclosures and the tickers found on their pages — to pick a live demo claim.
 *   npm run hnx -- "cổ tức"
 */
import { HnxRssProvider } from "../src/evidence/providers";

async function main() {
  const filter = process.argv[2] ?? "";
  const rows = await new HnxRssProvider().browse(filter, Number(process.argv[3] ?? 12));
  if (!rows.length) return console.log("Không có công bố nào khớp bộ lọc (hoặc feed không tải được).");
  for (const r of rows) {
    console.log(`${(r.ticker ?? "???").padEnd(5)} ${r.title.slice(0, 80)}`);
    console.log(`      ${r.url}  (${r.publishedAt})`);
  }
  const t = rows.find((r) => r.ticker)?.ticker;
  if (t && filter) console.log(`\nThử trên Telegram:  ${t} ${filter}`);
}

main().catch((e) => {
  console.error(e?.message ?? e);
  process.exit(1);
});
