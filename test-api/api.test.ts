import { expect } from "chai";
import fs from "fs";
import os from "os";
import path from "path";
import request from "supertest";
import { Wallet } from "ethers";
import { createApp } from "../src/app";
import { loadConfig } from "../src/config";
import { getDesk } from "../src/engine/desks";
import { scoreClaim } from "../src/engine/score";
import type { EvidenceItem } from "../src/engine/types";
import { CookieClient, FixtureProvider, HnxRssProvider, mentionsTicker, parseRss, tickersIn } from "../src/evidence/providers";
import { Ledger } from "../src/ledger";
import { preflight } from "../src/buyer/preflight";
import { requestHash } from "../src/util/hash";
import { FakeChain } from "../src/x402/fakeChain";
import { QuoteBook } from "../src/x402/server";
import { decodeHeader, encodeHeader, type PaymentHeader, type PaymentRequired } from "../src/x402/types";

const AS_OF = "2026-11-12T08:00:00.000Z";
const hAgo = (h: number) => new Date(Date.parse(AS_OF) - h * 3600000).toISOString();
const TREASURY = "0x000000000000000000000000000000000000aaaa";

function tmpLedger() {
  return new Ledger(path.join(fs.mkdtempSync(path.join(os.tmpdir(), "lotus-")), "ledger.jsonl"));
}

describe("engine — honest positives", () => {
  it("two independent primaries → SUPPORTED; same-org copies count once", () => {
    const items: EvidenceItem[] = [
      { id: "1", platform: "web", url: "https://www.bls.gov/news.release/cpi.nr0.htm", publishedAt: hAgo(3), stance: "supports", text: "CPI release text" },
      { id: "2", platform: "x", handle: "@BLS_gov", publishedAt: hAgo(3), stance: "supports", text: "CPI headline" },
      { id: "3", platform: "x", handle: "@stlouisfed", publishedAt: hAgo(2), stance: "supports", text: "FRED series updated with the latest CPI value" },
    ];
    const r = scoreClaim({ text: "CPI rose last month", desk: "macro_whitehouse", asOf: AS_OF }, getDesk("macro_whitehouse"), items);
    expect(r.verdict).to.equal("SUPPORTED");
    expect(r.independentSupport).to.equal(2); // bls.gov + @BLS_gov = one unit; FRED = second
    expect(r.debate.skeptic.verdict).to.equal("SUPPORTED");
  });

  it("refuses trade requests and price targets", () => {
    for (const claim of ["Should I buy BTC now?", "Giá mục tiêu của VNM là bao nhiêu?", "Nên mua HPG không"]) {
      const r = scoreClaim({ text: claim, desk: "vn_stocks", asOf: AS_OF }, getDesk("vn_stocks"), []);
      expect(r.verdict, claim).to.equal("REFUSE");
    }
  });

  it("company event on the VN desk needs an exchange disclosure, not a newspaper", () => {
    const desk = getDesk("vn_stocks");
    const news: EvidenceItem = { id: "n", platform: "fb", handle: "baodautu.vn", publishedAt: hAgo(5), stance: "supports", text: "HPG công bố chia cổ tức" };
    const r1 = scoreClaim({ text: "HPG chia cổ tức tiền mặt", desk: desk.id, asOf: AS_OF }, desk, [news]);
    expect(r1.verdict).to.equal("MISSING_EVIDENCE");
    const hnx: EvidenceItem = { id: "h", platform: "rss", url: "https://hnx.vn/vi-vn/thong-tin-cong-bo-ny-hnx/abc.html", publishedAt: hAgo(5), stance: "supports", text: "HPG: Thông báo chia cổ tức" };
    const r2 = scoreClaim({ text: "HPG chia cổ tức tiền mặt", desk: desk.id, asOf: AS_OF }, desk, [news, hnx]);
    expect(r2.verdict).to.equal("SUPPORTED");
  });
});

describe("HNX live provider (shape of the real feed, 13/11/2026)", () => {
  // Real feed shape: titles carry no ticker; links use an internal port.
  const xml = `<?xml version="1.0" encoding="utf-8"?><rss version="2.0"><channel><title>HNX</title>
    <item><guid isPermaLink="false">641922</guid><link>http://hnx.vn:7978/tin-cung-cap-rss-vi_vn-641922-0.html</link><title>Ngày đăng ký cuối cùng trả cổ tức bằng tiền mặt, trả cổ phiếu thưởng cho cổ đông hiện hữu</title><pubDate>Thu, 12 Nov 2026 17:04:12 +0700</pubDate></item>
    <item><guid isPermaLink="false">641962</guid><link>http://hnx.vn:7978/tin-cung-cap-rss-vi_vn-641962-1.html</link><title>Nghị quyết Hội đồng quản trị</title><pubDate>Fri, 13 Nov 2026 10:51:31 +0700</pubDate></item>
  </channel></rss>`;
  const pages: Record<string, string> = {
    "https://hnx.vn/tin-cung-cap-rss-vi_vn-641922-0.html": "<html><body><nav>HNX SHS PVS</nav><div>Mã chứng khoán: SHS. Ngày đăng ký cuối cùng trả cổ tức bằng tiền mặt.</div></body></html>",
    "https://hnx.vn/tin-cung-cap-rss-vi_vn-641962-1.html": "<html><body><div>Mã chứng khoán: CEO. Nghị quyết HĐQT.</div></body></html>",
  };
  const client = { get: async (u: string) => (u.endsWith(".rss") ? xml : pages[u] ?? Promise.reject(new Error("404"))) };

  it("parses items", () => {
    expect(parseRss(xml)).to.have.length(2);
  });

  it("finds the ticker on the disclosure page and links the public https URL", async () => {
    const p = new HnxRssProvider(client, 0, ["feed.rss"]);
    const items = await p.fetch({ text: "SHS chia cổ tức tiền mặt", desk: "vn_stocks" }, getDesk("vn_stocks"));
    expect(items).to.have.length(1);
    expect(items[0].stance).to.equal("supports");
    expect(items[0].url).to.equal("https://hnx.vn/tin-cung-cap-rss-vi_vn-641922-0.html");
    const r = scoreClaim({ text: "SHS chia cổ tức tiền mặt", desk: "vn_stocks", asOf: "2026-11-13T05:00:00Z" }, getDesk("vn_stocks"), items);
    expect(r.verdict).to.equal("SUPPORTED");
  });

  it("a ticker that is not on the page (e.g. HPG, listed on HOSE) yields nothing", async () => {
    const p = new HnxRssProvider(client, 0, ["feed.rss"]);
    expect(await p.fetch({ text: "HPG chia cổ tức", desk: "vn_stocks" }, getDesk("vn_stocks"))).to.deep.equal([]);
  });

  it("a dead feed yields nothing, never invented evidence", async () => {
    const dead = new HnxRssProvider({ get: async () => { throw new Error("TLS"); } }, 0, ["feed.rss"]);
    expect(await dead.fetch({ text: "SHS chia cổ tức", desk: "vn_stocks" }, getDesk("vn_stocks"))).to.deep.equal([]);
  });

  it("browse lists disclosures with tickers found on their pages", async () => {
    const p = new HnxRssProvider(client, 0, ["feed.rss"]);
    const rows = await p.browse("cổ tức");
    expect(rows[0].tickers[0]).to.equal("SHS");
  });

  it("CookieClient keeps the session cookie across the 'Object moved' redirect", async () => {
    const calls: any[] = [];
    const fake: any = async (url: string, init: any) => {
      calls.push({ url, cookie: init.headers.cookie });
      if (!init.headers.cookie) {
        return new Response("<html><head><title>Object moved</title></head></html>", {
          status: 302, headers: { location: "/feed.rss", "set-cookie": "sid=abc; path=/; HttpOnly" },
        });
      }
      return new Response("<rss><channel></channel></rss>", { status: 200 });
    };
    const body = await new CookieClient(fake).get("https://hnx.vn/feed.rss");
    expect(body).to.include("<rss>");
    expect(calls[1].cookie).to.equal("sid=abc");
  });
});

describe("x402 — exact scheme (EIP-3009) verification", () => {
  it("accepts a payer signature bound to the request hash, rejects one that is not", async () => {
    const cfg = { ...loadConfig({}), treasury: TREASURY };
    const book = new QuoteBook(cfg);
    const rh = requestHash("POST", "/v1/score", { claim: "x", desk: "btc_ta" });
    const { quote } = book.issue("/v1/score", rh);
    const payer = Wallet.createRandom();
    const now = Math.floor(Date.now() / 1000);
    const domain = { name: cfg.assetDomainName, version: cfg.assetDomainVersion, chainId: cfg.chainId, verifyingContract: cfg.asset };
    const types = {
      TransferWithAuthorization: [
        { name: "from", type: "address" }, { name: "to", type: "address" }, { name: "value", type: "uint256" },
        { name: "validAfter", type: "uint256" }, { name: "validBefore", type: "uint256" }, { name: "nonce", type: "bytes32" },
      ],
    };
    const mk = async (nonce: string) => {
      const authorization = { from: payer.address, to: TREASURY, value: quote.amount.toString(), validAfter: "0", validBefore: String(now + 300), nonce };
      return { authorization, signature: await payer.signTypedData(domain, types, authorization) };
    };
    const chain = new FakeChain();

    const unbound = await mk("0x" + "99".repeat(32));
    const bad = await book.verify({ x402Version: 1, scheme: "exact", network: cfg.network, quoteId: quote.id, payload: unbound }, rh, "/v1/score", chain);
    expect(bad).to.deep.include({ ok: false, reason: "NONCE_NOT_BOUND_TO_REQUEST" });

    const forged = await mk(rh);
    forged.authorization.value = (quote.amount + 1n).toString();
    const r0 = await book.verify({ x402Version: 1, scheme: "exact", network: cfg.network, quoteId: quote.id, payload: forged }, rh, "/v1/score", chain);
    expect(r0).to.deep.include({ ok: false, reason: "AMOUNT_ABOVE_QUOTE" });

    const good = await mk(rh);
    const ok = await book.verify({ x402Version: 1, scheme: "exact", network: cfg.network, quoteId: quote.id, payload: good }, rh, "/v1/score", chain);
    expect(ok.ok).to.equal(true);
    expect(chain.settled).to.have.length(1);
  });
});

describe("HTTP flow — 402 → preflight → jar payment → score → receipt", () => {
  it("serves only after a matching on-chain payment, and writes a verifiable receipt", async () => {
    const jar = Wallet.createRandom().address;
    const cfg = { ...loadConfig({}), treasury: TREASURY, jarFactory: "0x000000000000000000000000000000000000fac7" };
    const chain = new FakeChain();
    chain.jars.add(jar.toLowerCase());
    const ledger = tmpLedger();
    const app = createApp({ cfg, chain, ledger, evidence: new FixtureProvider() });
    const body = { claim: "Did the White House put a 100% tariff on gold exports today?", desk: "gold_war" };

    const cat = await request(app).get("/catalog");
    expect(cat.status).to.equal(200);
    expect(cat.body.endpoints[0].payTo).to.equal(TREASURY);

    const r402 = await request(app).post("/v1/score").send(body);
    expect(r402.status).to.equal(402);
    const required = r402.body as PaymentRequired;

    const decision = preflight(
      {
        kind: "buy_evidence", method: "POST", route: "/v1/score", body,
        maxAmount: 1_000_000n, remainingToday: 5_000_000n, chainId: cfg.chainId, network: cfg.network,
        allowedAssets: [cfg.asset], allowedPayTo: [TREASURY],
      },
      required,
    );
    expect(decision.decision).to.equal("pay");
    expect(decision.requirement!.scheme).to.equal("lotus-jar");

    // The user approved; the jar paid on-chain (simulated here).
    const req = decision.requirement!;
    const tx = "0x" + "cd".repeat(32);
    chain.addJarPayment({ txHash: tx, jar, asset: cfg.asset, payTo: TREASURY, amount: BigInt(req.maxAmountRequired), requestHash: req.extra.requestHash });
    const header: PaymentHeader = { x402Version: 1, scheme: "lotus-jar", network: cfg.network, quoteId: req.extra.quoteId, payload: { txHash: tx, jar } };

    // Same quote, different body → refused.
    const swapped = await request(app).post("/v1/score").set("X-PAYMENT", encodeHeader(header)).send({ ...body, claim: "Central bank gold demand rose" });
    expect(swapped.status).to.equal(402);

    const paid = await request(app).post("/v1/score").set("X-PAYMENT", encodeHeader(header)).send(body);
    expect(paid.status).to.equal(200);
    expect(paid.body.verdict).to.equal("MISSING_EVIDENCE");
    expect(paid.body.receipt.payment.ref).to.equal(tx);
    expect(Number(paid.body.receipt.pricing.refundDue)).to.equal(400000); // ceiling 0.45 − earned 0.05 (base only)
    const xpr = decodeHeader<{ success: boolean; transaction: string }>(paid.headers["x-payment-response"]);
    expect(xpr).to.deep.include({ success: true, transaction: tx });

    // Replay the same payment → refused.
    const replay = await request(app).post("/v1/score").set("X-PAYMENT", encodeHeader(header)).send(body);
    expect(replay.status).to.equal(402);
    expect(replay.body.error).to.equal("QUOTE_ALREADY_PAID");

    expect(ledger.verify()).to.equal(-1);
  });

  it("detects a tampered ledger line", () => {
    const ledger = tmpLedger();
    for (let i = 0; i < 3; i++) {
      ledger.append({
        requestHash: "0x" + i, claimHash: "0x", desk: "btc_ta", deskLive: false, evidencePackHash: "0x", verdict: "MISSING_EVIDENCE",
        score: 0, echoIndex: 0, independentSupport: 0, reasonCodes: ["NO_EVIDENCE"],
      });
    }
    expect(ledger.verify()).to.equal(-1);
    const file = (ledger as unknown as { file: string }).file;
    const lines = fs.readFileSync(file, "utf8").trim().split("\n");
    lines[1] = lines[1].replace("MISSING_EVIDENCE", "SUPPORTED");
    fs.writeFileSync(file, lines.join("\n") + "\n");
    expect(ledger.verify()).to.equal(1);
  });
});

describe("free refusals", () => {
  it("trade requests are refused before any 402 quote (no charge)", async () => {
    const cfg = { ...loadConfig({}), treasury: TREASURY };
    const app = createApp({ cfg, chain: new FakeChain(), ledger: tmpLedger(), evidence: new FixtureProvider() });
    const r = await request(app).post("/v1/score").send({ claim: "Should I buy BTC now?", desk: "btc_ta" });
    expect(r.status).to.equal(200);
    expect(r.body.verdict).to.equal("REFUSE");
    expect(r.body.charged).to.equal("0");
    expect(r.body.reasonCodes).to.include("TRADE_REQUEST");
  });
});

describe("ticker detection is Unicode-aware", () => {
  it("never reads PHI/THI/TIN out of Vietnamese uppercase words", () => {
    const text = "THÔNG TIN CỔ PHIẾU · THIẾT LẬP · Mã chứng khoán: SHS";
    expect(tickersIn(text)).to.deep.equal(["SHS"]);
    expect(mentionsTicker(text, "PHI")).to.equal(false);
    expect(mentionsTicker(text, "SHS")).to.equal(true);
  });
});
