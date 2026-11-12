import * as dotenv from "dotenv";
dotenv.config();

/** Avalanche Fuji test network. Everything here is testnet-only. */
export const FUJI = {
  chainId: 43113,
  network: "avalanche-fuji",
  // Circle test USDC on Fuji (6 decimals).
  usdc: "0x5425890298aed601595a70AB815c96711a31Bc65",
  usdcDecimals: 6,
  // EIP-712 domain of FiatToken v2 used by EIP-3009 transferWithAuthorization.
  usdcDomainName: "USDC",
  usdcDomainVersion: "2",
} as const;

export type LotusConfig = {
  chainId: number;
  network: string;
  rpcUrl: string;
  asset: string;
  assetDecimals: number;
  assetDomainName: string;
  assetDomainVersion: string;
  treasury: string; // payTo for evidence payments
  jarFactory?: string; // LotusJarFactory address (lotus-jar scheme)
  receiptsContract?: string; // LotusReceipts address (optional anchoring)
  pricing: {
    base: bigint; // charged even if zero sources found (covers the search)
    perSource: bigint; // per independent source unit delivered
    maxSources: number; // ceiling for `upto`
  };
  quoteTtlSeconds: number;
  ledgerPath: string;
};

export function loadConfig(env = process.env): LotusConfig {
  return {
    chainId: Number(env.CHAIN_ID ?? FUJI.chainId),
    network: env.NETWORK ?? FUJI.network,
    rpcUrl: env.FUJI_RPC_URL ?? "https://api.avax-test.network/ext/bc/C/rpc",
    asset: env.ASSET_ADDRESS ?? FUJI.usdc,
    assetDecimals: Number(env.ASSET_DECIMALS ?? FUJI.usdcDecimals),
    assetDomainName: env.ASSET_DOMAIN_NAME ?? FUJI.usdcDomainName,
    assetDomainVersion: env.ASSET_DOMAIN_VERSION ?? FUJI.usdcDomainVersion,
    treasury: env.TREASURY_ADDRESS ?? "0x000000000000000000000000000000000000dEaD",
    jarFactory: env.JAR_FACTORY_ADDRESS || undefined,
    receiptsContract: env.RECEIPTS_ADDRESS || undefined,
    pricing: {
      base: BigInt(env.PRICE_BASE ?? "50000"), // 0.05 test USDC
      perSource: BigInt(env.PRICE_PER_SOURCE ?? "50000"), // 0.05 per independent source
      maxSources: Number(env.PRICE_MAX_SOURCES ?? "8"),
    },
    quoteTtlSeconds: Number(env.QUOTE_TTL_SECONDS ?? "300"),
    ledgerPath: env.LEDGER_PATH ?? "data/ledger.jsonl",
  };
}

export function maxPrice(cfg: LotusConfig): bigint {
  return cfg.pricing.base + cfg.pricing.perSource * BigInt(cfg.pricing.maxSources);
}
