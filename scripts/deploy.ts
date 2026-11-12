/**
 * Deploys Lotus to Avalanche Fuji:
 *   1. LotusJarFactory
 *   2. LotusReceipts (operator = deployer)
 *   3. A demo jar owned by the deployer, with the caps from the plan
 *
 *   npx hardhat run scripts/deploy.ts --network fuji
 *
 * Testnet only. Needs DEPLOYER_PRIVATE_KEY with test AVAX, TREASURY_ADDRESS, and optionally
 * APPROVER_ADDRESS (bot approval key) and GUARDIAN_ADDRESS (bot that may cancel/lock).
 */
import { ethers, network } from "hardhat";
import { FUJI } from "../src/config";

async function main() {
  if (network.name === "fuji" && (await ethers.provider.getNetwork()).chainId !== 43113n) {
    throw new Error("not Fuji");
  }
  const [deployer] = await ethers.getSigners();
  const treasury = process.env.TREASURY_ADDRESS;
  if (!treasury) throw new Error("TREASURY_ADDRESS is required");
  const usdc = process.env.ASSET_ADDRESS ?? FUJI.usdc;
  const usd = (n: number) => ethers.parseUnits(n.toString(), 6);

  console.log(`deployer ${deployer.address} on ${network.name}`);

  const factory = await (await ethers.getContractFactory("LotusJarFactory")).deploy();
  await factory.waitForDeployment();
  console.log("LotusJarFactory", await factory.getAddress());

  const receipts = await (await ethers.getContractFactory("LotusReceipts")).deploy(deployer.address);
  await receipts.waitForDeployment();
  console.log("LotusReceipts  ", await receipts.getAddress());

  const now = Math.floor(Date.now() / 1000);
  const cfg = {
    owner: ethers.ZeroAddress, // forced to msg.sender by the factory
    approver: process.env.APPROVER_ADDRESS ?? ethers.ZeroAddress,
    guardian: process.env.GUARDIAN_ADDRESS ?? ethers.ZeroAddress,
    tokens: [usdc],
    payTos: [treasury],
    // Evidence jar caps from the plan: 0.5 per call, 5 per day, 200 lifetime, 7-day expiry.
    caps: { perTx: usd(0.5), perDay: usd(5), lifetime: usd(200) },
    expiresAt: BigInt(now + 7 * 24 * 3600),
    delay: 0n, // evidence payments execute immediately; order jars would use ~120s
    burstWindow: 60,
    burstMax: 10,
  };
  const rc = await (await (factory as any).createJar(cfg)).wait();
  const ev = rc.logs.map((l: any) => factory.interface.parseLog(l)).find((e: any) => e?.name === "JarCreated");
  console.log("Demo LotusJar  ", ev.args.jar);
  console.log("\nAdd to .env:");
  console.log(`JAR_FACTORY_ADDRESS=${await factory.getAddress()}`);
  console.log(`RECEIPTS_ADDRESS=${await receipts.getAddress()}`);
  console.log(`JAR_ADDRESS=${ev.args.jar}`);
  console.log("\nThen send test USDC to the jar address (faucet.circle.com → Avalanche Fuji).");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
