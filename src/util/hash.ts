import { createHash } from "crypto";
import { keccak256, toUtf8Bytes } from "ethers";

/** Deterministic JSON: sorted keys, no whitespace. Same input → same hash on every machine. */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortDeep(value));
}

function sortDeep(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(sortDeep);
  if (v && typeof v === "object") {
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(v as Record<string, unknown>).sort()) {
      const x = (v as Record<string, unknown>)[k];
      if (x !== undefined) out[k] = sortDeep(x);
    }
    return out;
  }
  return v;
}

export function sha256Hex(data: string): string {
  return "0x" + createHash("sha256").update(data).digest("hex");
}

export function hashJson(value: unknown): string {
  return sha256Hex(canonicalJson(value));
}

/**
 * The request hash binds a payment to one exact request: method, route and body.
 * keccak256 so it fits the bytes32 `requestHash` field the LotusJar signs over.
 */
export function requestHash(method: string, route: string, body: unknown): `0x${string}` {
  return keccak256(toUtf8Bytes(`${method.toUpperCase()} ${route}\n${canonicalJson(body ?? {})}`)) as `0x${string}`;
}
