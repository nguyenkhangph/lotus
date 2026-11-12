/**
 * Agent-side demo client, run against a live Lotus API on Fuji:
 *   npx ts-node --transpile-only scripts/agent-demo.ts "US CPI rose last month" macro_whitehouse
 *
 * Roles (separate keys on purpose):
 *   - AGENT_PRIVATE_KEY     : relays the signed spend and pays gas. Cannot move jar funds by itself.
 *   - APPROVER_PRIVATE_KEY  : the human's approval key (later: held by the Telegram bot after the user taps
 *                             "Duyệt"). Never given to the LLM.
 * Flow: request → 402 → preflight → approval card → human types y → sign Spend → jar pays → retry → result.
 */
import readline from "readline/promises";
import { Contract, JsonRpcProvider, Wallet, randomBytes, hexlify } from "ethers";
import { loadConfig } from "../src/config";
import { preflight } from "../src/buyer/preflight";
import { encodeHeader, type PaymentRequired, type PaymentHeader } from "../src/x402/types";

const JAR_ABI = [
  "function request((address token,address payTo,uint256 amount,bytes32 requestHash,uint256 nonce,uint64 validBefore) s, bytes signature) returns (bytes32)",
  "function remainingToday() view returns (uint256)",
  "function locked() view returns (bool)",
];

async function main() {
  const [claim, desk] = [process.argv[2], process.argv[3] ?? "macro_whitehouse"];
  if (!claim) throw new Error('usage: agent-demo.ts "<claim>" <desk>');
  const cfg = loadConfig();
  const api = process.env.LOTUS_API ?? "http://localhost:8402";
  const jarAddr = process.env.JAR_ADDRESS!;
  const provider = new JsonRpcProvider(cfg.rpcUrl, cfg.chainId);
  const agent = new Wallet(process.env.AGENT_PRIVATE_KEY!, provider);
  const approver = new Wallet(process.env.APPROVER_PRIVATE_KEY!);
  const jar = new Contract(jarAddr, JAR_ABI, agent);

  const body = { claim, desk };
  const first = await fetch(`${api}/v1/score`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  if (first.status !== 402) throw new Error(`expected 402, got ${first.status}`);
  const required = (await first.json()) as PaymentRequired;

  const remaining = (await jar.remainingToday()) as bigint;
  const pf = preflight(
    {
      kind: "buy_evidence", method: "POST", route: "/v1/score", body,
      maxAmount: BigInt(process.env.MAX_PER_CALL ?? "500000"), remainingToday: remaining,
      chainId: cfg.chainId, network: cfg.network, allowedAssets: [cfg.asset], allowedPayTo: [cfg.treasury],
    },
    required,
    { preferScheme: "lotus-jar" },
  );
  console.log(`preflight: ${pf.decision} (${pf.reasons.join(", ")})`);
  if (pf.decision === "do_not_pay" || !pf.requirement) return;
  const r = pf.requirement;

  console.log("\n— Phiếu duyệt / Approval card —");
  console.log(`  claim       : ${claim}  [desk ${desk}]`);
  console.log(`  amount      : ${Number(r.maxAmountRequired) / 1e6} test USDC (upto; unused part recorded as refundDue)`);
  console.log(`  payTo       : ${r.payTo}`);
  console.log(`  asset       : ${r.asset}`);
  console.log(`  requestHash : ${r.extra.requestHash}`);
  console.log(`  remaining   : ${Number(remaining) / 1e6} test USDC today`);
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const ans = (await rl.question("Duyệt khoản chi này? (y/N) ")).trim().toLowerCase();
  rl.close();
  if (ans !== "y") return console.log("Không duyệt. Không trả tiền.");

  const { chainId } = await provider.getNetwork();
  const spend = {
    token: r.asset,
    payTo: r.payTo,
    amount: BigInt(r.maxAmountRequired),
    requestHash: r.extra.requestHash,
    nonce: BigInt(hexlify(randomBytes(16))),
    validBefore: BigInt(Math.floor(Date.now() / 1000) + 300),
  };
  const sig = await approver.signTypedData(
    { name: "LotusJar", version: "1", chainId, verifyingContract: jarAddr },
    {
      Spend: [
        { name: "token", type: "address" }, { name: "payTo", type: "address" }, { name: "amount", type: "uint256" },
        { name: "requestHash", type: "bytes32" }, { name: "nonce", type: "uint256" }, { name: "validBefore", type: "uint64" },
      ],
    },
    spend,
  );
  const tx = await jar.request(spend, sig);
  console.log(`jar payment tx ${tx.hash}`);
  await tx.wait();

  const header: PaymentHeader = { x402Version: 1, scheme: "lotus-jar", network: cfg.network, quoteId: r.extra.quoteId, payload: { txHash: tx.hash, jar: jarAddr } };
  const paid = await fetch(`${api}/v1/score`, {
    method: "POST",
    headers: { "content-type": "application/json", "X-PAYMENT": encodeHeader(header) },
    body: JSON.stringify(body),
  });
  const out = await paid.json();
  console.log(JSON.stringify({ verdict: out.verdict, score: out.score, independentSupport: out.independentSupport, echoIndex: out.echoIndex, reasonCodes: out.reasonCodes, receipt: out.receipt?.hash, anchorTx: out.receipt?.anchorTx }, null, 2));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
