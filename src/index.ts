import { Contract, Wallet, encodeBytes32String } from "ethers";
import { loadConfig } from "./config";
import { createApp } from "./app";
import { DeskRouter, FixtureProvider, HnxRssProvider } from "./evidence/providers";
import { Ledger } from "./ledger";
import { EthersChain } from "./x402/chain";
import { ApprovalHub } from "./agent/hub";
import { JAR_ABI, runCheck } from "./agent/runner";
import { lockJar, readJar, sendRefund } from "./agent/jar";
import { LotusBot, TelegramApi } from "./telegram/bot";
import { dashboardRouter } from "./web/dashboard";

const env = process.env;
const cfg = loadConfig();
const port = Number(env.PORT ?? 8402);
const api = env.LOTUS_API ?? `http://127.0.0.1:${port}`;
const explorer = env.EXPLORER_URL ?? "https://testnet.snowtrace.io";

const chain = new EthersChain(cfg, env.FACILITATOR_PRIVATE_KEY, { facilitatorUrl: env.X402_FACILITATOR_URL || undefined });
const provider = chain.provider;
const evidence = new DeskRouter({ vn_stocks: new HnxRssProvider() }, new FixtureProvider());
const ledger = new Ledger(cfg.ledgerPath);
const hub = new ApprovalHub(Number(env.APPROVAL_TIMEOUT_MS ?? 120_000));

// Optional on-chain refund of the unused `upto` part: needs the TREASURY key (+ a little AVAX for gas).
const treasury = env.TREASURY_PRIVATE_KEY ? new Wallet(env.TREASURY_PRIVATE_KEY, provider) : undefined;
if (treasury && treasury.address.toLowerCase() !== cfg.treasury.toLowerCase()) {
  throw new Error("TREASURY_PRIVATE_KEY does not match TREASURY_ADDRESS");
}

const app = createApp({
  cfg,
  chain,
  evidence,
  ledger,
  anchor: (r, p, pack, reason) => chain.anchor(r, p, pack, encodeBytes32String(reason.slice(0, 31))),
  refund: treasury ? (to, amount) => sendRefund(cfg, treasury, to, amount) : undefined,
});

// ---------------------------------------------------------------- agent (buyer side)
const jarAddr = env.JAR_ADDRESS;
const agentReady = Boolean(jarAddr && env.AGENT_PRIVATE_KEY && env.APPROVER_PRIVATE_KEY);
const jarStatus = jarAddr ? () => readJar(cfg, jarAddr, provider) : undefined;

const botToken = env.TELEGRAM_BOT_TOKEN;
const startCheck = agentReady
  ? (claim: string, desk: string) =>
      runCheck({
        api,
        cfg,
        jar: new Contract(jarAddr!, JAR_ABI, new Wallet(env.AGENT_PRIVATE_KEY!, provider)),
        approver: new Wallet(env.APPROVER_PRIVATE_KEY!),
        approve: (card) => hub.request(card),
        claim,
        desk,
        maxPerCall: BigInt(env.MAX_PER_CALL ?? "500000"),
        onUpdate: (r) => hub.record(r),
      })
  : undefined;

app.use(
  dashboardRouter({
    hub,
    ledger,
    network: cfg.network,
    explorer,
    jarStatus,
    startCheck,
    botEnabled: Boolean(botToken),
    allowLocalApprove: !botToken || env.DASHBOARD_APPROVE === "1",
  }),
);

app.listen(port, () => {
  console.log(`Lotus API + dashboard on http://localhost:${port} — ${cfg.network} (${cfg.chainId}), payTo ${cfg.treasury}`);
  console.log(`  exact settle : ${env.X402_FACILITATOR_URL ? "x402 facilitator " + env.X402_FACILITATOR_URL : env.FACILITATOR_PRIVATE_KEY ? "self (FACILITATOR_PRIVATE_KEY)" : "disabled"}`);
  console.log(`  refunds      : ${treasury ? "on-chain from TREASURY" : "recorded only (set TREASURY_PRIVATE_KEY to send)"}`);
  console.log(`  agent        : ${agentReady ? "ready (jar " + jarAddr + ")" : "off (needs JAR_ADDRESS, AGENT_PRIVATE_KEY, APPROVER_PRIVATE_KEY)"}`);
});

// ---------------------------------------------------------------- Telegram
if (botToken && startCheck && jarStatus) {
  const guardian = env.GUARDIAN_PRIVATE_KEY ? new Wallet(env.GUARDIAN_PRIVATE_KEY, provider) : undefined;
  const bot = new LotusBot({
    tg: new TelegramApi(botToken),
    hub,
    ownerId: env.TELEGRAM_OWNER_ID || undefined,
    explorer,
    startCheck,
    jarStatus,
    lock: guardian ? () => lockJar(jarAddr!, guardian) : undefined,
    dashboardUrl: env.DASHBOARD_URL,
  });
  bot.start();
  console.log(`  telegram     : on${env.TELEGRAM_OWNER_ID ? "" : " (send /start to the bot to get your TELEGRAM_OWNER_ID)"}${guardian ? ", /lock enabled" : ", /lock needs GUARDIAN_PRIVATE_KEY"}`);
} else if (botToken) {
  console.log("  telegram     : token set, but agent is off — fill JAR_ADDRESS, AGENT_PRIVATE_KEY, APPROVER_PRIVATE_KEY");
}
