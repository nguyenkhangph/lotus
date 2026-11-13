import { expect } from "chai";
import express from "express";
import fs from "fs";
import os from "os";
import path from "path";
import request from "supertest";
import { ApprovalHub } from "../src/agent/hub";
import { Ledger } from "../src/ledger";
import { dashboardRouter } from "../src/web/dashboard";

function app(opts: { publicDemo?: boolean; token?: string }) {
  const hub = new ApprovalHub(2_000);
  void hub.request({ runId: "r1", claim: "secret claim", desk: "gold_war", amount: "450000", amountHuman: "0.45", payTo: "0x1", asset: "0x2", requestHash: "0x3", remainingToday: "5", quoteExpiresAt: 0, reasons: ["OK"] });
  let asked = 0;
  const a = express();
  a.use(dashboardRouter({
    hub,
    ledger: new Ledger(path.join(fs.mkdtempSync(path.join(os.tmpdir(), "lotus-dash-")), "l.jsonl")),
    network: "avalanche-fuji", explorer: "x", botEnabled: false, allowLocalApprove: true,
    startCheck: async () => ((asked += 1), undefined),
    ...opts,
  }));
  return { a, hub, asked: () => asked };
}

describe("dashboard access control", () => {
  it("public demo: pending cards are hidden and nobody can ask or approve", async () => {
    const { a, hub } = app({ publicDemo: true });
    const s = await request(a).get("/api/state");
    expect(s.body.readOnly).to.equal(true);
    expect(s.body.pending).to.deep.equal([]);
    expect(s.body.pendingCount).to.equal(1);
    expect(JSON.stringify(s.body)).to.not.include("secret claim");
    expect((await request(a).post("/api/check").send({ claim: "x", desk: "gold_war" })).status).to.equal(403);
    expect((await request(a).post("/api/approve").send({ runId: "r1", approved: true })).status).to.equal(403);
    expect(hub.listPending()).to.have.length(1);
  });

  it("a tunnel/proxy that connects from 127.0.0.1 is NOT treated as local", async () => {
    const { a, hub } = app({});
    const s = await request(a).get("/api/state").set("x-forwarded-for", "203.0.113.9");
    expect(s.body.readOnly).to.equal(true);
    const ap = await request(a).post("/api/approve").set("cf-connecting-ip", "203.0.113.9").send({ runId: "r1", approved: true });
    expect(ap.status).to.equal(403);
    expect(hub.listPending()).to.have.length(1);
  });

  it("the token unlocks full access, a wrong token does not", async () => {
    const { a, asked } = app({ publicDemo: true, token: "s3cret-token" });
    expect((await request(a).get("/api/state").set("x-lotus-token", "wrong-token!")).body.readOnly).to.equal(true);
    const ok = await request(a).get("/api/state?token=s3cret-token");
    expect(ok.body.readOnly).to.equal(false);
    expect(ok.body.pending[0].claim).to.equal("secret claim");
    expect((await request(a).post("/api/check").set("x-lotus-token", "s3cret-token").send({ claim: "NATO has invoked Article 5", desk: "gold_war" })).status).to.equal(200);
    expect(asked()).to.equal(1);
  });

  it("direct local access (no proxy) keeps working when not in public mode", async () => {
    const { a } = app({});
    expect((await request(a).get("/api/state")).body.readOnly).to.equal(false);
  });
});
