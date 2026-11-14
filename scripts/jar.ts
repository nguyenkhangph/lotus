/**
 * Jar admin from the terminal.
 *   npm run jar -- status
 *   npm run jar -- lock      (GUARDIAN_PRIVATE_KEY, or the owner key)
 *   npm run jar -- unlock    (owner only = DEPLOYER_PRIVATE_KEY; the bot can never unlock)
 *   npm run jar -- extend 30 (owner only; jar expires 30 days from now, other timing kept)
 */
import { Contract, JsonRpcProvider, Wallet } from "ethers";
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
  } else if (cmd === "extend") {
    const days = Number(process.argv[3] ?? "30");
    if (!(days > 0 && days <= 365)) throw new Error("usage: npm run jar -- extend <days 1..365>");
    if (!process.env.DEPLOYER_PRIVATE_KEY) throw new Error("DEPLOYER_PRIVATE_KEY (jar owner) needed");
    const abi = [
      "function delay() view returns (uint64)", "function expiresAt() view returns (uint64)",
      "function burstWindow() view returns (uint32)", "function burstMax() view returns (uint32)",
      "function setTiming(uint64,uint64,uint32,uint32)",
    ];
    const c = new Contract(jar, abi, new Wallet(process.env.DEPLOYER_PRIVATE_KEY, provider));
    const [delay, oldExp, bw, bm] = await Promise.all([c.delay(), c.expiresAt(), c.burstWindow(), c.burstMax()]);
    const now = (await provider.getBlock("latest"))!.timestamp;
    const exp = BigInt(now + Math.round(days * 86400));
    const tx = await c.setTiming(delay, exp, bw, bm);
    await tx.wait();
    const fmt = (t: bigint) => new Date(Number(t) * 1000).toISOString();
    console.log(`expiresAt ${fmt(oldExp)} -> ${fmt(exp)}, tx ${tx.hash}`);
  } else {
    throw new Error("usage: npm run jar -- status|lock|unlock|extend <days>");
  }
}

main().catch((e) => {
  console.error(e?.shortMessage ?? e?.message ?? e);
  process.exit(1);
});
