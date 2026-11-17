import { expect } from "chai";
import request from "supertest";
import { buildPublicApp } from "../src/public";
import { parseRules, usd, type Policy } from "../src/rules/policy";
import { previewRules } from "../src/rules/service";
import { formatRules } from "../src/telegram/bot";

const T = "0xa917992F4228115cAb572933A2dc9124585ba500";
const NOW = 1_800_000_000;
const BASE: Policy = { perTx: usd(0.5), perDay: usd(5), lifetime: usd(200), delay: 0, expiresAt: NOW + 20 * 86400, burstWindow: 60, burstMax: 10, payees: {} };
const parse = (t: string) => parseRules(t, BASE, { now: NOW, treasury: T });

describe("Vietnamese spending rules", () => {
  it("maps each clause to a contract field, with or without diacritics", () => {
    const r = parse("Mỗi lần tối đa 0,2 USDC. Mỗi ngày không quá 3 USDC. Tổng cộng 100 USDC. Quá 5 lệnh trong 1 phút thì khoá hũ. Hết hạn sau 30 ngày. Chờ 2 phút rồi mới chi.");
    expect(r.unknown).to.deep.equal([]);
    expect(r.policy.perTx).to.equal(usd(0.2));
    expect(r.policy.perDay).to.equal(usd(3));
    expect(r.policy.lifetime).to.equal(usd(100));
    expect([r.policy.burstMax, r.policy.burstWindow]).to.deep.equal([5, 60]);
    expect(r.policy.expiresAt).to.equal(NOW + 30 * 86400);
    expect(r.policy.delay).to.equal(120);
    const plain = parse("moi lan toi da 0.2 usdc, moi ngay khong qua 3 usdc");
    expect([plain.policy.perTx, plain.policy.perDay]).to.deep.equal([usd(0.2), usd(3)]);
  });

  it("reports what it cannot enforce instead of guessing", () => {
    const r = parse("Mỗi tuần tối đa 10 USDC. Tối đa 3 lần mỗi ngày. Hãy đầu tư thông minh");
    expect(r.unknown.map((u) => u.clause)).to.deep.equal(["Mỗi tuần tối đa 10 USDC", "Tối đa 3 lần mỗi ngày", "Hãy đầu tư thông minh"]);
    expect(r.policy).to.deep.equal(BASE);
  });

  it("allows Lotus and blocks a given address", () => {
    const bad = "0x1111111111111111111111111111111111111111";
    const r = parse(`Chỉ trả cho Lotus. Chặn ${bad}`);
    expect(r.policy.payees[T]).to.equal(true);
    expect(r.policy.payees[bad]).to.equal(false);
  });

  it("simulates attacks and lists only the owner calls that change something", () => {
    const st: any = { perTx: "0.5", perDay: "5", lifetime: "200", remainingToday: "5", spentLifetime: "4.05", locked: false, expiresAt: NOW + 20 * 86400, delay: 0, burstWindow: 60, burstMax: 10, treasuryAllowed: true };
    const p = previewRules("Mỗi ngày không quá 1 USDC. Quá 3 lệnh trong 1 phút thì khoá hũ", st, T, NOW);
    expect(p.calls.map((c) => c.fn)).to.deep.equal(["setCaps", "setTiming"]);
    const drain = p.scenarios.find((s) => s.id === "drain")!;
    expect(drain.current.paid).to.equal(11);
    expect(drain.proposed.paid).to.equal(2);
    const burst = p.scenarios.find((s) => s.id === "burst")!;
    expect(burst.proposed.paid).to.equal(3);
    expect(burst.proposed.first).to.match(/tự khoá/);
    expect(p.scenarios.find((s) => s.id === "stranger")!.proposed.paid).to.equal(0);
    expect(previewRules("Mỗi lần tối đa 0,5 USDC", st, T, NOW).calls).to.deep.equal([]);
    expect(formatRules(p)).to.include("npm run jar -- rules");
  });

  it("works in the public read-only demo, even when the chain is unreachable", async () => {
    const app = buildPublicApp({ FUJI_RPC_URL: "http://127.0.0.1:9", TREASURY_ADDRESS: T } as any);
    const r = await request(app).post("/api/rules/preview").send({ text: "Mỗi lần tối đa 0,3 USDC" });
    expect(r.status).to.equal(200);
    expect(r.body.live).to.equal(false);
    expect(r.body.proposed.perTx).to.equal("0.3");
    expect(r.body.calls[0].fn).to.equal("setCaps");
    expect((await request(app).post("/api/rules/preview").send({ text: "" })).status).to.equal(400);
  });
});

describe("English rules and English messages", () => {
  const parseEn = (t: string) => parseRules(t, BASE, { now: NOW, treasury: T, lang: "en" });

  it("understands the same rules written in English", () => {
    const r = parseEn("Max 0.2 USDC per payment. No more than 3 USDC per day. 100 USDC in total. Only pay Lotus. Lock the jar if more than 5 requests in 1 minute. Expires in 30 days. Wait 2 minutes before paying.");
    expect(r.unknown).to.deep.equal([]);
    expect([r.policy.perTx, r.policy.perDay, r.policy.lifetime]).to.deep.equal([usd(0.2), usd(3), usd(100)]);
    expect([r.policy.burstMax, r.policy.burstWindow, r.policy.delay]).to.deep.equal([5, 60, 120]);
    expect(r.policy.expiresAt).to.equal(NOW + 30 * 86400);
    expect(r.policy.payees[T]).to.equal(true);
    expect(r.understood[0].text).to.equal("At most 0.2 USDC per payment");
  });

  it("explains what it cannot enforce, in English", () => {
    const r = parseEn("At most 10 USDC per week. Max 3 requests a day. Be smart");
    expect(r.unknown.map((u) => u.why)).to.deep.equal([
      "The contract only has per-payment, per-day and lifetime caps; no weekly/monthly/yearly cap yet.",
      'The contract does not count requests per day. Use "lock if more than N requests in X minutes", or a daily money cap.',
      "Not understood, so not applied.",
    ]);
    expect(r.policy).to.deep.equal(BASE);
  });

  it("the preview API answers in the language asked for; a delay shows payments as queued", async () => {
    const app = buildPublicApp({ FUJI_RPC_URL: "http://127.0.0.1:9", TREASURY_ADDRESS: T } as any);
    const en = await request(app).post("/api/rules/preview").send({ text: "Mỗi lần tối đa 0,3 USDC", lang: "en" });
    expect(en.body.understood[0].text).to.equal("At most 0.3 USDC per payment");
    expect(en.body.scenarios[0].title).to.equal("Normal Lotus fee (0.45 USDC)");
    const vi = await request(app).post("/api/rules/preview").send({ text: "Max 0.3 USDC per payment" });
    expect(vi.body.understood[0].text).to.equal("Mỗi lần tối đa 0,3 USDC");
    const q = await request(app).post("/api/rules/preview").send({ text: "Wait 2 minutes before paying", lang: "en" });
    expect(q.body.scenarios[0].proposed.first).to.match(/^Queued/);
  });
});
