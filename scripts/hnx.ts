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
    console.log(`${(r.tickers[0] ?? "???").padEnd(5)} ${r.title.slice(0, 80)}`);
    console.log(`      ${r.url}  (${r.publishedAt})  mã khác trên trang: ${r.tickers.slice(1).join(", ") || "—"}`);
  }
  const t = rows.find((r) => r.tickers[0])?.tickers[0];
  if (t && filter) console.log(`\nThử trên Telegram:  ${t} ${filter}`);
}

main().catch((e) => {
  console.error(e?.message ?? e);
  process.exit(1);
});
