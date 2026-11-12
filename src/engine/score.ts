import type {
  AllowedSource, Claim, Desk, EvidenceItem, ItemFinding, ReasonCode, ScoreResult, Verdict,
} from "./types";
import {
  INJECTION_PATTERNS, SHILL_PATTERNS, TRADE_REQUEST_PATTERNS, UNITS, matchesAny, normalizeText, similarity,
} from "./patterns";

export const DISCLAIMER =
  "Lotus grades the evidence behind a claim. It is not investment advice: no buy/sell calls, no price targets, no forecasts. Testnet only.";

const WEIGHT = { primary: 45, outlet: 20, analyst: 12 } as const;
const NEW_ACCOUNT_DAYS = 30;
const ENGAGEMENT_RATIO = 100; // interactions per follower
const DUP_SIMILARITY = 0.6;
const MEASURE_TOLERANCE = 0.01; // 1 %

/** Disqualifying flags: an item with any of these is never counted as evidence. */
const DISQUALIFY: ReasonCode[] = [
  "PROMPT_INJECTION", "SHILL_LANGUAGE", "IMPERSONATION", "NOT_ALLOWLISTED", "STALE", "SCREENSHOT_ONLY",
];

function hostOf(url?: string): string | undefined {
  if (!url) return undefined;
  try {
    return new URL(url).hostname.toLowerCase().replace(/^www\./, "");
  } catch {
    return undefined;
  }
}

function handleKey(item: EvidenceItem): string | undefined {
  if (!item.handle) return undefined;
  const h = item.handle.startsWith("@") || item.platform !== "x" ? item.handle : "@" + item.handle;
  return `${item.platform}:${h}`.toLowerCase();
}

function coreOf(handle: string): string {
  return handle.toLowerCase().replace(/^(x|fb):/, "").replace(/[@_.\-]/g, "").replace(/(official|real|news|vn|\d+)$/g, "");
}

export function matchSource(item: EvidenceItem, desk: Desk): { source?: AllowedSource; impersonation: boolean } {
  const key = handleKey(item);
  const host = hostOf(item.url);
  for (const s of desk.sources) {
    if (key && s.handles?.some((h) => h.toLowerCase() === key)) return { source: s, impersonation: false };
  }
  // A URL on an official domain counts only when there is no conflicting social handle.
  if (!key && host) {
    for (const s of desk.sources) {
      if (s.domains?.some((d) => host === d || host.endsWith("." + d))) return { source: s, impersonation: false };
    }
  }
  // Look-alike detection: similar handle core or copied display name.
  if (key) {
    const c = coreOf(key);
    for (const s of desk.sources) {
      for (const h of s.handles ?? []) {
        const hc = coreOf(h);
        if (hc.length >= 4 && (c === hc || c.includes(hc) || hc.includes(c))) return { impersonation: true };
      }
      if (item.displayName && item.displayName.trim().toLowerCase() === s.name.toLowerCase()) return { impersonation: true };
    }
  }
  return { impersonation: false };
}

function toBase(m: { value: number; unit: string }): { dim: string; v: number } | undefined {
  const u = UNITS[m.unit.toLowerCase()];
  return u ? { dim: u.dim, v: m.value * u.factor } : undefined;
}

/** Union-find over items: same org, repost-of, duplicate image or near-duplicate text → one unit. */
class Clusters {
  private parent = new Map<string, string>();
  find(x: string): string {
    if (!this.parent.has(x)) this.parent.set(x, x);
    const p = this.parent.get(x)!;
    if (p === x) return x;
    const r = this.find(p);
    this.parent.set(x, r);
    return r;
  }
  union(a: string, b: string) {
    const ra = this.find(a);
    const rb = this.find(b);
    if (ra !== rb) this.parent.set(rb, ra);
  }
}

export function scoreClaim(claim: Claim, desk: Desk, items: EvidenceItem[]): ScoreResult {
  const asOf = claim.asOf ? new Date(claim.asOf) : new Date();
  const reason = new Set<ReasonCode>();
  const rules: string[] = [];

  const base = (verdict: Verdict, findings: ItemFinding[], extra: Partial<ScoreResult> = {}): ScoreResult => ({
    claim: claim.text,
    desk: desk.id,
    deskLive: desk.live,
    verdict,
    score: 0,
    independentSupport: 0,
    independentContra: 0,
    itemsSeen: items.length,
    echoIndex: 0,
    reasonCodes: [...reason],
    findings,
    debate: {
      bull: { units: [], citations: [] },
      bear: { units: [], citations: [], gaps: [...reason] },
      skeptic: { verdict, rules },
    },
    disclaimer: DISCLAIMER,
    ...extra,
  });

  // 1) The claim itself: refuse trade requests and shill phrasing outright.
  if (matchesAny(claim.text, TRADE_REQUEST_PATTERNS)) {
    reason.add("TRADE_REQUEST");
    rules.push("claim asks for a trade or target → REFUSE");
    return base("REFUSE", []);
  }
  if (matchesAny(claim.text, SHILL_PATTERNS)) {
    reason.add("SHILL_LANGUAGE");
    rules.push("claim uses kèo/shill language → REFUSE");
    return base("REFUSE", []);
  }

  // 2) Per-item checks.
  const findings: ItemFinding[] = items.map((it) => {
    const flags: ReasonCode[] = [];
    const text = it.text ?? "";
    if (matchesAny(text, INJECTION_PATTERNS)) flags.push("PROMPT_INJECTION");
    if (matchesAny(text, SHILL_PATTERNS)) flags.push("SHILL_LANGUAGE");

    const { source, impersonation } = matchSource(it, desk);
    if (impersonation) flags.push("IMPERSONATION");
    else if (!source) flags.push("NOT_ALLOWLISTED");

    if (it.accountCreatedAt) {
      const ageDays = (asOf.getTime() - new Date(it.accountCreatedAt).getTime()) / 86400000;
      if (ageDays < NEW_ACCOUNT_DAYS) flags.push("NEW_ACCOUNT");
    }
    const interactions = (it.likes ?? 0) + (it.reposts ?? 0);
    if (it.followers !== undefined && interactions > ENGAGEMENT_RATIO * Math.max(it.followers, 1)) {
      flags.push("ENGAGEMENT_ANOMALY");
    }

    const ageHours = (asOf.getTime() - new Date(it.publishedAt).getTime()) / 3600000;
    const oldYear = (text.match(/\b(19|20)\d{2}\b/g) ?? []).map(Number);
    const recycled = oldYear.length > 0 && Math.max(...oldYear) < asOf.getUTCFullYear() && it.stance !== "neutral";
    if (ageHours > desk.staleAfterHours || recycled) flags.push("STALE");

    if (it.platform === "image" || (!it.url && it.imageHash && !it.handle)) flags.push("SCREENSHOT_ONLY");

    const counted = !!source && !flags.some((f) => DISQUALIFY.includes(f)) && it.stance !== "neutral";
    return { itemId: it.id, sourceId: source?.id, org: source?.org, type: source?.type, counted, flags };
  });

  for (const f of findings) for (const fl of f.flags) if (fl !== "NOT_ALLOWLISTED") reason.add(fl);
  if (findings.some((f) => f.flags.includes("PROMPT_INJECTION"))) rules.push("evidence containing instructions is tainted and ignored");

  // 3) Independence clustering across ALL non-tainted items (to measure the echo chamber).
  const clusters = new Clusters();
  const live = items.filter((_, i) => !findings[i].flags.includes("PROMPT_INJECTION"));
  for (let i = 0; i < live.length; i++) {
    const a = live[i];
    const fa = findings[items.indexOf(a)];
    clusters.find(a.id);
    if (a.repostOf) clusters.union(a.repostOf, a.id);
    for (let j = 0; j < i; j++) {
      const b = live[j];
      const fb = findings[items.indexOf(b)];
      if (fa.org && fa.org === fb.org) clusters.union(b.id, a.id);
      else if (a.imageHash && a.imageHash === b.imageHash) clusters.union(b.id, a.id);
      else if (similarity(a.text, b.text) >= DUP_SIMILARITY) clusters.union(b.id, a.id);
    }
  }
  const roots = new Set(live.map((x) => clusters.find(x.id)));
  const echoIndex = live.length ? Number((1 - roots.size / live.length).toFixed(3)) : 0;
  for (const f of findings) {
    f.unit = clusters.find(f.itemId);
  }
  // Mark echoes: counted items that share a unit with an earlier counted item.
  const seenUnits = new Set<string>();
  for (const f of findings) {
    if (!f.counted) continue;
    if (seenUnits.has(f.unit!)) f.flags.push("ECHO_DUPLICATE");
    seenUnits.add(f.unit!);
  }
  if (echoIndex >= 0.5) reason.add("ECHO_DUPLICATE");
  const unofficialBurst = findings.filter((f) => !f.counted).length;
  if (unofficialBurst >= 10 && echoIndex >= 0.5) {
    reason.add("FLOOD");
    rules.push("many uncounted, near-duplicate posts → flood, volume is not confirmation");
  }

  // 4) Measurements: units and values must agree with the primary print.
  const measured = items
    .map((it, i) => ({ it, f: findings[i] }))
    .filter((x) => x.it.measurement && !x.f.flags.includes("PROMPT_INJECTION"));
  const byMetric = new Map<string, typeof measured>();
  for (const x of measured) {
    const k = x.it.measurement!.metric;
    byMetric.set(k, [...(byMetric.get(k) ?? []), x]);
  }
  let measurementConflict = false;
  for (const [metric, xs] of byMetric) {
    const ref = xs.find((x) => x.f.counted && x.f.type === "primary");
    for (const x of xs) {
      const b = toBase(x.it.measurement!);
      if (!b) {
        x.f.flags.push("UNIT_MISMATCH");
        reason.add("UNIT_MISMATCH");
        continue;
      }
      if (!ref || ref === x) continue;
      const r = toBase(ref.it.measurement!)!;
      if (r.dim !== b.dim) {
        x.f.flags.push("UNIT_MISMATCH");
        reason.add("UNIT_MISMATCH");
        x.f.counted = false; // a number that disagrees with the primary print is not support
        measurementConflict = true;
      } else if (Math.abs(r.v - b.v) > MEASURE_TOLERANCE * Math.abs(r.v)) {
        x.f.flags.push("CONTRADICTION");
        reason.add("CONTRADICTION");
        x.f.counted = false;
        measurementConflict = true;
        rules.push(`${metric}: value differs from the primary print`);
      }
    }
  }

  // 5) Tally independent units by stance, weighted by the best source type in the unit.
  const unitBest = (stance: EvidenceItem["stance"]) => {
    const m = new Map<string, { type: NonNullable<ItemFinding["type"]>; urls: string[] }>();
    findings.forEach((f, i) => {
      if (!f.counted || items[i].stance !== stance) return;
      const cur = m.get(f.unit!);
      const url = items[i].url ?? items[i].handle ?? items[i].id;
      if (!cur) m.set(f.unit!, { type: f.type!, urls: [url] });
      else {
        cur.urls.push(url);
        if (WEIGHT[f.type!] > WEIGHT[cur.type]) cur.type = f.type!;
      }
    });
    return m;
  };
  const sup = unitBest("supports");
  const con = unitBest("contradicts");
  const primarySupportIds = new Set(
    findings.filter((f, i) => f.counted && f.type === "primary" && items[i].stance === "supports").map((f) => f.sourceId!),
  );
  const primaryContra = findings.some((f, i) => f.counted && f.type === "primary" && items[i].stance === "contradicts");

  // 6) Official attribution: "the Fed said…" needs the Fed itself.
  const claimLc = claim.text.toLowerCase();
  const requiredBodies = desk.officialBodies.filter((b) => b.patterns.some((p) => new RegExp(p, "i").test(claimLc)));
  const missingBodies = requiredBodies.filter((b) => !b.sources.some((s) => primarySupportIds.has(s)));
  const bodyContradicts = requiredBodies.some((b) =>
    findings.some((f, i) => f.counted && b.sources.includes(f.sourceId!) && items[i].stance === "contradicts"),
  );

  // 7) Verdict.
  let verdict: Verdict;
  const supUnits = sup.size;
  const conUnits = con.size;
  const countedAny = findings.some((f) => f.counted);
  const allShill = items.length > 0 && findings.every((f) => f.flags.includes("SHILL_LANGUAGE") || f.flags.includes("PROMPT_INJECTION"));

  if (allShill && findings.some((f) => f.flags.includes("SHILL_LANGUAGE"))) {
    verdict = "REFUSE";
    rules.push("only kèo/shill material, nothing to grade → REFUSE");
  } else if (!countedAny) {
    verdict = "MISSING_EVIDENCE";
    reason.add(items.length ? "MISSING_PRIMARY" : "NO_EVIDENCE");
    rules.push("no allowlisted, current, non-tainted evidence → MISSING EVIDENCE");
  } else if (bodyContradicts || (primaryContra && primarySupportIds.size === 0)) {
    verdict = "CONTRADICTED";
    reason.add("CONTRADICTION");
    rules.push("the primary source says otherwise");
  } else if (missingBodies.length) {
    verdict = "MISSING_EVIDENCE";
    reason.add("MISSING_PRIMARY");
    rules.push(`claim is attributed to ${missingBodies.map((b) => b.id).join(", ")} but no primary text from them`);
  } else if ((supUnits > 0 && conUnits > 0) || measurementConflict) {
    verdict = "CONTESTED";
    reason.add("CONTRADICTION");
    rules.push("independent sources disagree → flag, do not pick a side");
  } else if (supUnits === 0) {
    verdict = conUnits > 0 ? "CONTRADICTED" : "MISSING_EVIDENCE";
    if (verdict === "MISSING_EVIDENCE") reason.add("MISSING_PRIMARY");
  } else {
    verdict = "SUPPORTED"; // may be downgraded to WEAK by score below
  }

  let score = 0;
  for (const u of sup.values()) score += WEIGHT[u.type];
  score -= echoIndex * 20;
  if (verdict === "CONTESTED") for (const u of con.values()) score -= WEIGHT[u.type];
  if (verdict === "MISSING_EVIDENCE" || verdict === "REFUSE" || verdict === "CONTRADICTED") score = 0;
  score = Math.max(0, Math.min(100, Math.round(score)));
  if (verdict === "SUPPORTED" && score < 40) {
    verdict = "WEAK";
    rules.push("supported only by weak / few independent units");
  }
  if (reason.size === 0) reason.add("OK");

  return {
    ...base(verdict, findings),
    score,
    independentSupport: supUnits,
    independentContra: conUnits,
    echoIndex,
    reasonCodes: [...reason],
    debate: {
      bull: { units: [...sup.keys()], citations: [...sup.values()].flatMap((u) => u.urls) },
      bear: { units: [...con.keys()], citations: [...con.values()].flatMap((u) => u.urls), gaps: [...reason].filter((r) => r !== "OK") },
      skeptic: { verdict, rules },
    },
  };
}
