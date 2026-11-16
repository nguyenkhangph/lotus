/**
 * Read-only public demo app (Vercel / any serverless host). No private key is ever loaded here:
 *  - dashboard reads the jar and receipts from Avalanche Fuji,
 *  - POST /v1/score answers HTTP 402 with x402 payment terms (paying is done from the owner's machine),
 *  - nobody can submit claims or approve spends (PUBLIC_DEMO forced on).
 */
import fs from "fs";
import os from "os";
import path from "path";
import { JsonRpcProvider } from "ethers";
import { createApp } from "./app";
import { loadConfig } from "./config";
import { DeskRouter, FixtureProvider, HnxRssProvider } from "./evidence/providers";
import { Ledger } from "./ledger";
import { ApprovalHub } from "./agent/hub";
import { readWallets } from "./agent/wallets";
import { readJar } from "./agent/jar";
import { EthersChain } from "./x402/chain";
import { dashboardRouter } from "./web/dashboard";

/** Serverless disks are read-only: copy the committed ledger snapshot to a writable temp file. */
export function writableLedger(snapshot: string): Ledger {
  const tmp = path.join(os.tmpdir(), "lotus-ledger.jsonl");
  if (!fs.existsSync(tmp) || fs.statSync(tmp).size === 0) {
    try {
      fs.copyFileSync(snapshot, tmp);
    } catch {
      fs.writeFileSync(tmp, "");
    }
  }
  return new Ledger(tmp);
}

/** Receipt index → refund tx, committed alongside the ledger snapshot. */
export function readRefunds(file: string): Record<string, string> {
  try {
    const j = JSON.parse(fs.readFileSync(file, "utf8"));
    return Object.fromEntries(Object.entries(j).filter(([k, v]) => /^\d+$/.test(k) && typeof v === "string")) as Record<string, string>;
  } catch {
    return {};
  }
}

export function buildPublicApp(env: NodeJS.ProcessEnv = process.env) {
  const cfg = loadConfig(env);
  const provider = new JsonRpcProvider(cfg.rpcUrl, cfg.chainId, { staticNetwork: true });
  // No facilitator key: the public demo can verify jar payments but never sends a transaction itself.
  const chain = new EthersChain(cfg, undefined, { provider });
  const root = path.join(__dirname, "..");
  const ledger = writableLedger(path.join(root, env.LEDGER_SNAPSHOT ?? "data/demo/ledger.jsonl"));
  const app = createApp({
    cfg,
    chain,
    ledger,
    evidence: new DeskRouter({ vn_stocks: new HnxRssProvider() }, new FixtureProvider()),
  });
  const jarAddr = env.JAR_ADDRESS ?? "0x805113113EC069205f59d72137c01244BfAA9619";
  app.use(
    dashboardRouter({
      hub: new ApprovalHub(),
      ledger,
      network: cfg.network,
      explorer: env.EXPLORER_URL ?? "https://testnet.snowtrace.io",
      jarStatus: jarAddr ? () => readJar(cfg, jarAddr, provider) : undefined,
      botEnabled: false,
      allowLocalApprove: false,
      publicDemo: true,
      treasury: cfg.treasury,
      refunds: readRefunds(path.join(root, "data/demo/refunds.json")),
      wallets: (j) => readWallets(cfg, provider, j, env.INBOX_ADDRESS || "0xd878Ba74d2bbc1AA4eA669578D13E94db202fA20"),
      contracts: { factory: env.JAR_FACTORY_ADDRESS ?? "0xCD336298223605c0c6c792Bcd7bd2a3F4DCc9546", receipts: env.RECEIPTS_ADDRESS ?? "0xD8cDc230225448b005DBCE3B935ac53e2057DAd8", jar: env.JAR_ADDRESS ?? "0x805113113EC069205f59d72137c01244BfAA9619", inbox: env.INBOX_ADDRESS || "0xd878Ba74d2bbc1AA4eA669578D13E94db202fA20" },
    }),
  );
  return app;
}
