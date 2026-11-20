/**
 * Checks the HOSE source from this machine: lists what Lotus would cite for a ticker.
 *   npm run hose -- GDA "cổ tức"
 */
import { HoseNewsProvider } from "../src/evidence/providers";
import { getDesk } from "../src/engine/desks";

async function main() {
  const ticker = (process.argv[2] ?? "").toUpperCase();
  const words = process.argv[3] ?? "cổ tức";
  if (!ticker) return console.log('Cách dùng: npm run hose -- <MÃ> "cổ tức"');
  const items = await new HoseNewsProvider().fetch({ text: `${ticker} ${words}`, desk: "vn_stocks" }, getDesk("vn_stocks"));
  if (!items.length) return console.log(`HOSE không có công bố nào của ${ticker} trong 120 giờ gần nhất (hoặc mã không niêm yết trên HOSE).`);
  for (const i of items) console.log(`${i.stance === "supports" ? "+" : " "} ${i.publishedAt}  ${i.text.slice(0, 90)}\n    ${i.url}`);
}

main().catch((e) => {
  console.error(e?.message ?? e);
  process.exit(1);
});
