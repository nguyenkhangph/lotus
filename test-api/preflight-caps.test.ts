import { expect } from "chai";
import { preflight, type BuyerIntent } from "../src/buyer/preflight";
import { loadConfig } from "../src/config";
import { requestHash } from "../src/util/hash";
import { QuoteBook } from "../src/x402/server";

describe("preflight — jar caps are checked before anything is signed", () => {
  const TREASURY = "0x000000000000000000000000000000000000aaaa";
  const cfg = { ...loadConfig({}), treasury: TREASURY }; // ceiling 0.45 test USDC
  const body = { claim: "US CPI rose last month", desk: "macro_whitehouse" };
  const required = () => new QuoteBook(cfg).issue("/v1/score", requestHash("POST", "/v1/score", body)).body;
  const intent = (over: Partial<BuyerIntent> = {}): BuyerIntent => ({
    kind: "buy_evidence", method: "POST", route: "/v1/score", body,
    maxAmount: 1_000_000n, remainingToday: 5_000_000n,
    chainId: cfg.chainId, network: cfg.network, allowedAssets: [cfg.asset], allowedPayTo: [TREASURY],
    ...over,
  });

  it("quote above the jar's per-tx cap → do_not_pay", () => {
    const r = preflight(intent({ perTxCap: 449_999n }), required());
    expect(r.decision).to.equal("do_not_pay");
    expect(r.reasons).to.include("AMOUNT_ABOVE_JAR_PER_TX_CAP");
  });

  it("quote above the jar's remaining lifetime → do_not_pay", () => {
    const r = preflight(intent({ perTxCap: 500_000n, remainingLifetime: 100_000n }), required());
    expect(r.decision).to.equal("do_not_pay");
    expect(r.reasons).to.include("AMOUNT_ABOVE_JAR_LIFETIME_CAP");
  });

  it("exactly at both caps → still allowed", () => {
    const r = preflight(intent({ perTxCap: 450_000n, remainingLifetime: 450_000n }), required());
    expect(r.decision).to.not.equal("do_not_pay");
  });
});
