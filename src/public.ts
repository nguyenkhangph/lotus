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
import { readJar } from "./agent/jar";
import { EthersChain } from "./x402/chain";
import { dashboardRouter } from "./web/dashboard";

/** Serverless disks are read-only: copy the committed ledger snapshot to a writable temp file. */
export function writableLedger(snapshot: string): Ledger {
  const tmp = path.join(os.tmpdir(), "lotus-ledger.jsonl");
  if (!fs.existsSync(tmp)) {
    try {
      fs.copyFileSync(snapshot, tmp);
    } catch {
      fs.writeFileSync(tmp, "");
    }
  }
  return new Ledger(tmp);
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
  const jarAddr = env.JAR_ADDRESS;
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
    }),
  );
  return app;
}
