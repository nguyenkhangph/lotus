/**
 * Which receipts already got their `upto` refund on-chain? The ledger predates refund tracking, so we
 * read the jar's USDC transfers from the explorer and match them: a refund is a treasury → jar transfer
 * of exactly `refundDue`, matched to the latest earlier payment. Each transfer is used once.
 */
export type TokenTx = { hash: string; from: string; to: string; value: string; timeStamp: string };
export type ReceiptRow = { index: number; pricing?: { refundDue?: string }; payment?: { ref?: string } };
export type RefundMatch = { index: number; due: bigint; paymentTx?: string; refundTx?: string; status: "refunded" | "missing" | "nothing_due" | "unknown_payment" };

export function matchRefunds(rows: ReceiptRow[], txs: TokenTx[], jar: string, treasury: string): RefundMatch[] {
  const lc = (a: string) => a.toLowerCase();
  const paidAt = new Map<string, number>();
  for (const t of txs) if (lc(t.from) === lc(jar) && lc(t.to) === lc(treasury)) paidAt.set(lc(t.hash), Number(t.timeStamp));
  const refunds = txs
    .filter((t) => lc(t.from) === lc(treasury) && lc(t.to) === lc(jar))
    .map((t) => ({ ...t, at: Number(t.timeStamp) }))
    .sort((a, b) => a.at - b.at);

  // Lotus refunds right after the payment it belongs to, so each refund is given to the most recent
  // unmatched payment before it with the same refundDue (not simply the oldest equal amount).
  const sorted = [...rows].sort((a, b) => a.index - b.index);
  const info = sorted.map((r) => ({ r, due: BigInt(r.pricing?.refundDue ?? "0"), at: r.payment?.ref ? paidAt.get(lc(r.payment.ref)) : undefined, refundTx: undefined as string | undefined }));
  for (const t of refunds) {
    let best: (typeof info)[number] | undefined;
    for (const x of info) {
      if (x.refundTx || x.at === undefined || x.at > t.at || x.due !== BigInt(t.value)) continue;
      if (!best || x.at > best.at!) best = x;
    }
    if (best) best.refundTx = t.hash;
  }
  return info.map(({ r, due, at, refundTx }) => {
    const paymentTx = r.payment?.ref;
    if (due === 0n) return { index: r.index, due, paymentTx, status: "nothing_due" as const };
    if (at === undefined) return { index: r.index, due, paymentTx, status: "unknown_payment" as const };
    return refundTx ? { index: r.index, due, paymentTx, refundTx, status: "refunded" as const } : { index: r.index, due, paymentTx, status: "missing" as const };
  });
}

/** Etherscan-style token transfer list from Routescan (Snowtrace's backend), no API key needed. */
export async function fetchJarTransfers(jar: string, asset: string, chainId = 43113): Promise<TokenTx[]> {
  const net = chainId === 43114 ? "mainnet" : "testnet";
  const url = `https://api.routescan.io/v2/network/${net}/evm/${chainId}/etherscan/api?module=account&action=tokentx&address=${jar}&contractaddress=${asset}&page=1&offset=1000&sort=asc`;
  const r = await fetch(url);
  const j: any = await r.json();
  if (!Array.isArray(j?.result)) throw new Error(`explorer API: ${j?.message ?? r.status} ${typeof j?.result === "string" ? j.result : ""}`);
  return j.result;
}
