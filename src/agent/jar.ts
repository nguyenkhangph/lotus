import { Contract, encodeBytes32String, type Provider, type Signer } from "ethers";
import type { LotusConfig } from "../config";
import { JAR_ABI } from "./runner";

const ERC20_ABI = ["function balanceOf(address) view returns (uint256)", "function transfer(address,uint256) returns (bool)"];

export type JarStatus = {
  address: string;
  balance: string; // human units
  remainingToday: string;
  perTx: string;
  perDay: string;
  lifetime: string;
  spentLifetime: string;
  locked: boolean;
  expiresAt: number;
  owner: string;
  approver: string;
  guardian: string;
};

export async function readJar(cfg: LotusConfig, jarAddr: string, provider: Provider): Promise<JarStatus> {
  const jar = new Contract(jarAddr, JAR_ABI, provider);
  const usdc = new Contract(cfg.asset, ERC20_ABI, provider);
  const d = 10 ** cfg.assetDecimals;
  const h = (x: bigint) => (Number(x) / d).toString();
  const [bal, rem, caps, spent, locked, exp, owner, approver, guardian] = await Promise.all([
    usdc.balanceOf(jarAddr), jar.remainingToday(), jar.caps(), jar.spentLifetime(), jar.locked(), jar.expiresAt(),
    jar.owner(), jar.approver(), jar.guardian(),
  ]);
  return {
    address: jarAddr,
    balance: h(bal),
    remainingToday: h(rem),
    perTx: h(caps.perTx),
    perDay: h(caps.perDay),
    lifetime: h(caps.lifetime),
    spentLifetime: h(spent),
    locked,
    expiresAt: Number(exp),
    owner,
    approver,
    guardian,
  };
}

/** Kill switch from the guardian key: can lock, can never spend or unlock. */
export async function lockJar(jarAddr: string, guardian: Signer, reason = "TELEGRAM"): Promise<string> {
  const jar = new Contract(jarAddr, JAR_ABI, guardian);
  const tx = await jar.lock(encodeBytes32String(reason.slice(0, 31)));
  await tx.wait();
  return tx.hash;
}

/** Owner-only: unlocking stays a deliberate action from the owner's own key, never from the bot. */
export async function unlockJar(jarAddr: string, owner: Signer): Promise<string> {
  const jar = new Contract(jarAddr, JAR_ABI, owner);
  const tx = await jar.unlock();
  await tx.wait();
  return tx.hash;
}

/** Treasury returns the unused part of an `upto` payment to the payer (jar or wallet). */
export async function sendRefund(cfg: LotusConfig, treasury: Signer, to: string, amount: bigint): Promise<string> {
  const usdc = new Contract(cfg.asset, ERC20_ABI, treasury);
  const tx = await usdc.transfer(to, amount);
  await tx.wait();
  return tx.hash;
}
