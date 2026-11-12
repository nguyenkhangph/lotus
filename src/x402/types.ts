/**
 * x402-style payment terms. Lotus follows the x402 v1 shape (HTTP 402 + `accepts[]`,
 * `X-PAYMENT` request header, `X-PAYMENT-RESPONSE` response header) and offers two schemes:
 *
 *  - "exact"     : standard x402 EVM scheme, an EIP-3009 transferWithAuthorization signed by the
 *                  payer. Lotus additionally requires authorization.nonce == requestHash, so the
 *                  signature is bound to one exact request body + route.
 *  - "lotus-jar" : the payer's LotusJar (policy contract) pays on-chain after the user approved the
 *                  spend; the client then sends the tx hash. The jar's SpendExecuted log carries
 *                  the requestHash, so the payment is bound to the request as well.
 */
export type PaymentRequirement = {
  scheme: "exact" | "lotus-jar";
  network: string; // "avalanche-fuji"
  chainId: number;
  maxAmountRequired: string; // base units (upto ceiling)
  resource: string; // route
  description: string;
  mimeType: string;
  payTo: string;
  maxTimeoutSeconds: number;
  asset: string; // token address
  extra: {
    name: string; // EIP-712 domain name of the asset
    version: string;
    requestHash: string;
    quoteId: string;
    expiresAt: number; // unix seconds
    pricing: { model: "upto"; base: string; perSource: string; maxSources: number };
    jarFactory?: string;
  };
};

export type PaymentRequired = {
  x402Version: 1;
  error: string;
  accepts: PaymentRequirement[];
};

export type ExactPayload = {
  signature: string;
  authorization: {
    from: string;
    to: string;
    value: string;
    validAfter: string;
    validBefore: string;
    nonce: string; // must equal requestHash
  };
};

export type JarPayload = { txHash: string; jar: string };

export type PaymentHeader = {
  x402Version: 1;
  scheme: "exact" | "lotus-jar";
  network: string;
  quoteId: string;
  payload: ExactPayload | JarPayload;
};

export type VerifyResult =
  | { ok: true; payer: string; amount: bigint; ref: string; tx: string }
  | { ok: false; reason: string };

export function encodeHeader(h: unknown): string {
  return Buffer.from(JSON.stringify(h), "utf8").toString("base64");
}

export function decodeHeader<T>(b64: string): T {
  return JSON.parse(Buffer.from(b64, "base64").toString("utf8")) as T;
}
