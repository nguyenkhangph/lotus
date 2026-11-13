import { expect } from "chai";
import request from "supertest";
import { buildPublicApp } from "../src/public";

describe("public (Vercel) app — read-only, no keys", () => {
  const app = buildPublicApp({
    FUJI_RPC_URL: "http://127.0.0.1:9", // unreachable on purpose: the demo must still serve pages
    TREASURY_ADDRESS: "0xa917992F4228115cAb572933A2dc9124585ba500",
    JAR_FACTORY_ADDRESS: "0xCD336298223605c0c6c792Bcd7bd2a3F4DCc9546",
    JAR_ADDRESS: "0x805113113EC069205f59d72137c01244BfAA9619",
  } as any);

  it("serves the dashboard and the catalog", async () => {
    const home = await request(app).get("/");
    expect(home.status).to.equal(200);
    expect(home.text).to.include("Lotus");
    const cat = await request(app).get("/catalog");
    expect(cat.body.endpoints[0].payTo).to.equal("0xa917992F4228115cAb572933A2dc9124585ba500");
  });

  it("POST /v1/score answers 402 with x402 terms", async () => {
    const r = await request(app).post("/v1/score").send({ claim: "NATO has invoked Article 5", desk: "gold_war" });
    expect(r.status).to.equal(402);
    expect(r.body.accepts.map((a: any) => a.scheme)).to.include("lotus-jar");
  });

  it("is read-only even for requests that look local", async () => {
    const s = await request(app).get("/api/state");
    expect(s.body.readOnly).to.equal(true);
    expect((await request(app).post("/api/check").send({ claim: "x", desk: "gold_war" })).status).to.equal(403);
    expect((await request(app).post("/api/approve").send({ runId: "r", approved: true })).status).to.equal(403);
  });
});
