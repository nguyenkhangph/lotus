import { getAddress } from "ethers";
import type { JarStatus } from "../agent/jar";
import { compare, fmtUsd, ownerCalls, parseRules, usd, type Lang, type Policy } from "./policy";

export type PolicyView = { perTx: string; perDay: string; lifetime: string; delay: number; expiresAt: number; burstWindow: number; burstMax: number };

const view = (p: Policy): PolicyView => ({
  perTx: fmtUsd(p.perTx), perDay: fmtUsd(p.perDay), lifetime: fmtUsd(p.lifetime),
  delay: p.delay, expiresAt: p.expiresAt, burstWindow: p.burstWindow, burstMax: p.burstMax,
});

/** The jar's current rules. Without a live read (offline, RPC down) we fall back to the deployed demo values and say so. */
export function currentPolicy(status: JarStatus | null, now: number): { policy: Policy; live: boolean } {
  if (!status) {
    return { live: false, policy: { perTx: usd(0.5), perDay: usd(5), lifetime: usd(200), delay: 0, expiresAt: now + 20 * 86400, burstWindow: 60, burstMax: 10, payees: {} } };
  }
  return {
    live: status.delay !== undefined,
    policy: {
      perTx: usd(status.perTx), perDay: usd(status.perDay), lifetime: usd(status.lifetime),
      delay: status.delay ?? 0, expiresAt: status.expiresAt, burstWindow: status.burstWindow ?? 60, burstMax: status.burstMax ?? 0, payees: {},
    },
  };
}

export function previewRules(text: string, status: JarStatus | null, treasury: string, now = Math.floor(Date.now() / 1000), lang: Lang = "vi") {
  const T = getAddress(treasury);
  const { policy: current, live } = currentPolicy(status, now);
  const parsed = parseRules(text, current, { now, treasury: T, lang });
  const payeeAllowed = (a: string) => (getAddress(a) === T ? status?.treasuryAllowed ?? true : false);
  const start = {
    now,
    locked: status?.locked ?? false,
    spentLifetime: status ? usd(status.spentLifetime) : 0n,
    spentToday: status ? usd(status.perDay) - usd(status.remainingToday) : 0n,
  };
  const calls = ownerCalls(current, parsed.policy, payeeAllowed, lang);
  const quoted = text.replace(/"/g, "'").replace(/\s+/g, " ").trim();
  return {
    live,
    current: view(current),
    proposed: view(parsed.policy),
    understood: parsed.understood,
    unknown: parsed.unknown,
    warnings: parsed.warnings,
    scenarios: compare(current, parsed.policy, start, T, payeeAllowed, lang),
    calls,
    command: calls.length ? `npm run jar -- rules "${quoted}" --send` : null,
  };
}

export type RulesPreview = ReturnType<typeof previewRules>;
