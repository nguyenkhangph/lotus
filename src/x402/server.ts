import { randomUUID } from "crypto";
import { Interface, getAddress, verifyTypedData } from "ethers";
import type { LotusConfig } from "../config";
import { maxPrice } from "../config";
import type { ExactPayload, JarPayload, PaymentHeader, PaymentRequired, PaymentRequirement, VerifyResult } from "./types";

export type Quote = {
  id: string;
  requestHash: string;
  route: string;
  amount: bigint;
  expiresAt: number;
  status: "open" | "paid";
  exact?: PaymentRequirement; // the "exact" terms we offered, passed to a facilitator on settle
};

/** Minimal chain access so tests can swap in a fake chain. */
export interface ChainReader {
  getReceipt(txHash: string): Promise<{ status: number; logs: { address: string; topics: string[]; data: string }[] } | null>;
  isJar(addr: string): Promise<boolean>;
  /** Submits USDC.transferWithAuthorization (facilitator role). Returns tx hash. */
  settleExact(p: ExactPayload, req: PaymentRequirement): Promise<string>;
}

export const JAR_IFACE = new Interface([
  "event SpendExecuted(bytes32 indexed id, address indexed token, address indexed payTo, uint256 amount, bytes32 requestHash)",
]);
export const ERC20_IFACE = new Interface(["event Transfer(address indexed from, address indexed to, uint256 value)"]);

const TWA_TYPES = {
  TransferWithAuthorization: [
    { name: "from", type: "address" },
    { name: "to", type: "address" },
    { name: "value", type: "uint256" },
    { name: "validAfter", type: "uint256" },
    { name: "validBefore", type: "uint256" },
    { name: "nonce", type: "bytes32" },
  ],
};

export class QuoteBook {
  private quotes = new Map<string, Quote>();
  private usedRefs = new Set<string>(); // tx hashes / EIP-3009 nonces already accepted

  constructor(private cfg: LotusConfig, private now: () => number = () => Math.floor(Date.now() / 1000)) {}

  issue(route: string, requestHash: string): { quote: Quote; body: PaymentRequired } {
    const q: Quote = {
      id: randomUUID(),
      requestHash,
      route,
      amount: maxPrice(this.cfg),
      expiresAt: this.now() + this.cfg.quoteTtlSeconds,
      status: "open",
    };
    const common = {
      network: this.cfg.network,
      chainId: this.cfg.chainId,
      maxAmountRequired: q.amount.toString(),
      resource: route,
      description: "Lotus evidence score for one claim (upto pricing by independent sources delivered)",
      mimeType: "application/json",
      payTo: this.cfg.treasury,
      maxTimeoutSeconds: this.cfg.quoteTtlSeconds,
      asset: this.cfg.asset,
    };
    const extra = {
      name: this.cfg.assetDomainName,
      version: this.cfg.assetDomainVersion,
      requestHash,
      quoteId: q.id,
      expiresAt: q.expiresAt,
      pricing: {
        model: "upto" as const,
        base: this.cfg.pricing.base.toString(),
        perSource: this.cfg.pricing.perSource.toString(),
        maxSources: this.cfg.pricing.maxSources,
      },
    };
    const accepts: PaymentRequirement[] = [
      { scheme: "exact", ...common, extra },
      ...(this.cfg.jarFactory
        ? [{ scheme: "lotus-jar" as const, ...common, extra: { ...extra, jarFactory: this.cfg.jarFactory } }]
        : []),
    ];
    q.exact = accepts[0];
    this.quotes.set(q.id, q);
    return { quote: q, body: { x402Version: 1, error: "X-PAYMENT header is required", accepts } };
  }

  get(id: string) {
    return this.quotes.get(id);
  }

  /**
   * Verifies a payment header against an open quote AND the request actually being made now.
   * The request hash is recomputed by the caller from the live request: a body swap (RT-21) fails here.
   */
  async verify(header: PaymentHeader, liveRequestHash: string, liveRoute: string, chain: ChainReader): Promise<VerifyResult> {
    const q = this.quotes.get(header.quoteId);
    if (!q) return { ok: false, reason: "UNKNOWN_QUOTE" };
    if (q.status !== "open") return { ok: false, reason: "QUOTE_ALREADY_PAID" };
    if (this.now() > q.expiresAt) return { ok: false, reason: "QUOTE_EXPIRED" };
    if (q.route !== liveRoute) return { ok: false, reason: "ROUTE_MISMATCH" };
    if (q.requestHash !== liveRequestHash) return { ok: false, reason: "REQUEST_BODY_CHANGED" };
    if (header.network !== this.cfg.network) return { ok: false, reason: "WRONG_NETWORK" };

    const res = header.scheme === "exact"
      ? await this.verifyExact(header.payload as ExactPayload, q, chain)
      : header.scheme === "lotus-jar"
        ? await this.verifyJar(header.payload as JarPayload, q, chain)
        : ({ ok: false, reason: "UNKNOWN_SCHEME" } as VerifyResult);

    if (res.ok) {
      q.status = "paid";
      this.usedRefs.add(res.ref.toLowerCase());
    }
    return res;
  }

  private async verifyExact(p: ExactPayload, q: Quote, chain: ChainReader): Promise<VerifyResult> {
    const a = p.authorization;
    const t = this.now();
    if (getAddress(a.to) !== getAddress(this.cfg.treasury)) return { ok: false, reason: "PAYTO_MISMATCH" };
    if (BigInt(a.value) < q.amount) return { ok: false, reason: "AMOUNT_TOO_LOW" };
    if (BigInt(a.value) > q.amount) return { ok: false, reason: "AMOUNT_ABOVE_QUOTE" };
    if (BigInt(a.validAfter) > BigInt(t) || BigInt(a.validBefore) <= BigInt(t)) return { ok: false, reason: "AUTH_TIME_WINDOW" };
    if (a.nonce.toLowerCase() !== q.requestHash.toLowerCase()) return { ok: false, reason: "NONCE_NOT_BOUND_TO_REQUEST" };
    if (this.usedRefs.has(a.nonce.toLowerCase())) return { ok: false, reason: "REPLAY" };
    const domain = {
      name: this.cfg.assetDomainName,
      version: this.cfg.assetDomainVersion,
      chainId: this.cfg.chainId,
      verifyingContract: this.cfg.asset,
    };
    let signer: string;
    try {
      signer = verifyTypedData(domain, TWA_TYPES, a, p.signature);
    } catch {
      return { ok: false, reason: "BAD_SIGNATURE" };
    }
    if (getAddress(signer) !== getAddress(a.from)) return { ok: false, reason: "BAD_SIGNATURE" };
    let txHash: string;
    try {
      txHash = await chain.settleExact(p, q.exact!);
    } catch (e) {
      return { ok: false, reason: "SETTLEMENT_FAILED" };
    }
    return { ok: true, payer: signer, amount: BigInt(a.value), ref: a.nonce, tx: txHash };
  }

  private async verifyJar(p: JarPayload, q: Quote, chain: ChainReader): Promise<VerifyResult> {
    if (this.usedRefs.has(p.txHash.toLowerCase())) return { ok: false, reason: "REPLAY" };
    if (!(await chain.isJar(p.jar))) return { ok: false, reason: "NOT_A_LOTUS_JAR" };
    const rc = await chain.getReceipt(p.txHash);
    if (!rc || rc.status !== 1) return { ok: false, reason: "TX_NOT_FOUND_OR_FAILED" };

    const jar = getAddress(p.jar);
    const treasury = getAddress(this.cfg.treasury);
    const asset = getAddress(this.cfg.asset);
    let spendOk = false;
    let transferOk = false;
    for (const log of rc.logs) {
      const addr = getAddress(log.address);
      if (addr === jar) {
        const ev = JAR_IFACE.parseLog(log);
        if (
          ev?.name === "SpendExecuted" &&
          getAddress(ev.args.token) === asset &&
          getAddress(ev.args.payTo) === treasury &&
          BigInt(ev.args.amount) === q.amount &&
          String(ev.args.requestHash).toLowerCase() === q.requestHash.toLowerCase()
        ) spendOk = true;
      } else if (addr === asset) {
        const ev = ERC20_IFACE.parseLog(log);
        if (
          ev?.name === "Transfer" &&
          getAddress(ev.args.from) === jar &&
          getAddress(ev.args.to) === treasury &&
          BigInt(ev.args.value) === q.amount
        ) transferOk = true;
      }
    }
    if (!spendOk) return { ok: false, reason: "NO_MATCHING_SPEND_FOR_REQUEST" };
    if (!transferOk) return { ok: false, reason: "NO_MATCHING_TOKEN_TRANSFER" };
    return { ok: true, payer: jar, amount: q.amount, ref: p.txHash, tx: p.txHash };
  }
}

/** Actual price under `upto`: base + perSource × independent units delivered, never above the ceiling. */
export function earned(cfg: LotusConfig, independentUnits: number): bigint {
  const n = BigInt(Math.min(independentUnits, cfg.pricing.maxSources));
  return cfg.pricing.base + cfg.pricing.perSource * n;
}
