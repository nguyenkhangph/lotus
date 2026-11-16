/**
 * Jar admin from the terminal.
 *   npm run jar -- status
 *   npm run jar -- lock      (GUARDIAN_PRIVATE_KEY, or the owner key)
 *   npm run jar -- unlock    (owner only = DEPLOYER_PRIVATE_KEY; the bot can never unlock)
 *   npm run jar -- extend 30 (owner only; jar expires 30 days from now, other timing kept)
 *   npm run jar -- refund-backlog 0 1 2 3          (dry run: shows what would be refunded)
 *   npm run jar -- refund-backlog 0 1 2 3 --send   (TREASURY_PRIVATE_KEY sends each receipt's refundDue to the jar)
 *     For receipts written before automatic refunds existed. Check on Snowtrace first: never refund an index twice.
 *   npm run jar -- rules "Mỗi lần tối đa 0,5 USDC. Mỗi ngày không quá 3 USDC."          (preview + simulation)
 *   npm run jar -- rules "…" --send   (owner signs setCaps / setTiming / setPayTo with DEPLOYER_PRIVATE_KEY)
 */
import { Contract, JsonRpcProvider, Wallet } from "ethers";
import { loadConfig } from "../src/config";
import fs from "fs";
import { lockJar, readJar, sendRefund, unlockJar } from "../src/agent/jar";
import { previewRules } from "../src/rules/service";

async function main() {
  const cmd = process.argv[2] ?? "status";
  const cfg = loadConfig();
  const provider = new JsonRpcProvider(cfg.rpcUrl, cfg.chainId);
  const jar = process.env.JAR_ADDRESS;
  if (!jar) throw new Error("JAR_ADDRESS missing in .env");
  if (cmd === "status") {
    console.log(await readJar(cfg, jar, provider));
  } else if (cmd === "lock") {
    const key = process.env.GUARDIAN_PRIVATE_KEY ?? process.env.DEPLOYER_PRIVATE_KEY;
    if (!key) throw new Error("GUARDIAN_PRIVATE_KEY or DEPLOYER_PRIVATE_KEY needed");
    console.log("locked, tx", await lockJar(jar, new Wallet(key, provider), "TERMINAL"));
  } else if (cmd === "unlock") {
    if (!process.env.DEPLOYER_PRIVATE_KEY) throw new Error("DEPLOYER_PRIVATE_KEY (jar owner) needed");
    console.log("unlocked, tx", await unlockJar(jar, new Wallet(process.env.DEPLOYER_PRIVATE_KEY, provider)));
  } else if (cmd === "extend") {
    const days = Number(process.argv[3] ?? "30");
    if (!(days > 0 && days <= 365)) throw new Error("usage: npm run jar -- extend <days 1..365>");
    if (!process.env.DEPLOYER_PRIVATE_KEY) throw new Error("DEPLOYER_PRIVATE_KEY (jar owner) needed");
    const abi = [
      "function delay() view returns (uint64)", "function expiresAt() view returns (uint64)",
      "function burstWindow() view returns (uint32)", "function burstMax() view returns (uint32)",
      "function setTiming(uint64,uint64,uint32,uint32)",
    ];
    const c = new Contract(jar, abi, new Wallet(process.env.DEPLOYER_PRIVATE_KEY, provider));
    const [delay, oldExp, bw, bm] = await Promise.all([c.delay(), c.expiresAt(), c.burstWindow(), c.burstMax()]);
    const now = (await provider.getBlock("latest"))!.timestamp;
    const exp = BigInt(now + Math.round(days * 86400));
    const tx = await c.setTiming(delay, exp, bw, bm);
    await tx.wait();
    const fmt = (t: bigint) => new Date(Number(t) * 1000).toISOString();
    console.log(`expiresAt ${fmt(oldExp)} -> ${fmt(exp)}, tx ${tx.hash}`);
  } else if (cmd === "refund-backlog") {
    const args = process.argv.slice(3);
    const send = args.includes("--send");
    const idx = args.filter((a) => /^\d+$/.test(a)).map(Number);
    if (!idx.length) throw new Error("usage: npm run jar -- refund-backlog <index...> [--send]");
    const path = fs.existsSync(cfg.ledgerPath) ? cfg.ledgerPath : "data/demo/ledger.jsonl";
    const rows = fs.readFileSync(path, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
    const picked = idx.map((i) => {
      const r = rows.find((x) => x.index === i);
      if (!r) throw new Error(`receipt #${i} not in ${path}`);
      return { i, amount: BigInt(r.pricing?.refundDue ?? 0), pay: r.payment?.ref };
    }).filter((p) => p.amount > 0n);
    const total = picked.reduce((a, p) => a + p.amount, 0n);
    for (const p of picked) console.log(`#${p.i}  refund ${Number(p.amount) / 1e6} USDC -> ${jar}  (payment ${p.pay})`);
    console.log(`total ${Number(total) / 1e6} USDC from ${path}`);
    if (!send) { console.log("dry run. Add --send to transfer."); return; }
    if (!process.env.TREASURY_PRIVATE_KEY) throw new Error("TREASURY_PRIVATE_KEY needed");
    const treasury = new Wallet(process.env.TREASURY_PRIVATE_KEY, provider);
    for (const p of picked) console.log(`#${p.i} refunded, tx ${await sendRefund(cfg, treasury, jar, p.amount)}`);
  } else if (cmd === "rules") {
    const args = process.argv.slice(3);
    const send = args.includes("--send");
    const text = args.filter((a) => a !== "--send").join(" ").trim();
    if (!text) throw new Error('usage: npm run jar -- rules "<quy tắc tiếng Việt>" [--send]');
    const st = await readJar(cfg, jar, provider);
    const now = (await provider.getBlock("latest"))!.timestamp;
    const p = previewRules(text, st, cfg.treasury, now);
    for (const u of p.understood) console.log(`  ✔ ${u.text}`);
    for (const u of p.unknown) console.log(`  ⚠ "${u.clause}": ${u.why}`);
    for (const w of p.warnings) console.log(`  ℹ ${w}`);
    console.log("\n  Mô phỏng (hiện tại → mới):");
    for (const s of p.scenarios) console.log(`  - ${s.title}: ${s.current.paid} được chi → ${s.proposed.paid} được chi${s.proposed.blocked ? ` (chặn: ${s.proposed.first})` : ""}`);
    if (!p.calls.length) { console.log("\n  Không có gì thay đổi trên hợp đồng."); return; }
    console.log("\n  Giao dịch chủ hũ sẽ ký:");
    for (const c of p.calls) console.log(`  · ${c.fn}(${c.args})  — ${c.why}`);
    if (!send) { console.log("\n  Chạy thử. Thêm --send để ký bằng ví chủ (DEPLOYER_PRIVATE_KEY)."); return; }
    if (p.unknown.length) throw new Error("Còn câu chưa hiểu. Sửa hoặc bỏ các câu đó rồi chạy lại, để thứ được ký đúng với thứ anh đã viết.");
    if (!process.env.DEPLOYER_PRIVATE_KEY) throw new Error("DEPLOYER_PRIVATE_KEY (jar owner) needed");
    const owner = new Wallet(process.env.DEPLOYER_PRIVATE_KEY, provider);
    for (const c of p.calls) {
      const tx = await owner.sendTransaction({ to: jar, data: c.data });
      await tx.wait();
      console.log(`  ${c.fn} ✓ tx ${tx.hash}`);
    }
  } else {
    throw new Error("usage: npm run jar -- status|lock|unlock|extend <days>|refund-backlog <index...> [--send]|rules \"…\" [--send]");
  }
}

main().catch((e) => {
  console.error(e?.shortMessage ?? e?.message ?? e);
  process.exit(1);
});
