/**
 * Terminal version of the Lotus buyer agent (same flow as the Telegram bot, approval typed as y/N):
 *   npm run demo:agent -- "US CPI rose last month" macro_whitehouse
 *
 * Keys: AGENT_PRIVATE_KEY relays and pays gas; APPROVER_PRIVATE_KEY signs only after you type y.
 */
import readline from "readline/promises";
import { Contract, JsonRpcProvider, Wallet } from "ethers";
import { loadConfig } from "../src/config";
import { JAR_ABI, runCheck } from "../src/agent/runner";

async function main() {
  const [claim, desk] = [process.argv[2], process.argv[3] ?? "macro_whitehouse"];
  if (!claim) throw new Error('usage: npm run demo:agent -- "<claim>" <desk>');
  const cfg = loadConfig();
  const provider = new JsonRpcProvider(cfg.rpcUrl, cfg.chainId);
  const r = await runCheck({
    api: process.env.LOTUS_API ?? "http://localhost:8402",
    cfg,
    jar: new Contract(process.env.JAR_ADDRESS!, JAR_ABI, new Wallet(process.env.AGENT_PRIVATE_KEY!, provider)),
    approver: new Wallet(process.env.APPROVER_PRIVATE_KEY!),
    claim,
    desk,
    maxPerCall: BigInt(process.env.MAX_PER_CALL ?? "500000"),
    approve: async (c) => {
      console.log(`preflight: pay (${c.reasons.join(", ")})`);
      console.log("\n— Phiếu duyệt / Approval card —");
      console.log(`  claim       : ${c.claim}  [desk ${c.desk}]`);
      console.log(`  amount      : ${c.amountHuman} test USDC (upto; unused part refunded or recorded as refundDue)`);
      console.log(`  payTo       : ${c.payTo}`);
      console.log(`  asset       : ${c.asset}`);
      console.log(`  requestHash : ${c.requestHash}`);
      console.log(`  remaining   : ${c.remainingToday} test USDC today`);
      const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
      const ans = (await rl.question("Duyệt khoản chi này? (y/N) ")).trim().toLowerCase();
      rl.close();
      return { approved: ans === "y", by: "terminal" };
    },
  });
  if (r.status !== "done") {
    console.log(`${r.status}: ${r.error ?? (r.preflightReasons ?? []).join(", ")}`);
    return;
  }
  const out = r.result;
  console.log(`jar payment tx ${r.payTx}`);
  console.log(JSON.stringify({
    verdict: out.verdict, score: out.score, independentSupport: out.independentSupport, echoIndex: out.echoIndex,
    reasonCodes: out.reasonCodes, receipt: out.receipt?.hash, anchorTx: out.receipt?.anchorTx, refundTx: out.receipt?.refundTx,
  }, null, 2));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
