import { Contract, decodeBytes32String, type Provider, type Signer } from "ethers";
import type { LotusConfig } from "../config";
import type { JarStatus } from "./jar";

/**
 * Three wallets, three different powers:
 *  - main wallet (the jar owner's key): holds savings; the agent has no key and no allowance on it;
 *  - spending jar (LotusJar): the only money the agent can ask to spend, within on-chain caps;
 *  - invoice wallet (LotusInbox): only receives; funds leave only by the owner's split.
 */
export type WalletsStatus = {
  main: { address: string; usdc: string; avax: string };
  jar: { address: string; usdc: string; locked: boolean; perDay: string; remainingToday: string };
  inbox?: { address: string; usdc: string; owner: string; shares: { to: string; percent: number; label: string; role: "main" | "jar" | "other" }[] };
};

const ERC20 = ["function balanceOf(address) view returns (uint256)"];
export const INBOX_ABI = [
  "function owner() view returns (address)",
  "function shares() view returns ((address to,uint16 bps,bytes32 label)[])",
  "function sweep(address token) returns (uint256)",
  "event Paid(address indexed token, address indexed to, uint256 amount, bytes32 label)",
];

export async function readWallets(cfg: LotusConfig, provider: Provider, jar: JarStatus, inboxAddr?: string): Promise<WalletsStatus> {
  const usdc = new Contract(cfg.asset, ERC20, provider);
  const d = 10 ** cfg.assetDecimals;
  const h = (x: bigint) => (Number(x) / d).toString();
  const [mainUsdc, mainAvax] = await Promise.all([usdc.balanceOf(jar.owner), provider.getBalance(jar.owner)]);
  const out: WalletsStatus = {
    main: { address: jar.owner, usdc: h(mainUsdc), avax: (Number(mainAvax) / 1e18).toFixed(4) },
    jar: { address: jar.address, usdc: jar.balance, locked: jar.locked, perDay: jar.perDay, remainingToday: jar.remainingToday },
  };
  if (inboxAddr) {
    const inbox = new Contract(inboxAddr, INBOX_ABI, provider);
    const [bal, owner, shares] = await Promise.all([usdc.balanceOf(inboxAddr), inbox.owner(), inbox.shares()]);
    const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();
    out.inbox = {
      address: inboxAddr,
      usdc: h(bal),
      owner,
      shares: shares.map((s: any) => ({
        to: s.to,
        percent: Number(s.bps) / 100,
        label: safeLabel(s.label),
        role: same(s.to, jar.owner) ? "main" : same(s.to, jar.address) ? "jar" : "other",
      })),
    };
  }
  return out;
}

function safeLabel(b: string): string {
  try {
    return decodeBytes32String(b);
  } catch {
    return "";
  }
}

/** Anyone may sweep: the contract decides where the money goes, not the caller. */
export async function sweepInbox(cfg: LotusConfig, inboxAddr: string, signer: Signer): Promise<string> {
  const bal: bigint = await new Contract(cfg.asset, ERC20, signer).balanceOf(inboxAddr);
  if (bal === 0n) throw new Error("NothingToSweep: the invoice wallet is empty");
  const tx = await new Contract(inboxAddr, INBOX_ABI, signer).sweep(cfg.asset);
  await tx.wait();
  return tx.hash;
}
