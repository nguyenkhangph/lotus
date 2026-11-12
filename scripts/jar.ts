/**
 * Jar admin from the terminal.
 *   npm run jar -- status
 *   npm run jar -- lock      (GUARDIAN_PRIVATE_KEY, or the owner key)
 *   npm run jar -- unlock    (owner only = DEPLOYER_PRIVATE_KEY; the bot can never unlock)
 */
import { JsonRpcProvider, Wallet } from "ethers";
import { loadConfig } from "../src/config";
import { lockJar, readJar, unlockJar } from "../src/agent/jar";

async function main() {
  const cmd = process.argv[2] ?? "status";
  const cfg = loadConfig();
  const provider = new JsonRpcProvider(cfg.rpcUrl, cfg.chainId);
  const jar = process.env.JAR_ADDRESS;
  if (!jar) throw new Error("JAR_ADDRESS missing in .env");
  if (cmd === "status") {
    console.log(await readJar(cfg, jar, provider));
  } else if (cmd === "lock") {
    const key = process.env.GUARDIAN_PRIVATE_KEY ?? process.env.DEPLOYER_PRIVATE_KEY;
    if (!key) throw new Error("GUARDIAN_PRIVATE_KEY or DEPLOYER_PRIVATE_KEY needed");
    console.log("locked, tx", await lockJar(jar, new Wallet(key, provider), "TERMINAL"));
  } else if (cmd === "unlock") {
    if (!process.env.DEPLOYER_PRIVATE_KEY) throw new Error("DEPLOYER_PRIVATE_KEY (jar owner) needed");
    console.log("unlocked, tx", await unlockJar(jar, new Wallet(process.env.DEPLOYER_PRIVATE_KEY, provider)));
  } else {
    throw new Error("usage: npm run jar -- status|lock|unlock");
  }
}

main().catch((e) => {
  console.error(e?.shortMessage ?? e?.message ?? e);
  process.exit(1);
});
