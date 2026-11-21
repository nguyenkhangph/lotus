import { expect } from "chai";
import express from "express";
import request from "supertest";
import { buildPublicApp } from "../src/public";
import { demoRouter } from "../src/web/demo";
import { FixtureProvider } from "../src/evidence/providers";

const ENV = {
  FUJI_RPC_URL: "http://127.0.0.1:9",
  TREASURY_ADDRESS: "0xa917992F4228115cAb572933A2dc9124585ba500",
  JAR_FACTORY_ADDRESS: "0xCD336298223605c0c6c792Bcd7bd2a3F4DCc9546",
  JAR_ADDRESS: "0x805113113EC069205f59d72137c01244BfAA9619",
};

describe("judge demo mode (DEMO_MODE=1): fixed samples, free, nothing on-chain", () => {
  it("is off by default: no demo routes, state says demoMode=false", async () => {
    const app = buildPublicApp(ENV as any);
    expect((await request(app).get("/api/demo/samples")).status).to.not.equal(200);
    expect((await request(app).post("/api/demo/score").send({ sample: "nato" })).status).to.not.equal(200);
    expect((await request(app).get("/api/state")).body.demoMode).to.equal(false);
  });

  it("when on: lists samples, scores a sample for free, and keeps /api/check read-only", async () => {
    const app = buildPublicApp({ ...ENV, DEMO_MODE: "1" } as any);
    const st = await request(app).get("/api/state");
    expect(st.body.demoMode).to.equal(true);
    expect(st.body.readOnly).to.equal(true);
    const list = await request(app).get("/api/demo/samples");
    expect(list.body.samples.map((x: any) => x.id)).to.include("nato");
    const r = await request(app).post("/api/demo/score").send({ sample: "nato" });
    expect(r.status).to.equal(200);
    expect(r.body.demo).to.equal(true);
    expect(r.body.charged).to.equal("0");
    expect(r.body.onChain).to.equal(false);
    expect(r.body.verdict).to.equal("MISSING_EVIDENCE");
    expect(r.body).to.not.have.property("receipt");
    // the paid and privileged paths are unchanged
    expect((await request(app).post("/api/check").send({ claim: "x", desk: "gold_war" })).status).to.equal(403);
    expect((await request(app).post("/v1/score").send({ claim: "NATO has invoked Article 5", desk: "gold_war" })).status).to.equal(402);
  });

  it("does not write receipts to the ledger", async () => {
    const app = buildPublicApp({ ...ENV, DEMO_MODE: "1" } as any);
    const before = (await request(app).get("/receipts")).body.receipts.length;
    await request(app).post("/api/demo/score").send({ sample: "cpi" });
    const after = (await request(app).get("/receipts")).body.receipts.length;
    expect(after).to.equal(before);
  });

  it("refuses free text and unknown samples", async () => {
    const app = buildPublicApp({ ...ENV, DEMO_MODE: "1" } as any);
    expect((await request(app).post("/api/demo/score").send({ claim: "anything", desk: "gold_war" })).status).to.equal(400);
    expect((await request(app).post("/api/demo/score").send({ sample: "nope" })).status).to.equal(400);
  });

  it("trade questions are refused for free", async () => {
    const app = buildPublicApp({ ...ENV, DEMO_MODE: "1" } as any);
    const r = await request(app).post("/api/demo/score").send({ sample: "buy" });
    expect(r.body.verdict).to.equal("REFUSE");
    expect(r.body.charged).to.equal("0");
  });

  it("rate-limits per IP", async () => {
    const app = express();
    app.use(demoRouter({ evidence: new FixtureProvider(), limit: 2, windowMs: 60_000 }));
    const call = () => request(app).post("/api/demo/score").set("x-forwarded-for", "1.2.3.4").send({ sample: "cpi" });
    expect((await call()).status).to.equal(200);
    expect((await call()).status).to.equal(200);
    expect((await call()).status).to.equal(429);
    const other = await request(app).post("/api/demo/score").set("x-forwarded-for", "5.6.7.8").send({ sample: "cpi" });
    expect(other.status).to.equal(200);
  });

  it("when the live exchange feed is down, points to the real paid receipt for that claim", async () => {
    const app = express();
    const down = { fetch: async () => { throw new Error("blocked"); } };
    const { Ledger } = await import("../src/ledger");
    const ledger = new Ledger(require("path").join(__dirname, "..", "data", "demo", "ledger.jsonl"));
    app.use(demoRouter({ evidence: down as any, ledger }));
    const r = await request(app).post("/api/demo/score").send({ sample: "fox" });
    expect(r.status).to.equal(200);
    expect(r.body.sourceError).to.equal("blocked");
    expect(r.body.lastPaidReceipt.index).to.equal(6);
    expect(r.body.lastPaidReceipt.verdict).to.equal("SUPPORTED");
    expect(r.body.lastPaidReceipt.paymentTx).to.match(/^0x4a9e/);
  });

  it("times out a slow evidence source instead of hanging", async () => {
    const app = express();
    const slow = { fetch: () => new Promise<never>(() => {}) };
    app.use(demoRouter({ evidence: slow as any, timeoutMs: 50 }));
    const r = await request(app).post("/api/demo/score").send({ sample: "cpi" });
    expect(r.status).to.equal(200);
    expect(r.body.sourceError).to.match(/timed out/);
  });
});
