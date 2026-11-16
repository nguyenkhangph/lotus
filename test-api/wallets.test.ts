import { expect } from "chai";
import express from "express";
import fs from "fs";
import os from "os";
import path from "path";
import request from "supertest";
import { ApprovalHub } from "../src/agent/hub";
import type { JarStatus } from "../src/agent/jar";
import type { WalletsStatus } from "../src/agent/wallets";
import { Ledger } from "../src/ledger";
import { formatWallets } from "../src/telegram/bot";
import { dashboardRouter } from "../src/web/dashboard";

const JAR: JarStatus = {
  address: "0x805113113EC069205f59d72137c01244BfAA9619", balance: "2.85", remainingToday: "5", perTx: "0.5", perDay: "5",
  lifetime: "200", spentLifetime: "4.05", locked: false, expiresAt: 1_800_000_000,
  owner: "0xEe00fEE58a8fb0B755aC554f494400034747c4A7", approver: "0x1", guardian: "0x2",
};
const W: WalletsStatus = {
  main: { address: JAR.owner, usdc: "16.2", avax: "0.4210" },
  jar: { address: JAR.address, usdc: "2.85", locked: false, perDay: "5", remainingToday: "5" },
  inbox: {
    address: "0x1234567890abcdef1234567890ABCDEF12345678", usdc: "5", owner: JAR.owner,
    shares: [{ to: JAR.owner, percent: 80, label: "MAIN", role: "main" }, { to: JAR.address, percent: 20, label: "JAR", role: "jar" }],
  },
};

describe("three wallets: main, spending jar, invoice", () => {
  it("dashboard state carries the three wallets (public demo too)", async () => {
    const a = express();
    let seenJar: JarStatus | null = null;
    a.use(dashboardRouter({
      hub: new ApprovalHub(), ledger: new Ledger(path.join(fs.mkdtempSync(path.join(os.tmpdir(), "lotus-w-")), "l.jsonl")),
      network: "avalanche-fuji", explorer: "x", botEnabled: false, allowLocalApprove: false, publicDemo: true,
      jarStatus: async () => JAR,
      wallets: async (j) => ((seenJar = j), W),
    }));
    const s = await request(a).get("/api/state");
    expect(seenJar!.address).to.equal(JAR.address);
    expect(s.body.wallets.inbox.shares.map((x: any) => x.percent)).to.deep.equal([80, 20]);
    expect(s.body.wallets.main.address).to.equal(JAR.owner);
  });

  it("a failing wallet read never breaks the dashboard", async () => {
    const a = express();
    a.use(dashboardRouter({
      hub: new ApprovalHub(), ledger: new Ledger(path.join(fs.mkdtempSync(path.join(os.tmpdir(), "lotus-w-")), "l.jsonl")),
      network: "avalanche-fuji", explorer: "x", botEnabled: false, allowLocalApprove: false, publicDemo: true,
      jarStatus: async () => JAR,
      wallets: async () => { throw new Error("rpc down"); },
    }));
    const s = await request(a).get("/api/state");
    expect(s.status).to.equal(200);
    expect(s.body.wallets).to.equal(null);
    expect(s.body.jar.address).to.equal(JAR.address);
  });

  it("Telegram /wallets explains who can do what", () => {
    const t = formatWallets(W, "https://testnet.snowtrace.io");
    expect(t).to.include("Agent không có khoá");
    expect(t).to.include("80% ví chính · 20% hũ chi tiêu");
    expect(formatWallets({ ...W, inbox: undefined }, "x")).to.include("npm run deploy:inbox");
  });
});
