/**
 * Two-source price sanity check (RT-12). This is a safety lock, not a trading signal:
 * if two price sources disagree by more than `maxBps`, or either is stale, the order is blocked.
 * Lotus' core product does not trade; this guard exists for the optional, user-approved order jar.
 */
export type PricePoint = { source: string; price: number; updatedAt: number };

export function oracleGuard(a: PricePoint, b: PricePoint, opts: { maxBps: number; maxAgeSec: number; now: number }) {
  if (!(a.price > 0) || !(b.price > 0)) return { ok: false as const, reason: "BAD_PRICE" };
  if (opts.now - a.updatedAt > opts.maxAgeSec || opts.now - b.updatedAt > opts.maxAgeSec) {
    return { ok: false as const, reason: "STALE_PRICE" };
  }
  const lo = Math.min(a.price, b.price);
  const bps = (Math.abs(a.price - b.price) / lo) * 10_000;
  if (bps > opts.maxBps) return { ok: false as const, reason: "ORACLE_DEVIATION", bps: Math.round(bps) };
  return { ok: true as const, bps: Math.round(bps) };
}
