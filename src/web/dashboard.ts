import express, { type Request, type Router } from "express";
import fs from "fs";
import path from "path";
import { DESKS } from "../engine/desks";
import type { ApprovalHub } from "../agent/hub";
import type { JarStatus } from "../agent/jar";
import type { Ledger } from "../ledger";
import { previewRules } from "../rules/service";

export type DashboardDeps = {
  hub: ApprovalHub;
  ledger: Ledger;
  network: string;
  explorer: string;
  jarStatus?: () => Promise<JarStatus>;
  startCheck?: (claim: string, desk: string) => Promise<unknown>;
  botEnabled: boolean;
  /** Dashboard approve buttons: only when no Telegram bot, and only for a full-access viewer. */
  allowLocalApprove: boolean;
  /** Public read-only demo (e.g. deployed or tunnelled): nobody gets full access without the token. */
  publicDemo?: boolean;
  /** Optional secret: `x-lotus-token` header or `?token=` gives full access (pending cards, ask, approve). */
  token?: string;
  /** Public contract addresses shown on the page. */
  contracts?: { factory?: string; receipts?: string; jar?: string };
  /** Lotus treasury (payTo), so "chỉ trả cho Lotus" maps to an address in the rules preview. */
  treasury?: string;
};

/**
 * A request is "from this machine" only if it reached us directly. Tunnels (cloudflared, ngrok) and
 * reverse proxies connect from 127.0.0.1 too, so any forwarding header means it came from outside.
 */
export function isDirectLocal(req: Request): boolean {
  const forwarded = ["x-forwarded-for", "x-real-ip", "cf-connecting-ip", "forwarded", "x-forwarded-host"].some((h) => req.headers[h]);
  return !forwarded && ["127.0.0.1", "::1", "::ffff:127.0.0.1"].includes(req.socket.remoteAddress ?? "");
}

function hasToken(req: Request, token?: string): boolean {
  if (!token) return false;
  const given = String(req.headers["x-lotus-token"] ?? req.query.token ?? "");
  return given.length === token.length && require("crypto").timingSafeEqual(Buffer.from(given), Buffer.from(token));
}

export function dashboardRouter(d: DashboardDeps): Router {
  const r = express.Router();
  const html = fs.readFileSync(path.join(__dirname, "index.html"), "utf8");
  let jarCache: { at: number; v: JarStatus | null; err?: string } = { at: 0, v: null };

  r.get("/", (_req, res) => res.type("html").send(html));
  // Images, favicons, OG card (on Vercel these are served by the CDN from public/ directly).
  r.use(express.static(path.join(__dirname, "..", "..", "public"), { maxAge: "1d", index: false }));

  const fullAccess = (req: Request) => hasToken(req, d.token) || (!d.publicDemo && isDirectLocal(req));

  const refreshJar = async () => {
    if (d.jarStatus && Date.now() - jarCache.at > 5000) {
      try {
        jarCache = { at: Date.now(), v: await d.jarStatus() };
      } catch (e: any) {
        jarCache = { at: Date.now(), v: jarCache.v, err: e?.shortMessage ?? e?.message };
      }
    }
  };

  r.get("/api/state", async (req, res) => {
    const full = fullAccess(req);
    await refreshJar();
    let redteam: unknown = null;
    try {
      redteam = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "..", "redteam", "report.json"), "utf8"));
    } catch {
      redteam = null;
    }
    const receipts = d.ledger.all();
    res.json({
      network: d.network,
      explorer: d.explorer,
      contracts: d.contracts ?? {},
      botEnabled: d.botEnabled,
      jar: jarCache.v,
      jarError: jarCache.err,
      desks: Object.values(DESKS).map((x) => ({ id: x.id, name: x.name, live: x.live })),
      readOnly: !full,
      canApproveHere: full && d.allowLocalApprove,
      // Public viewers see that something is waiting, never what or how much.
      pending: full ? d.hub.listPending() : [],
      pendingCount: d.hub.listPending().length,
      runs: full ? d.hub.recentRuns() : d.hub.recentRuns().filter((x) => x.status === "done").map(({ card, approvedBy, ...rest }) => rest),
      ledger: { intact: d.ledger.verify() === -1, count: receipts.length, head: d.ledger.head(), recent: receipts.slice(-12).reverse() },
      redteam,
    });
  });

  // Pure computation on public data (no key, no transaction), so the read-only demo allows it too.
  r.post("/api/rules/preview", express.json({ limit: "8kb" }), async (req, res) => {
    const text = String(req.body?.text ?? "").trim();
    if (!text || text.length > 800) return res.status(400).json({ error: "Nhập 1–800 ký tự quy tắc." });
    if (!d.treasury) return res.status(503).json({ error: "treasury not configured" });
    await refreshJar();
    res.json(previewRules(text, jarCache.v, d.treasury));
  });

  r.post("/api/check", express.json(), async (req, res) => {
    if (!fullAccess(req)) return res.status(403).json({ error: "read-only demo" });
    if (!d.startCheck) return res.status(503).json({ error: "agent not configured (JAR_ADDRESS / AGENT_PRIVATE_KEY / APPROVER_PRIVATE_KEY)" });
    const claim = String(req.body?.claim ?? "").trim();
    const desk = String(req.body?.desk ?? "");
    if (!claim || claim.length > 500 || !DESKS[desk]) return res.status(400).json({ error: "claim ≤500 chars and a valid desk" });
    void d.startCheck(claim, desk);
    res.json({ ok: true });
  });

  r.post("/api/approve", express.json(), (req, res) => {
    if (!d.allowLocalApprove || !fullAccess(req)) return res.status(403).json({ error: "approve on Telegram" });
    const ok = d.hub.resolve(String(req.body?.runId), Boolean(req.body?.approved), "dashboard");
    res.json({ ok });
  });

  return r;
}
