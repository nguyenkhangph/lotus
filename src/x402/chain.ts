import { Contract, JsonRpcProvider, Signature, Wallet, type Provider } from "ethers";
import type { LotusConfig } from "../config";
import type { ChainReader } from "./server";
import type { ExactPayload, PaymentRequirement } from "./types";
import { FacilitatorClient } from "./facilitator";

const FACTORY_ABI = ["function isJar(address) view returns (bool)"];
const USDC_ABI = [
  "function transferWithAuthorization(address from,address to,uint256 value,uint256 validAfter,uint256 validBefore,bytes32 nonce,uint8 v,bytes32 r,bytes32 s)",
];
const RECEIPTS_ABI = [
  "function head() view returns (bytes32)",
  "function anchor(bytes32 receiptHash, bytes32 prevHash, bytes32 evidencePackHash, bytes32 reasonCode)",
];

/**
 * Real Fuji access. The facilitator key only pays gas to submit a payer-signed EIP-3009
 * authorization; it can never move anyone's funds on its own.
 */
export class EthersChain implements ChainReader {
  readonly provider: Provider;
  private facilitator?: Wallet;
  private remote?: FacilitatorClient;

  constructor(private cfg: LotusConfig, facilitatorKey?: string, opts: { provider?: Provider; facilitatorUrl?: string } = {}) {
    this.provider = opts.provider ?? new JsonRpcProvider(cfg.rpcUrl, cfg.chainId);
    if (facilitatorKey) this.facilitator = new Wallet(facilitatorKey, this.provider);
    if (opts.facilitatorUrl) this.remote = new FacilitatorClient(opts.facilitatorUrl);
  }

  async getReceipt(txHash: string) {
    const rc = await this.provider.getTransactionReceipt(txHash);
    if (!rc) return null;
    return {
      status: rc.status ?? 0,
      logs: rc.logs.map((l) => ({ address: l.address, topics: [...l.topics], data: l.data })),
    };
  }

  async isJar(addr: string) {
    if (!this.cfg.jarFactory) return false;
    const f = new Contract(this.cfg.jarFactory, FACTORY_ABI, this.provider);
    return Boolean(await f.isJar(addr));
  }

  async settleExact(p: ExactPayload, req: PaymentRequirement): Promise<string> {
    // Prefer a standard x402 facilitator when configured (PayAI / Ultravioleta / x402-rs on avalanche-fuji).
    if (this.remote) return this.remote.settle(p, req);
    if (!this.facilitator) throw new Error("FACILITATOR_PRIVATE_KEY not set");
    const sig = Signature.from(p.signature);
    const a = p.authorization;
    const usdc = new Contract(this.cfg.asset, USDC_ABI, this.facilitator);
    const tx = await usdc.transferWithAuthorization(a.from, a.to, a.value, a.validAfter, a.validBefore, a.nonce, sig.v, sig.r, sig.s);
    const rc = await tx.wait();
    if (!rc || rc.status !== 1) throw new Error("settlement reverted");
    return tx.hash as string;
  }

  /** Anchors a receipt hash on LotusReceipts (only hashes go on-chain). */
  async anchor(receiptHash: string, prevHash: string, packHash: string, reasonCode: string): Promise<string | undefined> {
    if (!this.cfg.receiptsContract || !this.facilitator) return undefined;
    const c = new Contract(this.cfg.receiptsContract, RECEIPTS_ABI, this.facilitator);
    const tx = await c.anchor(receiptHash, prevHash, packHash, reasonCode);
    await tx.wait();
    return tx.hash as string;
  }
}
