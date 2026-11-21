import express, { type Request, type Router } from "express";
import { getDesk } from "../engine/desks";
import { scoreClaim } from "../engine/score";
import type { EvidenceItem } from "../engine/types";
import type { EvidenceProvider } from "../evidence/providers";
import type { Ledger } from "../ledger";
import { hashJson } from "../util/hash";

/**
 * Judge demo (DEMO_MODE=1): score a few FIXED sample claims for free, so anyone can see a verdict
 * without paying. Safe by construction:
 *  - only the sample ids below are accepted (no free text, so it is not a free copy of the paid API),
 *  - no payment, no receipt, no ledger write, no anchor, no key: nothing touches the chain,
 *  - per-IP rate limit (best effort, in memory per serverless instance).
 */
export type DemoSample = { id: string; claim: string; desk: string; note: { en: string; vi: string } };

export const DEMO_SAMPLES: DemoSample[] = [
  { id: "fox", claim: "FOX chia cổ tức", desk: "vn_stocks", note: { en: "Live HNX disclosure (real data)", vi: "Công bố thật của HNX (dữ liệu thật)" } },
  { id: "nato", claim: "NATO has invoked Article 5", desk: "gold_war", note: { en: "Mass reposts with an injected prompt (sample data)", vi: "Tin đăng lại hàng loạt, có lệnh gài (dữ liệu mẫu)" } },
  { id: "cpi", claim: "US CPI rose last month", desk: "macro_whitehouse", note: { en: "Primary source plus independent reports (sample data)", vi: "Nguồn gốc và báo chí độc lập (dữ liệu mẫu)" } },
  { id: "fed", claim: "The Fed cut rates by 50 bp", desk: "macro_whitehouse", note: { en: "Rumour contradicted by the primary source (sample data)", vi: "Tin đồn bị nguồn gốc phản bác (dữ liệu mẫu)" } },
  { id: "buy", claim: "Should I buy ETH now?", desk: "btc_ta", note: { en: "Trade question: refused for free", vi: "Hỏi mua/bán: từ chối, không tính phí" } },
];

export type DemoDeps = {
  evidence: EvidenceProvider;
  /** Max requests per IP per window (default 10 per 60 s). */
  limit?: number;
  windowMs?: number;
  /** Max time to wait for a live evidence source before answering with what we have. */
  timeoutMs?: number;
  now?: () => number;
  /** Paid receipts: when a live source is unreachable, show the last real paid receipt for the same claim. */
  ledger?: Ledger;
};

function clientIp(req: Request): string {
  const fwd = String(req.headers["x-forwarded-for"] ?? "").split(",")[0].trim();
  return fwd || req.socket.remoteAddress || "unknown";
}

export function demoRouter(d: DemoDeps): Router {
  const r = express.Router();
  const limit = d.limit ?? 10;
  const windowMs = d.windowMs ?? 60_000;
  const timeoutMs = d.timeoutMs ?? 8_000;
  const now = d.now ?? Date.now;
  const hits = new Map<string, { start: number; n: number }>();

  r.get("/api/demo/samples", (_req, res) => {
    res.json({ demo: true, samples: DEMO_SAMPLES.map(({ id, claim, desk, note }) => ({ id, claim, desk, note })) });
  });

  r.post("/api/demo/score", express.json({ limit: "1kb" }), async (req, res) => {
    const ip = clientIp(req);
    const t = now();
    const h = hits.get(ip);
    if (!h || t - h.start > windowMs) hits.set(ip, { start: t, n: 1 });
    else if (++h.n > limit) return res.status(429).json({ error: "too many demo requests, try again in a minute" });
    if (hits.size > 5000) hits.clear(); // keep memory bounded

    const sample = DEMO_SAMPLES.find((s) => s.id === String(req.body?.sample ?? ""));
    if (!sample) return res.status(400).json({ error: "unknown sample; use one of " + DEMO_SAMPLES.map((s) => s.id).join("|") });

    const desk = getDesk(sample.desk);
    const claim = { text: sample.claim, desk: sample.desk };
    const pre = scoreClaim(claim, desk, []);
    let items: EvidenceItem[] = [];
    let sourceError: string | undefined;
    if (pre.verdict !== "REFUSE") {
      let timer: NodeJS.Timeout | undefined;
      try {
        items = await Promise.race([
          d.evidence.fetch(claim, desk),
          new Promise<never>((_, rej) => {
            timer = setTimeout(() => rej(new Error("evidence source timed out")), timeoutMs);
          }),
        ]);
      } catch (e: any) {
        sourceError = e?.message ?? "evidence source unavailable";
      } finally {
        if (timer) clearTimeout(timer);
      }
    }
    const result = pre.verdict === "REFUSE" ? pre : scoreClaim(claim, desk, items);
    // Live exchange feeds can be slow or block foreign servers: point to the real paid receipt instead.
    let lastPaidReceipt: { index: number; verdict: string; score: number; createdAt: string; paymentTx?: string } | undefined;
    if (d.ledger && desk.live && (sourceError || items.length === 0)) {
      const ch = hashJson({ claim: sample.claim, desk: sample.desk });
      const hit = (d.ledger.all() as any[]).filter((x) => x.claimHash === ch).pop();
      if (hit) lastPaidReceipt = { index: hit.index, verdict: hit.verdict, score: hit.score, createdAt: hit.createdAt, paymentTx: hit.payment?.ref };
    }
    res.json({
      ...result,
      demo: true,
      sample: sample.id,
      note: sample.note,
      charged: "0",
      onChain: false,
      demoNote: "Free judge demo: fixed sample claims, no payment, no receipt, nothing sent on-chain. The paid flow is POST /v1/score (HTTP 402).",
      sourceError,
      lastPaidReceipt,
      evidence: items.map((i) => ({
        platform: i.platform,
        handle: i.handle ?? i.displayName,
        url: i.url,
        text: i.text,
        stance: i.stance,
        publishedAt: i.publishedAt,
        synthetic: Boolean(i.synthetic),
      })),
    });
  });

  return r;
}
