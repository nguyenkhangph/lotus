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
