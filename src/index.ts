import { encodeBytes32String } from "ethers";
import { loadConfig } from "./config";
import { createApp } from "./app";
import { DeskRouter, FixtureProvider, HnxRssProvider } from "./evidence/providers";
import { Ledger } from "./ledger";
import { EthersChain } from "./x402/chain";

const cfg = loadConfig();
const chain = new EthersChain(cfg, process.env.FACILITATOR_PRIVATE_KEY);
const evidence = new DeskRouter({ vn_stocks: new HnxRssProvider() }, new FixtureProvider());
const ledger = new Ledger(cfg.ledgerPath);

const app = createApp({
  cfg,
  chain,
  evidence,
  ledger,
  anchor: (r, p, pack, reason) => chain.anchor(r, p, pack, encodeBytes32String(reason.slice(0, 31))),
});

const port = Number(process.env.PORT ?? 8402);
app.listen(port, () => {
  console.log(`Lotus API on :${port} — network ${cfg.network} (${cfg.chainId}), payTo ${cfg.treasury}`);
});
