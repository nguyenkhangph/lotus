import { expect } from "chai";
import fs from "fs";
import { matchRefunds, type TokenTx } from "../src/agent/refunds";

const JAR = "0x805113113EC069205f59d72137c01244BfAA9619";
const TREASURY = "0xa917992F4228115cAb572933A2dc9124585ba500";
const rows = fs.readFileSync("data/demo/ledger.jsonl", "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));

describe("refund backlog: match receipts to on-chain refunds", () => {
  // Shape of the explorer's tokentx list: payments jar → treasury, refunds treasury → jar (only receipts #4..#8 refunded).
  const txs: TokenTx[] = [];
  rows.forEach((r: any, i: number) => {
    txs.push({ hash: r.payment.ref, from: JAR, to: TREASURY, value: r.pricing.charged, timeStamp: String(1000 + i * 100) });
    if (r.index >= 4) txs.push({ hash: `0xrefund${r.index}`, from: TREASURY.toLowerCase(), to: JAR.toLowerCase(), value: r.pricing.refundDue, timeStamp: String(1000 + i * 100 + 10) });
  });

  it("finds exactly the unrefunded receipts (#0–#3, 1.50 USDC)", () => {
    const m = matchRefunds(rows, txs, JAR, TREASURY);
    const missing = m.filter((x) => x.status === "missing");
    expect(missing.map((x) => x.index)).to.deep.equal([0, 1, 2, 3]);
    expect(missing.reduce((a, x) => a + x.due, 0n)).to.equal(1_500_000n);
    expect(m.filter((x) => x.status === "refunded").map((x) => x.refundTx)).to.deep.equal(["0xrefund4", "0xrefund5", "0xrefund6", "0xrefund7", "0xrefund8"]);
  });

  it("a refund belongs to the payment just before it; older refunds count for nobody", () => {
    const one: TokenTx[] = [
      { hash: rows[1].payment.ref, from: JAR, to: TREASURY, value: "450000", timeStamp: "100" },
      { hash: rows[2].payment.ref, from: JAR, to: TREASURY, value: "450000", timeStamp: "200" },
      { hash: "0xold", from: TREASURY, to: JAR, value: "400000", timeStamp: "50" },
      { hash: "0xr", from: TREASURY, to: JAR, value: "400000", timeStamp: "210" },
    ];
    const m = matchRefunds([rows[1], rows[2]], one, JAR, TREASURY);
    expect(m.map((x) => x.status)).to.deep.equal(["missing", "refunded"]);
  });

  it("after refunding the backlog, a second run sends nothing", () => {
    const done = [...txs];
    for (const r of rows.filter((x: any) => x.index < 4)) done.push({ hash: `0xlate${r.index}`, from: TREASURY, to: JAR, value: r.pricing.refundDue, timeStamp: "999999" });
    expect(matchRefunds(rows, done, JAR, TREASURY).filter((x) => x.status === "missing")).to.deep.equal([]);
  });
});

describe("public demo shows the refund of every receipt", () => {
  it("each receipt in the snapshot carries its on-chain refund tx", async () => {
    const { buildPublicApp } = await import("../src/public");
    const request = (await import("supertest")).default;
    const app = buildPublicApp({ FUJI_RPC_URL: "http://127.0.0.1:9", TREASURY_ADDRESS: TREASURY } as any);
    const s = await request(app).get("/api/state");
    const recent = s.body.ledger.recent;
    expect(recent.length).to.equal(rows.length);
    expect(recent.every((r: any) => /^0x[0-9a-f]{64}$/.test(r.refundTx))).to.equal(true);
  });
});
