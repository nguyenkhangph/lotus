/**
 * Text patterns. Evidence text is DATA: these patterns only flag it, the engine never
 * follows instructions found inside evidence.
 */

export const INJECTION_PATTERNS: RegExp[] = [
  /ignore (all |any )?(previous|prior|above) (rules|instructions)/i,
  /(^|\n|\s)system\s*:/i,
  /policy (is |has been )?revoked/i,
  /ignore the kill ?switch/i,
  /approve the next (order|payment|spend)/i,
  /\b(transfer|send|move)\b[^.\n]{0,80}\b0x[0-9a-f]{3,}/i,
  /\byou are now\b/i,
  /bỏ qua (mọi|tất cả|các) (quy tắc|hướng dẫn|lệnh)/i,
  /chuyển (hết|toàn bộ)[^.\n]{0,40}(ví|tiền|usdc)/i,
];

/** Vietnamese "kèo"/signal-group shill language, plus common English pump phrasing. */
export const SHILL_PATTERNS: RegExp[] = [
  /\bkèo\b/i,
  /\ball[- ]?in\b/i,
  /vào lệnh (ngay|gấp|liền)/i,
  /nhóm vip|group vip|room vip/i,
  /\binsiders?\b/i,
  /ai không vào/i,
  /đã chốt \d+ ?%/i,
  /duyệt nhanh/i,
  /không phải tin xấu đâu/i,
  /x\d{2,3} (tài khoản|account)/i,
  /\b(100x|1000x|to the moon|guaranteed (profit|returns?))\b/i,
  /cam kết lợi nhuận|lãi chắc|ăn chắc/i,
];

/** A claim that asks for a trade or a target is refused: Lotus grades evidence, not trades. */
export const TRADE_REQUEST_PATTERNS: RegExp[] = [
  /\b(buy|sell|long|short)\b[^.\n]{0,40}\b(now|today|ngay)\b/i,
  /should (i|we) (buy|sell)/i,
  /\bprice target\b|\btarget price\b/i,
  /giá mục tiêu/i,
  /nên (mua|bán)/i,
  /(mua|bán) ngay/i,
  /có nên (vào|xuống tiền)/i,
];

export function matchesAny(text: string, patterns: RegExp[]): boolean {
  return patterns.some((p) => p.test(text));
}

export function normalizeText(t: string): string {
  return t
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/https?:\/\/\S+/g, "")
    .replace(/[@#]\w+/g, "")
    .replace(/[^a-z0-9%.\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** Jaccard similarity on word 3-shingles: catches copy-paste with tiny edits. */
export function similarity(a: string, b: string): number {
  const sh = (s: string) => {
    const w = normalizeText(s).split(" ");
    const set = new Set<string>();
    for (let i = 0; i + 2 < w.length; i++) set.add(w.slice(i, i + 3).join(" "));
    if (set.size === 0 && w.length) set.add(w.join(" "));
    return set;
  };
  const A = sh(a);
  const B = sh(b);
  let inter = 0;
  for (const x of A) if (B.has(x)) inter++;
  const union = A.size + B.size - inter;
  return union === 0 ? 0 : inter / union;
}

/** Units we know how to compare. Factor converts to the base unit of the dimension. */
export const UNITS: Record<string, { dim: string; factor: number }> = {
  "h/s": { dim: "hashrate", factor: 1 },
  "th/s": { dim: "hashrate", factor: 1e12 },
  "ph/s": { dim: "hashrate", factor: 1e15 },
  "eh/s": { dim: "hashrate", factor: 1e18 },
  oz: { dim: "mass", factor: 31.1034768 }, // troy ounce in grams
  toz: { dim: "mass", factor: 31.1034768 },
  g: { dim: "mass", factor: 1 },
  kg: { dim: "mass", factor: 1000 },
  t: { dim: "mass", factor: 1e6 },
  tonne: { dim: "mass", factor: 1e6 },
  "%": { dim: "percent", factor: 1 },
  bp: { dim: "percent", factor: 0.01 },
  usd: { dim: "usd", factor: 1 },
  musd: { dim: "usd", factor: 1e6 },
  busd: { dim: "usd", factor: 1e9 },
  vnd: { dim: "vnd", factor: 1 },
};
