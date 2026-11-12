import express, { type Request, type Response } from "express";
import type { LotusConfig } from "./config";
import { maxPrice } from "./config";
import { DESKS, getDesk } from "./engine/desks";
import { scoreClaim } from "./engine/score";
import type { EvidenceProvider } from "./evidence/providers";
import { Ledger, evidencePackHash } from "./ledger";
import { hashJson, requestHash } from "./util/hash";
import { QuoteBook, earned, type ChainReader } from "./x402/server";
import { decodeHeader, encodeHeader, type PaymentHeader } from "./x402/types";

export type AppDeps = {
  cfg: LotusConfig;
  chain: ChainReader;
  evidence: EvidenceProvider;
  ledger: Ledger;
  quotes?: QuoteBook;
  anchor?: (receiptHash: string, prevHash: string, packHash: string, reason: string) => Promise<string | undefined>;
  /** Returns the unused part of an `upto` payment to the payer. Optional: needs the treasury key. */
  refund?: (to: string, amount: bigint) => Promise<string>;
};

const SCORE_ROUTE = "/v1/score";

export function createApp(d: AppDeps) {
  const app = express();
  app.use(express.json({ limit: "32kb" }));
  const quotes = d.quotes ?? new QuoteBook(d.cfg);

  /** Self-hosted catalog: price, schema, caps, network, asset and payTo are public BEFORE paying. */
  app.get("/catalog", (_req, res) => {
    res.json({
      service: "Lotus — evidence scores for market claims",
      disclaimer: "Grades evidence only. No investment advice, no price targets, no forecasts. Testnet (Avalanche Fuji) only.",
      endpoints: [
        {
          method: "POST",
          route: SCORE_ROUTE,
          input: { claim: "string (≤ 500 chars)", desk: Object.keys(DESKS) },
          output: ["verdict", "score", "independentSupport", "echoIndex", "reasonCodes", "debate", "receipt"],
          price: {
            model: "upto",
            asset: d.cfg.asset,
            decimals: d.cfg.assetDecimals,
            base: d.cfg.pricing.base.toString(),
            perIndependentSource: d.cfg.pricing.perSource.toString(),
            maxSources: d.cfg.pricing.maxSources,
            ceiling: maxPrice(d.cfg).toString(),
            refund: d.refund
              ? "ceiling − earned is sent back to the payer on-chain right after the answer (refundTx on the receipt)"
              : "ceiling − earned is recorded as refundDue on the receipt",
          },
          network: d.cfg.network,
          chainId: d.cfg.chainId,
          payTo: d.cfg.treasury,
          schemes: ["exact", ...(d.cfg.jarFactory ? ["lotus-jar"] : [])],
        },
      ],
      desks: Object.values(DESKS).map((x) => ({ id: x.id, name: x.name, live: x.live, sources: x.sources.length })),
    });
  });

  app.get("/receipts", (_req, res) => {
    res.json({ intact: d.ledger.verify() === -1, head: d.ledger.head(), receipts: d.ledger.all().slice(-50) });
  });

  app.post(SCORE_ROUTE, async (req: Request, res: Response) => {
    const body = req.body ?? {};
    const claim = typeof body.claim === "string" ? body.claim.trim() : "";
    const deskId = typeof body.desk === "string" ? body.desk : "";
    if (!claim || claim.length > 500 || !DESKS[deskId]) {
      return res.status(400).json({ error: "body must be { claim: string ≤500, desk: one of " + Object.keys(DESKS).join("|") + " }" });
    }
    // Refusals that need no search are free: never charge for "should I buy…" or kèo/shill text.
    const pre = scoreClaim({ text: claim, desk: deskId }, getDesk(deskId), []);
    if (pre.verdict === "REFUSE") {
      return res.json({ ...pre, charged: "0", evidence: [], note: "Refused before quoting: Lotus grades evidence, it does not give trade calls." });
    }

    const rh = requestHash("POST", SCORE_ROUTE, { claim, desk: deskId });
    const raw = req.header("X-PAYMENT");

    if (!raw) {
      const { body: required } = quotes.issue(SCORE_ROUTE, rh);
      return res.status(402).json(required);
    }

    let header: PaymentHeader;
    try {
      header = decodeHeader<PaymentHeader>(raw);
    } catch {
      return res.status(402).json({ error: "MALFORMED_X_PAYMENT" });
    }
    const v = await quotes.verify(header, rh, SCORE_ROUTE, d.chain);
    if (!v.ok) {
      // Never serve on a failed check, and say why in a machine-readable way.
      return res.status(402).json({ error: v.reason });
    }

    const desk = getDesk(deskId);
    const items = await d.evidence.fetch({ text: claim, desk: deskId }, desk);
    const result = scoreClaim({ text: claim, desk: deskId }, desk, items);

    const earnedAmt = earned(d.cfg, result.independentSupport);
    const refundDue = v.amount > earnedAmt ? v.amount - earnedAmt : 0n;
    const packHash = evidencePackHash(items);
    const prev = d.ledger.head();
    const receipt = d.ledger.append({
      requestHash: rh,
      claimHash: hashJson({ claim, desk: deskId }),
      desk: deskId,
      deskLive: desk.live,
      evidencePackHash: packHash,
      verdict: result.verdict,
      score: result.score,
      echoIndex: result.echoIndex,
      independentSupport: result.independentSupport,
      reasonCodes: result.reasonCodes,
      payment: { scheme: header.scheme, ref: v.tx, amount: v.amount.toString(), payer: v.payer },
      pricing: { charged: v.amount.toString(), earned: earnedAmt.toString(), refundDue: refundDue.toString() },
    });

    let anchorTx: string | undefined;
    if (d.anchor) {
      try {
        anchorTx = await d.anchor(receipt.hash, prev, packHash, result.verdict);
      } catch {
        anchorTx = undefined; // anchoring is best-effort; the local chain is still verifiable
      }
    }

    let refundTx: string | undefined;
    if (d.refund && refundDue > 0n) {
      try {
        refundTx = await d.refund(v.payer, refundDue);
      } catch (e) {
        refundTx = undefined; // refund stays recorded as refundDue on the receipt and can be retried
      }
    }

    res.setHeader(
      "X-PAYMENT-RESPONSE",
      encodeHeader({ success: true, network: d.cfg.network, transaction: v.tx, payer: v.payer }),
    );
    return res.json({ ...result, evidence: items, receipt: { ...receipt, anchorTx, refundTx } });
  });

  return app;
}
