import { expect } from "chai";
import { ethers, network } from "hardhat";
import { time } from "@nomicfoundation/hardhat-network-helpers";
import { Contract, Wallet } from "ethers";
import fs from "fs";
import os from "os";
import path from "path";
import type { AddressInfo } from "net";
import { createApp } from "../src/app";
import { loadConfig } from "../src/config";
import { FixtureProvider } from "../src/evidence/providers";
import { Ledger } from "../src/ledger";
import { EthersChain } from "../src/x402/chain";
import { ApprovalHub } from "../src/agent/hub";
import { JAR_ABI, runCheck, type RunRecord } from "../src/agent/runner";
import { lockJar, readJar, sendRefund } from "../src/agent/jar";
import { LotusBot, parseCheck, guessDesk } from "../src/telegram/bot";

const USDC = (n: number) => ethers.parseUnits(n.toString(), 6);

async function funded() {
  const w = Wallet.createRandom().connect(ethers.provider);
  await network.provider.send("hardhat_setBalance", [w.address, "0x56BC75E2D63100000"]); // 100 ETH
  return w;
}

async function setup() {
  const [owner] = await ethers.getSigners();
  const [agent, approver, guardian, treasury, operator] = await Promise.all([funded(), funded(), funded(), funded(), funded()]);
  const token = await (await ethers.getContractFactory("MockToken")).deploy("USD Coin", "USDC", 6);
  const factory = await (await ethers.getContractFactory("LotusJarFactory")).deploy();
  const receipts = await (await ethers.getContractFactory("LotusReceipts")).deploy(operator.address);
  const now = await time.latest();
  const rc = await (
    await factory.createJar({
      owner: ethers.ZeroAddress, approver: approver.address, guardian: guardian.address,
      tokens: [await token.getAddress()], payTos: [treasury.address],
      caps: { perTx: USDC(0.5), perDay: USDC(5), lifetime: USDC(200) },
      expiresAt: BigInt(now + 7 * 86400), delay: 0n, burstWindow: 60, burstMax: 10,
    })
  ).wait();
  const jarAddr = rc!.logs.map((l) => factory.interface.parseLog(l)).find((e) => e?.name === "JarCreated")!.args.jar;
  await token.mint(jarAddr, USDC(5));

  const cfg = {
    ...loadConfig({}),
    chainId: 31337,
    network: "hardhat",
    asset: await token.getAddress(),
    assetDomainName: "USD Coin",
    treasury: treasury.address,
    jarFactory: await factory.getAddress(),
    receiptsContract: await receipts.getAddress(),
    ledgerPath: path.join(fs.mkdtempSync(path.join(os.tmpdir(), "lotus-e2e-")), "ledger.jsonl"),
  };
  const chain = new EthersChain(cfg, operator.privateKey, { provider: ethers.provider });
  const ledger = new Ledger(cfg.ledgerPath);
  const app = createApp({
    cfg, chain, ledger, evidence: new FixtureProvider(),
    anchor: (r, p, pack, reason) => chain.anchor(r, p, pack, ethers.encodeBytes32String(reason.slice(0, 31))),
    refund: (to, amount) => sendRefund(cfg, treasury, to, amount),
  });
  const server = app.listen(0);
  const api = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const jar = new Contract(jarAddr, JAR_ABI, agent);
  return { cfg, api, server, jar, jarAddr, token, receipts, agent, approver, guardian, treasury, ledger };
}

describe("E2E on Hardhat EVM — agent → approval → jar pays → API verifies → receipt anchored → refund", function () {
  it("full happy path with refund of the unused upto part", async () => {
    const s = await setup();
    const hub = new ApprovalHub(5_000);
    hub.on("approval", (card) => setImmediate(() => hub.resolve(card.runId, true, "test")));
    const updates: string[] = [];
    try {
      const r = await runCheck({
        api: s.api, cfg: s.cfg, jar: s.jar, approver: s.approver, approve: (c) => hub.request(c),
        claim: "Did the White House put a 100% tariff on gold exports today?", desk: "gold_war",
        onUpdate: (x) => updates.push(x.status),
      });
      expect(r.status, r.error).to.equal("done");
      expect(updates).to.include.members(["awaiting_approval", "paying", "done"]);
      expect(r.result.verdict).to.equal("MISSING_EVIDENCE");
      // Paid 0.45 ceiling, earned 0.05 base → 0.40 back to the jar on-chain.
      expect(r.result.receipt.pricing.refundDue).to.equal("400000");
      expect(r.result.receipt.refundTx).to.match(/^0x[0-9a-f]{64}$/);
      expect(await s.token.balanceOf(s.jarAddr)).to.equal(USDC(5) - USDC(0.45) + USDC(0.4));
      expect(await s.token.balanceOf(s.treasury.address)).to.equal(USDC(0.05));
      // Receipt hash anchored on LotusReceipts and equal to the local ledger head.
      expect(await s.receipts.head()).to.equal(s.ledger.head());
      expect(r.result.receipt.anchorTx).to.match(/^0x/);
    } finally {
      s.server.close();
    }
  });

  it("declined approval → nothing paid", async () => {
    const s = await setup();
    try {
      const r = await runCheck({
        api: s.api, cfg: s.cfg, jar: s.jar, approver: s.approver,
        approve: async () => ({ approved: false, by: "test" }),
        claim: "US CPI rose last month", desk: "macro_whitehouse",
      });
      expect(r.status).to.equal("declined");
      expect(await s.token.balanceOf(s.jarAddr)).to.equal(USDC(5));
    } finally {
      s.server.close();
    }
  });

  it("guardian lock → agent is blocked before asking anyone", async () => {
    const s = await setup();
    try {
      await lockJar(s.jarAddr, s.guardian);
      expect((await readJar(s.cfg, s.jarAddr, ethers.provider)).locked).to.equal(true);
      let asked = false;
      const r = await runCheck({
        api: s.api, cfg: s.cfg, jar: s.jar, approver: s.approver,
        approve: async () => ((asked = true), { approved: true, by: "test" }),
        claim: "US CPI rose last month", desk: "macro_whitehouse",
      });
      expect(r.status).to.equal("blocked");
      expect(r.preflightReasons).to.deep.equal(["JAR_LOCKED"]);
      expect(asked).to.equal(false);
    } finally {
      s.server.close();
    }
  });
});

describe("Telegram bot (fake Bot API)", () => {
  function fakeTg() {
    const sent: any[] = [];
    return { sent, tg: { call: async (method: string, params: any) => (sent.push({ method, ...params }), { message_id: sent.length }) } };
  }

  it("only the owner can use it; strangers learn nothing", async () => {
    const { sent, tg } = fakeTg();
    const hub = new ApprovalHub(1000);
    let checks = 0;
    const bot = new LotusBot({ tg, hub, ownerId: "42", explorer: "x", startCheck: async () => ((checks += 1), {} as RunRecord), jarStatus: async () => ({} as any) });
    await bot.handleUpdate({ message: { text: "/check NATO has invoked Article 5", chat: { id: 7 }, from: { id: 7 } } });
    expect(checks).to.equal(0);
    expect(sent.at(-1).text).to.match(/chỉ nhận lệnh từ chủ hũ/);
    await bot.handleUpdate({ message: { text: "/check gold_war NATO has invoked Article 5", chat: { id: 42 }, from: { id: 42 } } });
    expect(checks).to.equal(1);
  });

  it("without an owner it only tells you your chat id", async () => {
    const { sent, tg } = fakeTg();
    const bot = new LotusBot({ tg, hub: new ApprovalHub(1000), explorer: "x", startCheck: async () => ({} as RunRecord), jarStatus: async () => ({} as any) });
    await bot.handleUpdate({ message: { text: "/start", chat: { id: 99 }, from: { id: 99 } } });
    expect(sent[0].text).to.include("TELEGRAM_OWNER_ID=99");
  });

  it("approval card buttons resolve the hub; a stranger's tap is rejected", async () => {
    const { sent, tg } = fakeTg();
    const hub = new ApprovalHub(5000);
    new LotusBot({ tg, hub, ownerId: "42", explorer: "x", startCheck: async () => ({} as RunRecord), jarStatus: async () => ({} as any) });
    const p = hub.request({ runId: "r1", claim: "c", desk: "gold_war", amount: "450000", amountHuman: "0.45", payTo: "0xabc", asset: "0xdef", requestHash: "0x1", remainingToday: "5", quoteExpiresAt: 0, reasons: ["OK"] });
    await new Promise((r) => setImmediate(r));
    const card = sent.find((m) => m.method === "sendMessage" && m.reply_markup);
    expect(card.reply_markup.inline_keyboard[0][0].callback_data).to.equal("ap:r1");
    const bot2 = new LotusBot({ tg, hub, ownerId: "42", explorer: "x", startCheck: async () => ({} as RunRecord), jarStatus: async () => ({} as any) });
    await bot2.handleUpdate({ callback_query: { id: "q0", data: "ap:r1", from: { id: 7 } } });
    expect(hub.listPending()).to.have.length(1);
    await bot2.handleUpdate({ callback_query: { id: "q1", data: "ap:r1", from: { id: 42 }, message: { chat: { id: 42 }, message_id: 1 } } });
    expect(await p).to.deep.equal({ approved: true, by: "telegram" });
  });

  it("unanswered card is declined on timeout (fail-closed)", async () => {
    const hub = new ApprovalHub(50);
    const a = await hub.request({ runId: "r2" } as any);
    expect(a).to.deep.equal({ approved: false, by: "timeout" });
  });

  it("routes desks from free text", () => {
    expect(parseCheck("/check gold_war NATO has invoked Article 5")).to.deep.equal({ desk: "gold_war", claim: "NATO has invoked Article 5" });
    expect(guessDesk("Bitcoin hashrate hit a record")).to.equal("btc_ta");
    expect(guessDesk("HPG chia cổ tức tiền mặt")).to.equal("vn_stocks");
    expect(guessDesk("NATO has invoked Article 5")).to.equal("gold_war");
    expect(guessDesk("US CPI rose last month")).to.equal("macro_whitehouse");
  });
});
