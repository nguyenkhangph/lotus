/**
 * Deploys the invoice wallet (LotusInbox) to Avalanche Fuji and verifies it on Snowtrace.
 *   npm run deploy:inbox
 *
 * Owner = the deployer (the main wallet). Default split: 80% to the main wallet, 20% to the
 * agent's spending jar (JAR_ADDRESS). Change the jar part with INBOX_JAR_PERCENT=10, for example.
 * Then put INBOX_ADDRESS=0x… in .env (and in Vercel's environment variables).
 */
import hre, { ethers, network } from "hardhat";

async function main() {
  if (network.name === "fuji" && (await ethers.provider.getNetwork()).chainId !== 43113n) throw new Error("not Fuji");
  const [deployer] = await ethers.getSigners();
  const jar = process.env.JAR_ADDRESS;
  if (!jar) throw new Error("JAR_ADDRESS is required (the spending jar receives its share of invoices)");
  const jarPct = Number(process.env.INBOX_JAR_PERCENT ?? "20");
  if (!(jarPct > 0 && jarPct < 100)) throw new Error("INBOX_JAR_PERCENT must be between 1 and 99");
  const L = (s: string) => ethers.encodeBytes32String(s);
  const shares = [
    { to: deployer.address, bps: (100 - jarPct) * 100, label: L("MAIN") },
    { to: jar, bps: jarPct * 100, label: L("JAR") },
  ];
  console.log(`deployer (main wallet) ${deployer.address} on ${network.name}`);
  const inbox = await (await ethers.getContractFactory("LotusInbox")).deploy(deployer.address, shares);
  await inbox.waitForDeployment();
  const addr = await inbox.getAddress();
  console.log(`LotusInbox ${addr}  (split: ${100 - jarPct}% main wallet, ${jarPct}% spending jar)`);
  console.log(`\nAdd to .env and to Vercel → Settings → Environment Variables:\n  INBOX_ADDRESS=${addr}\n`);

  if (network.name === "fuji") {
    console.log("waiting for 5 confirmations before verifying…");
    await inbox.deploymentTransaction()!.wait(5);
    try {
      await hre.run("verify:verify", { address: addr, constructorArguments: [deployer.address, shares], contract: "contracts/LotusInbox.sol:LotusInbox" });
    } catch (e: any) {
      console.log("verify later with: npm run verify:fuji  →", String(e?.message ?? e).split("\n")[0]);
    }
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
