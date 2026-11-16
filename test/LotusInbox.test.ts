import { expect } from "chai";
import { ethers } from "hardhat";

const USDC = (n: number) => ethers.parseUnits(n.toString(), 6);
const L = (s: string) => ethers.encodeBytes32String(s);

async function deploy() {
  const [owner, main, jar, agent, client, stranger] = await ethers.getSigners();
  const usdc = await (await ethers.getContractFactory("MockToken")).deploy("USD Coin", "USDC", 6);
  const inbox = await (await ethers.getContractFactory("LotusInbox")).deploy(owner.address, [
    { to: main.address, bps: 8000, label: L("MAIN") },
    { to: jar.address, bps: 2000, label: L("JAR") },
  ]);
  return { owner, main, jar, agent, client, stranger, usdc, inbox };
}

describe("LotusInbox — invoice wallet that can only pay out by the owner's split", () => {
  it("a client pays an invoice; sweep splits 80/20 to the main wallet and the spending jar", async () => {
    const { main, jar, agent, client, usdc, inbox } = await deploy();
    await usdc.mint(client.address, USDC(10));
    await usdc.connect(client).transfer(await inbox.getAddress(), USDC(10));
    // Anyone may trigger the payout (here the agent); it only ever goes to the listed wallets.
    await expect(inbox.connect(agent).sweep(await usdc.getAddress()))
      .to.emit(inbox, "Swept").withArgs(await usdc.getAddress(), USDC(10), agent.address);
    expect(await usdc.balanceOf(main.address)).to.equal(USDC(8));
    expect(await usdc.balanceOf(jar.address)).to.equal(USDC(2));
    expect(await usdc.balanceOf(await inbox.getAddress())).to.equal(0n);
  });

  it("rounding dust goes to the last share, nothing is stuck", async () => {
    const { main, jar, usdc, inbox } = await deploy();
    await usdc.mint(await inbox.getAddress(), 7n); // 7 micro-USDC
    await inbox.sweep(await usdc.getAddress());
    expect((await usdc.balanceOf(main.address)) + (await usdc.balanceOf(jar.address))).to.equal(7n);
    expect(await usdc.balanceOf(await inbox.getAddress())).to.equal(0n);
  });

  it("only the owner changes the split; the agent cannot redirect invoice money", async () => {
    const { owner, agent, stranger, usdc, inbox } = await deploy();
    await expect(inbox.connect(agent).setSplit([{ to: agent.address, bps: 10000, label: L("X") }])).to.be.revertedWithCustomError(inbox, "NotOwner");
    await usdc.mint(await inbox.getAddress(), USDC(1));
    await inbox.connect(owner).setSplit([{ to: stranger.address, bps: 10000, label: L("TAX") }]);
    await inbox.sweep(await usdc.getAddress());
    expect(await usdc.balanceOf(stranger.address)).to.equal(USDC(1));
  });

  it("rejects bad splits and empty sweeps", async () => {
    const { owner, main, usdc, inbox } = await deploy();
    const bad = [
      [{ to: main.address, bps: 9000, label: L("MAIN") }], // sums to 90%
      [{ to: ethers.ZeroAddress, bps: 10000, label: L("MAIN") }],
      [{ to: main.address, bps: 0, label: L("A") }, { to: main.address, bps: 10000, label: L("B") }],
      [],
      Array.from({ length: 6 }, () => ({ to: main.address, bps: 10000 / 5, label: L("A") })),
    ];
    for (const s of bad) await expect(inbox.connect(owner).setSplit(s)).to.be.revertedWithCustomError(inbox, "BadSplit");
    await expect(inbox.sweep(await usdc.getAddress())).to.be.revertedWithCustomError(inbox, "NothingToSweep");
  });

  it("has no way to send AVAX in or tokens out except sweep", async () => {
    const { client, inbox } = await deploy();
    await expect(client.sendTransaction({ to: await inbox.getAddress(), value: 1n })).to.be.reverted;
    const fns = inbox.interface.fragments.filter((f) => f.type === "function").map((f: any) => f.name).sort();
    expect(fns).to.deep.equal(["MAX_SHARES", "owner", "setSplit", "shares", "sweep"]);
  });
});
