/**
 * The Lotus buyer agent: one claim → 402 → preflight → human approval → jar pays → retry → result.
 *
 * Key separation (by design):
 *  - `jar` is connected to the AGENT signer: it relays signed spends and pays gas, nothing more.
 *  - `approver` signs the Spend only after a human approved it (Telegram button, dashboard, or terminal).
 *  - The LLM / agent logic never sees either private key; it only receives an approval yes/no.
 */
import { randomUUID } from "crypto";
import { Contract, Wallet, hexlify, randomBytes } from "ethers";
import type { LotusConfig } from "../config";
import { preflight, type PreflightDecision } from "../buyer/preflight";
import { encodeHeader, type PaymentHeader, type PaymentRequired } from "../x402/types";

export const JAR_ABI = [
  "function request((address token,address payTo,uint256 amount,bytes32 requestHash,uint256 nonce,uint64 validBefore) s, bytes signature) returns (bytes32)",
  "function remainingToday() view returns (uint256)",
  "function locked() view returns (bool)",
  "function lock(bytes32 reason)",
  "function unlock()",
  "function owner() view returns (address)",
  "function approver() view returns (address)",
  "function guardian() view returns (address)",
  "function caps() view returns (uint256 perTx, uint256 perDay, uint256 lifetime)",
  "function spentLifetime() view returns (uint256)",
  "function expiresAt() view returns (uint64)",
  "event SpendExecuted(bytes32 indexed id, address indexed token, address indexed payTo, uint256 amount, bytes32 requestHash)",
];

const SPEND_TYPES = {
  Spend: [
    { name: "token", type: "address" },
    { name: "payTo", type: "address" },
    { name: "amount", type: "uint256" },
    { name: "requestHash", type: "bytes32" },
    { name: "nonce", type: "uint256" },
    { name: "validBefore", type: "uint64" },
  ],
};

export type ApprovalCard = {
  runId: string;
  claim: string;
  desk: string;
  amount: string; // base units
  amountHuman: string;
  payTo: string;
  asset: string;
  requestHash: string;
  remainingToday: string;
  quoteExpiresAt: number;
  reasons: string[];
};

export type Approval = { approved: boolean; by: string };
export type Approver = (card: ApprovalCard) => Promise<Approval>;

export type RunStatus = "started" | "awaiting_approval" | "paying" | "done" | "declined" | "blocked" | "error";

export type RunRecord = {
  runId: string;
  claim: string;
  desk: string;
  status: RunStatus;
  startedAt: string;
  preflight?: PreflightDecision["decision"];
  preflightReasons?: string[];
  card?: ApprovalCard;
  approvedBy?: string;
  payTx?: string;
  result?: any;
  error?: string;
};

export type RunOptions = {
  api: string;
  cfg: LotusConfig;
  jar: Contract; // connected to the AGENT signer
  approver: Wallet; // approval key; used only after `approve` returns approved=true
  approve: Approver;
  claim: string;
  desk: string;
  maxPerCall?: bigint;
  onUpdate?: (r: RunRecord) => void;
  fetchImpl?: typeof fetch;
};

const fmt = (units: string | bigint, decimals: number) => (Number(units) / 10 ** decimals).toString();

export async function runCheck(o: RunOptions): Promise<RunRecord> {
  const f = o.fetchImpl ?? fetch;
  const rec: RunRecord = { runId: randomUUID(), claim: o.claim, desk: o.desk, status: "started", startedAt: new Date().toISOString() };
  const update = (patch: Partial<RunRecord>) => {
    Object.assign(rec, patch);
    o.onUpdate?.({ ...rec });
  };
  update({});

  try {
    const body = { claim: o.claim, desk: o.desk };
    const first = await f(`${o.api}/v1/score`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    if (first.status === 200) {
      // Free answer (e.g. a trade request refused before quoting): nothing to pay, nothing to approve.
      update({ status: "done", preflight: "do_not_pay", preflightReasons: ["FREE_REFUSAL"], result: await first.json() });
      return rec;
    }
    if (first.status !== 402) {
      const txt = await first.text();
      update({ status: "error", error: `expected 402, got ${first.status}: ${txt.slice(0, 200)}` });
      return rec;
    }
    const required = (await first.json()) as PaymentRequired;

    if (await o.jar.locked()) {
      update({ status: "blocked", preflight: "do_not_pay", preflightReasons: ["JAR_LOCKED"] });
      return rec;
    }
    const remaining = (await o.jar.remainingToday()) as bigint;
    const caps = await o.jar.caps();
    const spentLifetime = (await o.jar.spentLifetime()) as bigint;
    const lifetimeLeft = caps.lifetime > spentLifetime ? (caps.lifetime as bigint) - spentLifetime : 0n;
    const pf = preflight(
      {
        kind: "buy_evidence", method: "POST", route: "/v1/score", body,
        maxAmount: o.maxPerCall ?? 500_000n, remainingToday: remaining,
        perTxCap: caps.perTx as bigint, remainingLifetime: lifetimeLeft,
        chainId: o.cfg.chainId, network: o.cfg.network, allowedAssets: [o.cfg.asset], allowedPayTo: [o.cfg.treasury],
      },
      required,
      { preferScheme: "lotus-jar" },
    );
    update({ preflight: pf.decision, preflightReasons: pf.reasons });
    if (pf.decision === "do_not_pay" || !pf.requirement || pf.requirement.scheme !== "lotus-jar") {
      update({ status: "blocked", preflightReasons: pf.requirement && pf.requirement.scheme !== "lotus-jar" ? ["NO_JAR_SCHEME"] : pf.reasons });
      return rec;
    }
    const r = pf.requirement;
    const card: ApprovalCard = {
      runId: rec.runId,
      claim: o.claim,
      desk: o.desk,
      amount: r.maxAmountRequired,
      amountHuman: fmt(r.maxAmountRequired, o.cfg.assetDecimals),
      payTo: r.payTo,
      asset: r.asset,
      requestHash: r.extra.requestHash,
      remainingToday: fmt(remaining, o.cfg.assetDecimals),
      quoteExpiresAt: r.extra.expiresAt,
      reasons: pf.reasons,
    };
    update({ status: "awaiting_approval", card });

    const decision = await o.approve(card);
    if (!decision.approved) {
      update({ status: "declined", approvedBy: decision.by });
      return rec;
    }
    update({ status: "paying", approvedBy: decision.by });

    const jarAddr = await o.jar.getAddress();
    const provider = o.jar.runner!.provider!;
    const { chainId } = await provider.getNetwork();
    // Signature expiry is checked against block time, so derive it from the chain, not the local clock.
    const chainNow = (await provider.getBlock("latest"))!.timestamp;
    const spend = {
      token: r.asset,
      payTo: r.payTo,
      amount: BigInt(r.maxAmountRequired),
      requestHash: r.extra.requestHash,
      nonce: BigInt(hexlify(randomBytes(16))),
      validBefore: BigInt(chainNow + 300),
    };
    const sig = await o.approver.signTypedData(
      { name: "LotusJar", version: "1", chainId, verifyingContract: jarAddr },
      SPEND_TYPES,
      spend,
    );
    const tx = await o.jar.request(spend, sig);
    await tx.wait();
    update({ payTx: tx.hash });

    const header: PaymentHeader = {
      x402Version: 1, scheme: "lotus-jar", network: o.cfg.network, quoteId: r.extra.quoteId, payload: { txHash: tx.hash, jar: jarAddr },
    };
    const paid = await f(`${o.api}/v1/score`, {
      method: "POST",
      headers: { "content-type": "application/json", "X-PAYMENT": encodeHeader(header) },
      body: JSON.stringify(body),
    });
    const out = await paid.json();
    if (paid.status !== 200) {
      update({ status: "error", error: `paid request refused: ${out.error ?? paid.status}` });
      return rec;
    }
    update({ status: "done", result: out });
    return rec;
  } catch (e: any) {
    update({ status: "error", error: e?.shortMessage ?? e?.message ?? String(e) });
    return rec;
  }
}
