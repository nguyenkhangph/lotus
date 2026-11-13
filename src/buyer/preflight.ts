import { getAddress } from "ethers";
import { requestHash } from "../util/hash";
import type { PaymentRequired, PaymentRequirement } from "../x402/types";

/**
 * What the agent declared it is about to do, BEFORE it saw the 402.
 * The quote must match this intent, otherwise the buyer does not pay.
 */
export type BuyerIntent = {
  kind: "buy_evidence"; // the only kind Lotus agents may pay for
  method: string;
  route: string;
  body: unknown;
  maxAmount: bigint; // per-call ceiling the user set
  remainingToday: bigint; // from the jar / wallet policy
  perTxCap?: bigint; // the jar's on-chain per-transaction cap (checked here so a bad quote is never signed)
  remainingLifetime?: bigint; // the jar's lifetime cap minus what it already spent
  chainId: number;
  network: string;
  allowedAssets: string[]; // addresses, never symbols
  allowedPayTo: string[];
};

export type PreflightDecision = {
  decision: "pay" | "review" | "do_not_pay";
  reasons: string[];
  requirement?: PaymentRequirement;
};

const eq = (a: string, b: string) => {
  try {
    return getAddress(a) === getAddress(b);
  } catch {
    return false;
  }
};

/**
 * Buyer-side gate run before anything is signed. Fails closed: any hard mismatch → do_not_pay.
 * Soft issues (close to cap, long expiry) → review, which means "ask the human".
 */
export function preflight(
  intent: BuyerIntent,
  required: PaymentRequired,
  opts: { now?: number; paidQuoteIds?: Set<string>; preferScheme?: "exact" | "lotus-jar" } = {},
): PreflightDecision {
  const now = opts.now ?? Math.floor(Date.now() / 1000);
  if (intent.kind !== "buy_evidence") return { decision: "do_not_pay", reasons: ["INTENT_NOT_ALLOWED"] };
  if (!required?.accepts?.length) return { decision: "do_not_pay", reasons: ["NO_PAYMENT_TERMS"] };

  const expectedHash = requestHash(intent.method, intent.route, intent.body);
  const candidates = [...required.accepts].sort((a, b) =>
    a.scheme === (opts.preferScheme ?? "lotus-jar") ? -1 : b.scheme === (opts.preferScheme ?? "lotus-jar") ? 1 : 0,
  );

  let lastHard: string[] = [];
  for (const r of candidates) {
    const hard: string[] = [];
    const soft: string[] = [];
    if (r.chainId !== intent.chainId || r.network !== intent.network) hard.push("WRONG_NETWORK");
    if (!intent.allowedAssets.some((a) => eq(a, r.asset))) hard.push("ASSET_NOT_WHITELISTED");
    if (!intent.allowedPayTo.some((p) => eq(p, r.payTo))) hard.push("PAYTO_NOT_WHITELISTED");
    if (r.resource !== intent.route) hard.push("ROUTE_MISMATCH");
    if (!r.extra?.requestHash || r.extra.requestHash.toLowerCase() !== expectedHash.toLowerCase()) hard.push("QUOTE_NOT_FOR_THIS_REQUEST");
    let amount: bigint;
    try {
      amount = BigInt(r.maxAmountRequired);
    } catch {
      amount = -1n;
    }
    if (amount <= 0n) hard.push("BAD_AMOUNT");
    if (amount > intent.maxAmount) hard.push("AMOUNT_ABOVE_USER_MAX");
    if (amount > intent.remainingToday) hard.push("AMOUNT_ABOVE_REMAINING_CAP");
    if (intent.perTxCap !== undefined && amount > intent.perTxCap) hard.push("AMOUNT_ABOVE_JAR_PER_TX_CAP");
    if (intent.remainingLifetime !== undefined && amount > intent.remainingLifetime) hard.push("AMOUNT_ABOVE_JAR_LIFETIME_CAP");
    if (!r.extra?.expiresAt || r.extra.expiresAt <= now) hard.push("QUOTE_EXPIRED");
    if (opts.paidQuoteIds?.has(r.extra?.quoteId)) hard.push("QUOTE_ALREADY_PAID");

    if (hard.length) {
      lastHard = hard;
      continue;
    }
    if (amount * 2n > intent.remainingToday) soft.push("USES_OVER_HALF_OF_REMAINING_CAP");
    if (r.extra.expiresAt - now > 3600) soft.push("LONG_QUOTE_EXPIRY");
    return { decision: soft.length ? "review" : "pay", reasons: soft.length ? soft : ["OK"], requirement: r };
  }
  return { decision: "do_not_pay", reasons: lastHard };
}
