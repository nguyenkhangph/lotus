/**
 * Runs all red-team scenarios and prints a pass/fail table.
 * The result set is hashed so the demo can show a replayable, tamper-evident run.
 *   npm run redteam            (engine + payment layers + contract tests)
 *   npm run redteam -- --no-contract
 */
import { spawnSync } from "child_process";
import fs from "fs";
import path from "path";
import { Wallet } from "ethers";
import { SCENARIOS, AS_OF, type Scenario } from "./scenarios";
import { getDesk } from "../src/engine/desks";
import { scoreClaim } from "../src/engine/score";
import { preflight, type BuyerIntent } from "../src/buyer/preflight";
import { oracleGuard } from "../src/buyer/oracle";
import { QuoteBook } from "../src/x402/server";
import { FakeChain } from "../src/x402/fakeChain";
import { loadConfig } from "../src/config";
import { hashJson, requestHash } from "../src/util/hash";
import type { PaymentHeader } from "../src/x402/types";

type Row = { id: string; title: string; layer: string; pass: boolean; got: string };

const NOW = Math.floor(Date.parse(AS_OF) / 1000);
const JAR = Wallet.createRandom().address;
const TREASURY = "0x000000000000000000000000000000000000aaaa";
const cfg = {
  ...loadConfig({}),
  treasury: TREASURY,
  jarFactory: "0x000000000000000000000000000000000000fac7",
};
const ROUTE = "/v1/score";
const BODY = { claim: "BLS reported payrolls rose last month", desk: "macro_whitehouse" };

function baseIntent(): BuyerIntent {
  return {
    kind: "buy_evidence", method: "POST", route: ROUTE, body: BODY,
    maxAmount: 500_000n, remainingToday: 5_000_000n,
    chainId: cfg.chainId, network: cfg.network, allowedAssets: [cfg.asset], allowedPayTo: [TREASURY],
  };
}

function quote() {
  const book = new QuoteBook(cfg, () => NOW);
  return { book, ...book.issue(ROUTE, requestHash("POST", ROUTE, BODY)) };
}

async function runPayment(s: Extract<Scenario, { layer: "preflight" | "verify" | "oracle" }>): Promise<Row> {
  let got = "";
  if (s.layer === "oracle") {
    const r = oracleGuard({ source: "A", price: 3000, updatedAt: NOW }, { source: "B", price: 3450, updatedAt: NOW }, { maxBps: 200, maxAgeSec: 120, now: NOW });
    got = r.ok ? "ok" : r.reason;
    return { id: s.id, title: s.title, layer: s.layer, pass: got === s.expect.reason, got };
  }
  if (s.layer === "preflight") {
    const { body } = quote();
    const req = structuredClone(body);
    const intent = baseIntent();
    for (const a of req.accepts) {
      if (s.attack === "swap_payTo") a.payTo = "0x000000000000000000000000000000000000bbbb";
      if (s.attack === "inflate_amount") a.maxAmountRequired = "50000000";
      if (s.attack === "lookalike_asset") a.asset = "0x000000000000000000000000000000000000c0de";
    }
    if (s.attack === "body_swap") intent.body = { claim: "buy ETH now", desk: "btc_ta" };
    const r = preflight(intent, req, { now: NOW });
    got = `${r.decision}:${r.reasons.join(",")}`;
    return { id: s.id, title: s.title, layer: s.layer, pass: r.decision === s.expect.decision && r.reasons.includes(s.expect.reason), got };
  }
  // verify layer
  const chain = new FakeChain();
  chain.jars.add(JAR.toLowerCase());
  const { book, quote: q } = quote();
  const tx = "0x" + "ab".repeat(32);
  chain.addJarPayment({ txHash: tx, jar: JAR, asset: cfg.asset, payTo: TREASURY, amount: q.amount, requestHash: q.requestHash });
  const header: PaymentHeader = { x402Version: 1, scheme: "lotus-jar", network: cfg.network, quoteId: q.id, payload: { txHash: tx, jar: JAR } };
  if (s.attack === "body_swap") {
    const r = await book.verify(header, requestHash("POST", ROUTE, { claim: "buy ETH now", desk: "btc_ta" }), ROUTE, chain);
    got = r.ok ? "ok" : r.reason;
  } else if (s.attack === "replay_tx") {
    const first = await book.verify(header, q.requestHash, ROUTE, chain);
    const second = await book.verify(header, q.requestHash, ROUTE, chain);
    got = `${first.ok ? "ok" : first.reason} → ${second.ok ? "ok" : second.reason}`;
    return { id: s.id, title: s.title, layer: s.layer, pass: first.ok && !second.ok && second.reason === s.expect.reason, got };
  }
  return { id: s.id, title: s.title, layer: s.layer, pass: got === s.expect.reason, got };
}

function runContractTests(): Map<string, boolean> {
  const out = spawnSync("npx", ["hardhat", "test"], { cwd: path.join(__dirname, ".."), encoding: "utf8", shell: process.platform === "win32" });
  const text = (out.stdout ?? "") + (out.stderr ?? "");
  const res = new Map<string, boolean>();
  for (const line of text.split("\n")) {
    const pass = line.match(/^\s+[✔✓√] (.+?)(?: \(\d+ms\))?\r?$/);
    const fail = line.match(/^\s+\d+\) (.+?)\r?$/);
    if (pass) res.set(pass[1].trim(), true);
    else if (fail) res.set(fail[1].trim(), false);
  }
  return res;
}

async function main() {
  const withContract = !process.argv.includes("--no-contract");
  const contract = withContract ? runContractTests() : new Map<string, boolean>();
  const rows: Row[] = [];

  for (const s of SCENARIOS) {
    if (s.layer === "engine") {
      const r = scoreClaim({ text: s.claim, desk: s.desk, asOf: AS_OF }, getDesk(s.desk), s.items);
      const okVerdict = s.expect.verdictIn.includes(r.verdict);
      const okReasons = (s.expect.reasonIncludes ?? []).every((c) => r.reasonCodes.includes(c));
      const okScore = s.expect.maxScore === undefined || r.score <= s.expect.maxScore;
      const okInd = s.expect.maxIndependent === undefined || r.independentSupport <= s.expect.maxIndependent;
      rows.push({
        id: s.id, title: s.title, layer: s.layer, pass: okVerdict && okReasons && okScore && okInd,
        got: `${r.verdict} score=${r.score} ind=${r.independentSupport} echo=${r.echoIndex} [${r.reasonCodes.join(",")}]`,
      });
    } else if (s.layer === "contract") {
      if (!withContract) {
        rows.push({ id: s.id, title: s.title, layer: s.layer, pass: true, got: "skipped (--no-contract)" });
        continue;
      }
      const hits = [...contract.entries()].filter(([t]) => t.startsWith(s.grep + ":"));
      const pass = hits.length > 0 && hits.every(([, ok]) => ok);
      rows.push({ id: s.id, title: s.title, layer: s.layer, pass, got: hits.length ? `${hits.length} hardhat test(s) ${pass ? "passed" : "FAILED"}` : "no matching test" });
    } else {
      rows.push(await runPayment(s));
    }
  }

  const passed = rows.filter((r) => r.pass).length;
  const pad = (s: string, n: number) => (s.length > n ? s.slice(0, n - 1) + "…" : s.padEnd(n));
  console.log(`\nLotus Red Team — ${AS_OF} (SYNTHETIC fixtures)\n`);
  console.log(`${pad("ID", 8)}${pad("LAYER", 11)}${pad("RESULT", 8)}${pad("SCENARIO", 48)}GOT`);
  for (const r of rows) console.log(`${pad(r.id, 8)}${pad(r.layer, 11)}${pad(r.pass ? "PASS" : "FAIL", 8)}${pad(r.title, 48)}${r.got}`);
  const report = { asOf: AS_OF, passed, total: rows.length, rows };
  const resultHash = hashJson(report);
  fs.writeFileSync(path.join(__dirname, "report.json"), JSON.stringify({ ...report, resultHash }, null, 2));
  console.log(`\n${passed}/${rows.length} passed · result hash ${resultHash}\n`);
  if (passed !== rows.length) process.exit(1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
