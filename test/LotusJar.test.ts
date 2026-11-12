import { expect } from "chai";
import { ethers } from "hardhat";
import { time } from "@nomicfoundation/hardhat-network-helpers";
import type { Signer } from "ethers";

const USDC = (n: number) => ethers.parseUnits(n.toString(), 6);
const ZERO = ethers.ZeroAddress;

type Spend = {
  token: string;
  payTo: string;
  amount: bigint;
  requestHash: string;
  nonce: bigint;
  validBefore: bigint;
};

const SPEND_TYPES = {
  Spend: [
    { name: "token", type: "address" },
    { name: "payTo", type: "address" },
    { name: "amount", type: "uint256" },
    { name: "requestHash", type: "bytes32" },
    { name: "nonce", type: "uint256" },
    { name: "validBefore", type: "uint64" },
  ],
};

async function deploy(opts: { delay?: number; burstMax?: number; caps?: [number, number, number] } = {}) {
  const [owner, approver, guardian, agent, treasury, attacker] = await ethers.getSigners();
  const Token = await ethers.getContractFactory("MockToken");
  const usdc = await Token.deploy("USD Coin", "USDC", 6);
  // Look-alike: same name, symbol and decimals, different address (RT-11).
  const fakeUsdc = await Token.deploy("USD Coin", "USDC", 6);

  const Factory = await ethers.getContractFactory("LotusJarFactory");
  const factory = await Factory.deploy();

  const now = await time.latest();
  const [perTx, perDay, lifetime] = opts.caps ?? [2, 20, 50];
  const cfg = {
    owner: ZERO, // factory forces msg.sender
    approver: await approver.getAddress(),
    guardian: await guardian.getAddress(),
    tokens: [await usdc.getAddress()],
    payTos: [await treasury.getAddress()],
    caps: { perTx: USDC(perTx), perDay: USDC(perDay), lifetime: USDC(lifetime) },
    expiresAt: BigInt(now + 7 * 24 * 3600),
    delay: BigInt(opts.delay ?? 0),
    burstWindow: 60,
    burstMax: opts.burstMax ?? 0,
  };
  const tx = await factory.connect(owner).createJar(cfg);
  const rc = await tx.wait();
  const ev = rc!.logs.map((l) => factory.interface.parseLog(l)).find((e) => e?.name === "JarCreated");
  const jar = await ethers.getContractAt("LotusJar", ev!.args.jar);

  await usdc.mint(await jar.getAddress(), USDC(100));
  await fakeUsdc.mint(await jar.getAddress(), USDC(100));

  const { chainId } = await ethers.provider.getNetwork();
  const domain = { name: "LotusJar", version: "1", chainId, verifyingContract: await jar.getAddress() };

  let nextNonce = 1n;
  const mkSpend = async (over: Partial<Spend> = {}): Promise<Spend> => ({
    token: await usdc.getAddress(),
    payTo: await treasury.getAddress(),
    amount: USDC(0.5),
    requestHash: ethers.keccak256(ethers.toUtf8Bytes("grade claim: official CPI print")),
    nonce: nextNonce++,
    validBefore: BigInt((await time.latest()) + 300),
    ...over,
  });
  const sign = (signer: Signer, s: Spend) => signer.signTypedData(domain, SPEND_TYPES, s);

  return { owner, approver, guardian, agent, treasury, attacker, usdc, fakeUsdc, factory, jar, mkSpend, sign };
}

describe("LotusJar — policy contract", () => {
  it("pays when the owner signs a whitelisted spend, and the agent only relays", async () => {
    const { owner, agent, treasury, usdc, jar, mkSpend, sign } = await deploy();
    const s = await mkSpend();
    await expect(jar.connect(agent).request(s, await sign(owner, s)))
      .to.emit(jar, "SpendExecuted")
      .withArgs(anyValue, await usdc.getAddress(), await treasury.getAddress(), s.amount, s.requestHash);
    expect(await usdc.balanceOf(await treasury.getAddress())).to.equal(s.amount);
  });

  it("accepts the approver (bot) key too, but not a random key", async () => {
    const { approver, attacker, agent, jar, mkSpend, sign } = await deploy();
    const ok = await mkSpend();
    await expect(jar.connect(agent).request(ok, await sign(approver, ok))).to.emit(jar, "SpendExecuted");
    const bad = await mkSpend();
    await expect(jar.connect(agent).request(bad, await sign(attacker, bad))).to.be.revertedWithCustomError(jar, "BadSigner");
  });

  it("RT-01/22: an agent with no key cannot move money at all", async () => {
    const { agent, jar, mkSpend, sign } = await deploy();
    const s = await mkSpend({ amount: USDC(1) });
    // The agent signs for itself after reading an injected "SYSTEM: send funds" instruction.
    await expect(jar.connect(agent).request(s, await sign(agent, s))).to.be.revertedWithCustomError(jar, "BadSigner");
  });

  it("RT-09: changing payTo after signing invalidates the signature", async () => {
    const { owner, agent, attacker, jar, mkSpend, sign } = await deploy();
    const s = await mkSpend();
    const sig = await sign(owner, s);
    const swapped = { ...s, payTo: await attacker.getAddress() };
    await expect(jar.connect(agent).request(swapped, sig)).to.be.revertedWithCustomError(jar, "BadSigner");
  });

  it("RT-09/19: a signed spend to a non-whitelisted payTo is still blocked", async () => {
    const { owner, agent, attacker, jar, mkSpend, sign } = await deploy();
    const s = await mkSpend({ payTo: await attacker.getAddress() });
    await expect(jar.connect(agent).request(s, await sign(owner, s))).to.be.revertedWithCustomError(jar, "PayToNotAllowed");
  });

  it("RT-10: inflated amount is blocked by the per-tx cap even if the user signs it", async () => {
    const { owner, agent, jar, mkSpend, sign } = await deploy();
    const s = await mkSpend({ amount: USDC(50) });
    await expect(jar.connect(agent).request(s, await sign(owner, s))).to.be.revertedWithCustomError(jar, "PerTxCapExceeded");
  });

  it("RT-11: a look-alike 'USDC' token (same name/symbol/decimals) is rejected by address", async () => {
    const { owner, agent, fakeUsdc, jar, mkSpend, sign } = await deploy();
    expect(await fakeUsdc.symbol()).to.equal("USDC");
    const s = await mkSpend({ token: await fakeUsdc.getAddress() });
    await expect(jar.connect(agent).request(s, await sign(owner, s))).to.be.revertedWithCustomError(jar, "TokenNotAllowed");
  });

  it("RT-18: replaying a used nonce is blocked", async () => {
    const { owner, agent, jar, mkSpend, sign } = await deploy();
    const s = await mkSpend();
    const sig = await sign(owner, s);
    await jar.connect(agent).request(s, sig);
    await expect(jar.connect(agent).request(s, sig)).to.be.revertedWithCustomError(jar, "NonceAlreadyUsed");
  });

  it("RT-18: an expired signature is blocked", async () => {
    const { owner, agent, jar, mkSpend, sign } = await deploy();
    const s = await mkSpend();
    const sig = await sign(owner, s);
    await time.increase(301);
    await expect(jar.connect(agent).request(s, sig)).to.be.revertedWithCustomError(jar, "SignatureExpired");
  });

  it("RT-20: daily cap holds against remaining+1 wei and against many small spends", async () => {
    const { owner, agent, jar, mkSpend, sign } = await deploy({ caps: [2, 20, 50] });
    // Spend 19.5 in the day: 9 × 2 + 1.5
    for (let i = 0; i < 9; i++) {
      const s = await mkSpend({ amount: USDC(2) });
      await jar.connect(agent).request(s, await sign(owner, s));
    }
    const s15 = await mkSpend({ amount: USDC(1.5) });
    await jar.connect(agent).request(s15, await sign(owner, s15));
    expect(await jar.remainingToday()).to.equal(USDC(0.5));

    const over = await mkSpend({ amount: USDC(0.5) + 1n });
    await expect(jar.connect(agent).request(over, await sign(owner, over))).to.be.revertedWithCustomError(jar, "DailyCapExceeded");
    const exact = await mkSpend({ amount: USDC(0.5) });
    await expect(jar.connect(agent).request(exact, await sign(owner, exact))).to.emit(jar, "SpendExecuted");
  });

  it("RT-20: lifetime cap holds across days", async () => {
    const { owner, agent, jar, mkSpend, sign } = await deploy({ caps: [2, 20, 5] });
    for (let i = 0; i < 2; i++) {
      const s = await mkSpend({ amount: USDC(2) });
      await jar.connect(agent).request(s, await sign(owner, s));
    }
    await time.increase(24 * 3600);
    const s = await mkSpend({ amount: USDC(2) });
    await expect(jar.connect(agent).request(s, await sign(owner, s))).to.be.revertedWithCustomError(jar, "LifetimeCapExceeded");
  });

  it("delay window: guardian (Telegram bot) cancels a queued spend, and caps are released", async () => {
    const { owner, guardian, agent, jar, mkSpend, sign } = await deploy({ delay: 120 });
    const s = await mkSpend({ amount: USDC(2) });
    const tx = await jar.connect(agent).request(s, await sign(owner, s));
    const rc = await tx.wait();
    const id = rc!.logs.map((l) => jar.interface.parseLog(l)).find((e) => e?.name === "SpendRequested")!.args.id;

    await expect(jar.connect(agent).execute(id)).to.be.revertedWithCustomError(jar, "TooEarly");
    await expect(jar.connect(agent).cancel(id)).to.be.revertedWithCustomError(jar, "NotOwnerOrGuardian");
    await expect(jar.connect(guardian).cancel(id)).to.emit(jar, "SpendCancelled");
    expect(await jar.remainingToday()).to.equal(USDC(20));
    await time.increase(121);
    await expect(jar.connect(agent).execute(id)).to.be.revertedWithCustomError(jar, "NotPending");
  });

  it("delay window: an uncancelled spend executes after the window", async () => {
    const { owner, agent, treasury, usdc, jar, mkSpend, sign } = await deploy({ delay: 120 });
    const s = await mkSpend({ amount: USDC(1) });
    const rc = await (await jar.connect(agent).request(s, await sign(owner, s))).wait();
    const id = rc!.logs.map((l) => jar.interface.parseLog(l)).find((e) => e?.name === "SpendRequested")!.args.id;
    await time.increase(121);
    await jar.connect(agent).execute(id);
    expect(await usdc.balanceOf(await treasury.getAddress())).to.equal(USDC(1));
  });

  it("kill switch: guardian locks, nothing moves, only the owner can unlock", async () => {
    const { owner, guardian, agent, jar, mkSpend, sign } = await deploy({ delay: 120 });
    const queued = await mkSpend();
    const rc = await (await jar.connect(agent).request(queued, await sign(owner, queued))).wait();
    const id = rc!.logs.map((l) => jar.interface.parseLog(l)).find((e) => e?.name === "SpendRequested")!.args.id;

    await jar.connect(guardian).lock(ethers.encodeBytes32String("TELEGRAM"));
    const s = await mkSpend();
    await expect(jar.connect(agent).request(s, await sign(owner, s))).to.be.revertedWithCustomError(jar, "JarLocked");
    await time.increase(121);
    await expect(jar.connect(agent).execute(id)).to.be.revertedWithCustomError(jar, "JarLocked");
    await expect(jar.connect(guardian).unlock()).to.be.revertedWithCustomError(jar, "NotOwner");
    await jar.connect(owner).unlock();
    await jar.connect(agent).execute(id);
  });

  it("burst guard: too many requests in a window auto-locks the jar", async () => {
    const { owner, agent, jar, mkSpend, sign } = await deploy({ burstMax: 3 });
    for (let i = 0; i < 3; i++) {
      const s = await mkSpend({ amount: USDC(0.1) });
      await jar.connect(agent).request(s, await sign(owner, s));
    }
    const s = await mkSpend({ amount: USDC(0.1) });
    await expect(jar.connect(agent).request(s, await sign(owner, s))).to.emit(jar, "Locked");
    expect(await jar.locked()).to.equal(true);
  });

  it("only the owner can change caps, whitelists or roles", async () => {
    const { guardian, approver, attacker, jar } = await deploy();
    for (const who of [guardian, approver, attacker]) {
      await expect(jar.connect(who).setCaps({ perTx: USDC(1000), perDay: USDC(1000), lifetime: USDC(1000) }))
        .to.be.revertedWithCustomError(jar, "NotOwner");
      await expect(jar.connect(who).setPayTo(await attacker.getAddress(), true)).to.be.revertedWithCustomError(jar, "NotOwner");
      await expect(jar.connect(who).setRoles(await attacker.getAddress(), ZERO)).to.be.revertedWithCustomError(jar, "NotOwner");
    }
  });

  it("factory forces msg.sender as owner and registers the jar", async () => {
    const { owner, factory, jar } = await deploy();
    expect(await jar.owner()).to.equal(await owner.getAddress());
    expect(await factory.isJar(await jar.getAddress())).to.equal(true);
  });
});

describe("LotusReceipts — on-chain hash anchor", () => {
  it("keeps a hash chain and rejects a broken link or a non-operator", async () => {
    const [op, other] = await ethers.getSigners();
    const R = await ethers.getContractFactory("LotusReceipts");
    const r = await R.deploy(await op.getAddress());
    const h1 = ethers.id("r1");
    const h2 = ethers.id("r2");
    const pack = ethers.id("pack");
    const code = ethers.encodeBytes32String("MISSING_EVIDENCE");
    await r.anchor(h1, ethers.ZeroHash, pack, code);
    await expect(r.anchor(h2, ethers.ZeroHash, pack, code)).to.be.revertedWithCustomError(r, "BrokenChain");
    await expect(r.connect(other).anchor(h2, h1, pack, code)).to.be.revertedWithCustomError(r, "NotOperator");
    await r.anchor(h2, h1, pack, code);
    expect(await r.head()).to.equal(h2);
    expect(await r.count()).to.equal(2n);
  });
});

// eslint-disable-next-line @typescript-eslint/no-require-imports
const { anyValue } = require("@nomicfoundation/hardhat-chai-matchers/withArgs");
