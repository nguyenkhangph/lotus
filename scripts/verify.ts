/**
 * Verifies the deployed Lotus contracts on Snowtrace (Routescan) so anyone can read the source.
 *   npm run verify:fuji
 * Uses JAR_FACTORY_ADDRESS, RECEIPTS_ADDRESS, JAR_ADDRESS from .env. The jar's constructor
 * arguments are read back from the chain (the jar never changed its config since deployment).
 */
import hre, { ethers } from "hardhat";
import { FUJI } from "../src/config";

async function verify(address: string, constructorArguments: unknown[], contract?: string) {
  try {
    await hre.run("verify:verify", { address, constructorArguments, contract });
    console.log("verified", address);
  } catch (e: any) {
    const msg = String(e?.message ?? e);
    if (/already verified/i.test(msg)) console.log("already verified", address);
    else console.error("FAILED", address, msg.split("\n")[0]);
  }
}

async function main() {
  const env = process.env;
  const [deployer] = await ethers.getSigners();
  if (env.JAR_FACTORY_ADDRESS) await verify(env.JAR_FACTORY_ADDRESS, [], "contracts/LotusJarFactory.sol:LotusJarFactory");
  if (env.RECEIPTS_ADDRESS) await verify(env.RECEIPTS_ADDRESS, [deployer.address], "contracts/LotusReceipts.sol:LotusReceipts");
  if (env.JAR_ADDRESS) {
    const jar = await ethers.getContractAt("LotusJar", env.JAR_ADDRESS);
    const caps = await jar.caps();
    const cfg = {
      owner: await jar.owner(),
      approver: await jar.approver(),
      guardian: await jar.guardian(),
      tokens: [env.ASSET_ADDRESS ?? FUJI.usdc],
      payTos: [env.TREASURY_ADDRESS!],
      caps: { perTx: caps.perTx, perDay: caps.perDay, lifetime: caps.lifetime },
      expiresAt: await jar.expiresAt(),
      delay: await jar.delay(),
      burstWindow: await jar.burstWindow(),
      burstMax: await jar.burstMax(),
    };
    await verify(env.JAR_ADDRESS, [cfg], "contracts/LotusJar.sol:LotusJar");
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
