import fs from "fs";
import path from "path";
import { canonicalJson, hashJson, sha256Hex } from "./util/hash";
import type { ScoreResult } from "./engine/types";

export const GENESIS = "0x" + "0".repeat(64);

export type Receipt = {
  index: number;
  prevHash: string;
  createdAt: string;
  requestHash: string;
  claimHash: string; // hash only: claim text stays off-chain
  desk: string;
  deskLive: boolean;
  evidencePackHash: string;
  verdict: ScoreResult["verdict"];
  score: number;
  echoIndex: number;
  independentSupport: number;
  reasonCodes: string[];
  payment?: { scheme: string; ref: string; amount: string; payer?: string };
  pricing?: { charged: string; earned: string; refundDue: string };
  hash: string; // sha256 over every field above
};

/** Append-only JSONL ledger; every line links to the previous one (hash chain). */
export class Ledger {
  constructor(private file: string) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    if (!fs.existsSync(file)) fs.writeFileSync(file, "");
  }

  all(): Receipt[] {
    return fs
      .readFileSync(this.file, "utf8")
      .split("\n")
      .filter(Boolean)
      .map((l) => JSON.parse(l));
  }

  head(): string {
    const all = this.all();
    return all.length ? all[all.length - 1].hash : GENESIS;
  }

  append(r: Omit<Receipt, "index" | "prevHash" | "hash" | "createdAt"> & { createdAt?: string }): Receipt {
    const all = this.all();
    const body = {
      ...r,
      createdAt: r.createdAt ?? new Date().toISOString(),
      index: all.length,
      prevHash: all.length ? all[all.length - 1].hash : GENESIS,
    };
    const receipt: Receipt = { ...body, hash: hashJson(body) } as Receipt;
    fs.appendFileSync(this.file, canonicalJson(receipt) + "\n");
    return receipt;
  }

  /** Recomputes every hash and link. Returns the first broken index, or -1 if intact. */
  verify(): number {
    let prev = GENESIS;
    const all = this.all();
    for (let i = 0; i < all.length; i++) {
      const { hash, ...body } = all[i];
      if (body.prevHash !== prev || body.index !== i || hashJson(body) !== hash) return i;
      prev = hash;
    }
    return -1;
  }
}

export function evidencePackHash(items: unknown[]): string {
  return sha256Hex(canonicalJson(items));
}
