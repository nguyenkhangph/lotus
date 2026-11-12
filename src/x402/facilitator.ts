/**
 * Client for a standard x402 facilitator (x402 v1 /verify + /settle), e.g. the Avalanche-listed
 * PayAI, Ultravioleta DAO, thirdweb or a self-hosted x402-rs facilitator, all of which support
 * network "avalanche-fuji". The facilitator pays gas and submits the payer's EIP-3009 authorization.
 */
import type { ExactPayload, PaymentRequirement } from "./types";

export class FacilitatorClient {
  constructor(private url: string, private fetchImpl: typeof fetch = fetch, private headers: Record<string, string> = {}) {}

  private body(p: ExactPayload, req: PaymentRequirement) {
    return JSON.stringify({
      x402Version: 1,
      paymentPayload: { x402Version: 1, scheme: "exact", network: req.network, payload: p },
      paymentRequirements: req,
    });
  }

  async verify(p: ExactPayload, req: PaymentRequirement): Promise<{ isValid: boolean; invalidReason?: string; payer?: string }> {
    const r = await this.fetchImpl(`${this.url.replace(/\/$/, "")}/verify`, {
      method: "POST", headers: { "content-type": "application/json", ...this.headers }, body: this.body(p, req),
    });
    return r.json() as any;
  }

  async settle(p: ExactPayload, req: PaymentRequirement): Promise<string> {
    const v = await this.verify(p, req);
    if (!v.isValid) throw new Error(`facilitator verify: ${v.invalidReason ?? "invalid"}`);
    const r = await this.fetchImpl(`${this.url.replace(/\/$/, "")}/settle`, {
      method: "POST", headers: { "content-type": "application/json", ...this.headers }, body: this.body(p, req),
    });
    const j: any = await r.json();
    const tx = j.transaction ?? j.txHash;
    if (!j.success || !tx) throw new Error(`facilitator settle: ${j.errorReason ?? j.error ?? r.status}`);
    return tx;
  }
}
