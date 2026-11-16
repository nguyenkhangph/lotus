/**
 * Jar admin from the terminal.
 *   npm run jar -- status
 *   npm run jar -- lock      (GUARDIAN_PRIVATE_KEY, or the owner key)
 *   npm run jar -- unlock    (owner only = DEPLOYER_PRIVATE_KEY; the bot can never unlock)
 *   npm run jar -- extend 30 (owner only; jar expires 30 days from now, other timing kept)
 *   npm run jar -- refund-backlog            (checks every receipt against the explorer: refunded or not)
 *   npm run jar -- refund-backlog --send     (TREASURY_PRIVATE_KEY refunds only the receipts with no refund on-chain)
 *     Optional receipt numbers limit it, e.g. refund-backlog 0 1 2 3 --send.
 *   npm run jar -- rules "Mỗi lần tối đa 0,5 USDC. Mỗi ngày không quá 3 USDC."          (preview + simulation)
 *   npm run jar -- wallets   (main wallet, spending jar, invoice wallet)
 *   npm run jar -- sweep     (pays the invoice wallet out by its on-chain split; any key with gas, here AGENT_PRIVATE_KEY)
 *   npm run jar -- rules "…" --send   (owner signs setCaps / setTiming / setPayTo with DEPLOYER_PRIVATE_KEY)
 */
import { Contract, JsonRpcProvider, Wallet } from "ethers";
import { loadConfig } from "../src/config";
import fs from "fs";
import { lockJar, readJar, sendRefund, unlockJar } from "../src/agent/jar";
import { previewRules } from "../src/rules/service";
import { readWallets, sweepInbox } from "../src/agent/wallets";
import { fetchJarTransfers, matchRefunds } from "../src/agent/refunds";

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
    // Checks the explorer first: only receipts with no matching treasury → jar refund are sent, so nothing is refunded twice.
    const args = process.argv.slice(3);
    const send = args.includes("--send");
    const force = args.includes("--force");
    const want = args.filter((a) => /^\d+$/.test(a)).map(Number);
    const path = fs.existsSync(cfg.ledgerPath) ? cfg.ledgerPath : "data/demo/ledger.jsonl";
    const rows = fs.readFileSync(path, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
    let matches: ReturnType<typeof matchRefunds> | null = null;
    try {
      matches = matchRefunds(rows, await fetchJarTransfers(jar, cfg.asset, cfg.chainId), jar, cfg.treasury);
    } catch (e: any) {
      console.log(`  ⚠ Không đọc được lịch sử giao dịch trên explorer (${e?.message}). Hãy tự kiểm tra trên Snowtrace.`);
    }
    const usd = (x: bigint) => (Number(x) / 1e6).toFixed(2);
    const todo: { i: number; amount: bigint }[] = [];
    for (const r of rows.sort((x: any, y: any) => x.index - y.index)) {
      if (want.length && !want.includes(r.index)) continue;
      const due = BigInt(r.pricing?.refundDue ?? 0);
      const m = matches?.find((x) => x.index === r.index);
      const tag = !m ? "chưa kiểm tra" : m.status === "refunded" ? `đã hoàn (tx ${m.refundTx})` : m.status === "missing" ? "CHƯA HOÀN" : m.status === "nothing_due" ? "không cần hoàn" : "không thấy giao dịch thanh toán";
      console.log(`  #${r.index}  ${usd(due)} USDC  ${tag}`);
      if (due > 0n && (m ? m.status === "missing" : force)) todo.push({ i: r.index, amount: due });
    }
    const total = todo.reduce((x, p) => x + p.amount, 0n);
    console.log(`\n  Sẽ hoàn: ${todo.length ? todo.map((p) => "#" + p.i).join(", ") : "không có"} · tổng ${usd(total)} USDC từ treasury về hũ ${jar}`);
    if (!matches && !force) console.log("  (Không kiểm tra được explorer nên không gửi gì. Đã tự kiểm tra trên Snowtrace thì thêm --force cùng danh sách số.)");
    if (!send || !todo.length) { if (todo.length) console.log("  Chạy thử. Thêm --send để gửi."); return; }
    if (!matches && !want.length) throw new Error("Với --force, ghi rõ số biên nhận cần hoàn, ví dụ: refund-backlog 0 1 2 3 --send --force");
    if (!process.env.TREASURY_PRIVATE_KEY) throw new Error("TREASURY_PRIVATE_KEY needed");
    const treasury = new Wallet(process.env.TREASURY_PRIVATE_KEY, provider);
    for (const p of todo) console.log(`  #${p.i} đã hoàn ${usd(p.amount)} USDC, tx ${await sendRefund(cfg, treasury, jar, p.amount)}`);
  } else if (cmd === "wallets") {
    const w = await readWallets(cfg, provider, await readJar(cfg, jar, provider), process.env.INBOX_ADDRESS || undefined);
    console.log(`  Ví chính     ${w.main.address}  ${w.main.usdc} USDC · ${w.main.avax} AVAX  (agent không có khoá)`);
    console.log(`  Hũ chi tiêu  ${w.jar.address}  ${w.jar.usdc} USDC  (agent chi trong hạn mức, còn ${w.jar.remainingToday}/${w.jar.perDay} hôm nay)`);
    if (w.inbox) console.log(`  Ví hoá đơn   ${w.inbox.address}  ${w.inbox.usdc} USDC  (chỉ nhận; chia: ${w.inbox.shares.map((x) => `${x.percent}% ${x.role}`).join(", ")})`);
    else console.log("  Ví hoá đơn   chưa triển khai: npm run deploy:inbox, rồi điền INBOX_ADDRESS");
  } else if (cmd === "sweep") {
    const inbox = process.env.INBOX_ADDRESS;
    const key = process.env.AGENT_PRIVATE_KEY ?? process.env.DEPLOYER_PRIVATE_KEY;
    if (!inbox || !key) throw new Error("INBOX_ADDRESS and AGENT_PRIVATE_KEY (or DEPLOYER_PRIVATE_KEY) needed");
    console.log("swept, tx", await sweepInbox(cfg, inbox, new Wallet(key, provider)));
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
    throw new Error("usage: npm run jar -- status|lock|unlock|extend <days>|refund-backlog <index...> [--send]|wallets|sweep|rules \"…\" [--send]");
  }
}

main().catch((e) => {
  console.error(e?.shortMessage ?? e?.message ?? e);
  process.exit(1);
});
