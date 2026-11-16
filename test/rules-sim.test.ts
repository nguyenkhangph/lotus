import { expect } from "chai";
import { ethers } from "hardhat";
import { time } from "@nomicfoundation/hardhat-network-helpers";
import { defaultScenarios, parseRules, simulate, usd, type Policy } from "../src/rules/policy";

/**
 * The rules preview must never promise something the contract would not do.
 * Each default scenario runs on a fresh LotusJar with the parsed policy, and every spend's
 * outcome (paid, or which custom error / burst lock) must equal the simulator's.
 */
const SPEND_TYPES = {
  Spend: [
    { name: "token", type: "address" }, { name: "payTo", type: "address" }, { name: "amount", type: "uint256" },
    { name: "requestHash", type: "bytes32" }, { name: "nonce", type: "uint256" }, { name: "validBefore", type: "uint64" },
  ],
};

const RULES = "Mỗi lần tối đa 0,5 USDC. Mỗi ngày không quá 3 USDC. Tổng cộng 100 USDC. Chỉ trả cho Lotus. Quá 5 lệnh trong 1 phút thì khoá hũ. Hết hạn sau 30 ngày.";

async function freshJar(policy: Policy) {
  const [owner, approver, guardian, , treasury] = await ethers.getSigners();
  const usdc = await (await ethers.getContractFactory("MockToken")).deploy("USD Coin", "USDC", 6);
  const factory = await (await ethers.getContractFactory("LotusJarFactory")).deploy();
  const rc = await (await factory.connect(owner).createJar({
    owner: ethers.ZeroAddress, approver: await approver.getAddress(), guardian: await guardian.getAddress(),
    tokens: [await usdc.getAddress()], payTos: [await treasury.getAddress()],
    caps: { perTx: policy.perTx, perDay: policy.perDay, lifetime: policy.lifetime },
    expiresAt: policy.expiresAt, delay: policy.delay, burstWindow: policy.burstWindow, burstMax: policy.burstMax,
  })).wait();
  const ev = rc!.logs.map((l) => factory.interface.parseLog(l)).find((e) => e?.name === "JarCreated");
  const jar = await ethers.getContractAt("LotusJar", ev!.args.jar);
  await usdc.mint(await jar.getAddress(), usd(1000));
  const { chainId } = await ethers.provider.getNetwork();
  const domain = { name: "LotusJar", version: "1", chainId, verifyingContract: await jar.getAddress() };
  return { owner, treasury, usdc, jar, domain };
}

describe("Vietnamese rules: simulator matches LotusJar on-chain", () => {
  it("every default scenario gives the same outcome per spend", async () => {
    const [, , , , treasury] = await ethers.getSigners();
    const T = await treasury.getAddress();
    let base = (await time.latest()) + 100;
    const start: Policy = { perTx: usd(2), perDay: usd(20), lifetime: usd(50), delay: 0, expiresAt: base + 7 * 86400, burstWindow: 60, burstMax: 0, payees: {} };
    const parsed = parseRules(RULES, start, { now: base, treasury: T });
    expect(parsed.unknown).to.deep.equal([]);

    for (const sc0 of defaultScenarios(base, T, parsed.policy)) {
      base = (await time.latest()) + 100;
      const policy = { ...parsed.policy, expiresAt: base + 30 * 86400 };
      const sc = defaultScenarios(base, T, policy).find((s) => s.id === sc0.id)!;
      const sim = simulate(policy, { now: base, spentToday: 0n, spentLifetime: 0n, locked: false }, sc.spends, (a) => a === T);

      const { owner, usdc, jar, domain } = await freshJar(policy);
      const onchain: string[] = [];
      let nonce = 1n;
      for (const s of sc.spends) {
        await time.setNextBlockTimestamp(s.at);
        const spend = { token: await usdc.getAddress(), payTo: s.payTo, amount: s.amount, requestHash: ethers.ZeroHash, nonce: nonce++, validBefore: BigInt(s.at + 300) };
        const sig = await owner.signTypedData(domain, SPEND_TYPES, spend);
        try {
          const rc = await (await jar.request(spend, sig)).wait();
          const paid = rc!.logs.some((l) => jar.interface.parseLog(l)?.name === "SpendExecuted");
          onchain.push(paid ? "OK" : (await jar.locked()) ? "BURST_LOCK" : "NOT_PAID");
        } catch (e: any) {
          const data = e?.data ?? e?.error?.data;
          onchain.push(jar.interface.parseError(data)?.name ?? `REVERT:${e.message}`);
        }
      }
      expect(onchain, sc.title).to.deep.equal(sim.map((x) => x.code));
    }
  });
});
