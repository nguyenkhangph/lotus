import { ERC20_IFACE, JAR_IFACE, type ChainReader } from "./server";
import type { ExactPayload, PaymentRequirement } from "./types";

/** In-memory chain for tests and the offline demo. Never used against Fuji. */
export class FakeChain implements ChainReader {
  receipts = new Map<string, { status: number; logs: { address: string; topics: string[]; data: string }[] }>();
  jars = new Set<string>();
  settled: ExactPayload[] = [];

  async getReceipt(txHash: string) {
    return this.receipts.get(txHash.toLowerCase()) ?? null;
  }
  async isJar(addr: string) {
    return this.jars.has(addr.toLowerCase());
  }
  async settleExact(p: ExactPayload, _req?: PaymentRequirement) {
    this.settled.push(p);
    return "0x" + (this.settled.length).toString(16).padStart(64, "0");
  }

  /** Records a jar payment as it would appear on-chain (SpendExecuted + USDC Transfer). */
  addJarPayment(o: { txHash: string; jar: string; asset: string; payTo: string; amount: bigint; requestHash: string; transferFrom?: string }) {
    const spend = JAR_IFACE.encodeEventLog("SpendExecuted", ["0x" + "11".repeat(32), o.asset, o.payTo, o.amount, o.requestHash]);
    const xfer = ERC20_IFACE.encodeEventLog("Transfer", [o.transferFrom ?? o.jar, o.payTo, o.amount]);
    this.receipts.set(o.txHash.toLowerCase(), {
      status: 1,
      logs: [
        { address: o.jar, topics: spend.topics, data: spend.data },
        { address: o.asset, topics: xfer.topics, data: xfer.data },
      ],
    });
  }
}
