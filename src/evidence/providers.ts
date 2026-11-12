import fs from "fs";
import path from "path";
import type { Claim, Desk, EvidenceItem } from "../engine/types";

export interface EvidenceProvider {
  fetch(claim: Claim, desk: Desk): Promise<EvidenceItem[]>;
}

type FixtureCase = { id: string; match: string[]; items: EvidenceItem[] };

/**
 * Declared sample data for non-live desks. Every item is marked synthetic and every
 * response from a fixture desk says so (deskLive=false).
 */
export class FixtureProvider implements EvidenceProvider {
  constructor(private dir = path.join(__dirname, "..", "..", "data", "fixtures")) {}

  async fetch(claim: Claim, desk: Desk): Promise<EvidenceItem[]> {
    const file = path.join(this.dir, `${desk.id}.json`);
    if (!fs.existsSync(file)) return [];
    const cases: FixtureCase[] = JSON.parse(fs.readFileSync(file, "utf8"));
    const lc = claim.text.toLowerCase();
    const hit = cases.find((c) => c.match.some((m) => lc.includes(m.toLowerCase())));
    const now = Date.now();
    return (hit?.items ?? []).map((i) => ({
      ...i,
      publishedAt: relTime(i.publishedAt, now),
      accountCreatedAt: i.accountCreatedAt ? relTime(i.accountCreatedAt, now) : undefined,
      synthetic: true,
    }));
  }
}

/** Fixtures may use relative times like "-3h" or "-400d" so the demo never goes stale. */
export function relTime(v: string, now = Date.now()): string {
  const m = /^-(\d+(?:\.\d+)?)([mhd])$/.exec(v);
  if (!m) return v;
  const mult = { m: 60_000, h: 3_600_000, d: 86_400_000 }[m[2] as "m" | "h" | "d"];
  return new Date(now - Number(m[1]) * mult).toISOString();
}

export type RssItem = { title: string; link: string; pubDate: string; guid?: string };

export function parseRss(xml: string): RssItem[] {
  const out: RssItem[] = [];
  const pick = (block: string, tag: string) => {
    const m = block.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`, "i"));
    return m ? m[1].replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1").trim() : "";
  };
  for (const m of xml.matchAll(/<item\b[^>]*>([\s\S]*?)<\/item>/gi)) {
    const b = m[1];
    out.push({ title: decode(pick(b, "title")), link: pick(b, "link"), pubDate: pick(b, "pubDate"), guid: pick(b, "guid") || undefined });
  }
  return out;
}

function decode(s: string) {
  return s.replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;/g, "'");
}

const EVENT_WORDS = ["cổ tức", "chia", "lợi nhuận", "báo cáo tài chính", "kết quả kinh doanh", "phạt", "xử phạt", "hạn chế", "đình chỉ", "hủy niêm yết", "niêm yết", "bổ nhiệm", "miễn nhiệm", "đại hội", "phát hành", "giao dịch cổ phiếu"];

/**
 * Live desk: HNX disclosure RSS (verified feed on 2026-11-12).
 * The match is deliberately strict: same ticker AND a shared event word. Anything else is neutral,
 * so the engine falls back to MISSING EVIDENCE instead of guessing.
 * Network fetch is cached and bounded per call.
 */
export class HnxRssProvider implements EvidenceProvider {
  static FEEDS = [
    "https://hnx.vn/3/vi_vn/thong-tin-cong-bo-tu-to-chuc-phat-hanh.rss",
    "https://hnx.vn/1/vi_vn/thong-tin-cong-bo-tu-so.rss",
  ];
  private cache = new Map<string, { at: number; items: RssItem[] }>();

  constructor(
    private fetcher: (url: string) => Promise<string> = async (u) => (await fetch(u)).text(),
    private ttlMs = 5 * 60_000,
    private feeds = HnxRssProvider.FEEDS,
  ) {}

  async fetch(claim: Claim, _desk: Desk): Promise<EvidenceItem[]> {
    const tickers = [...new Set(claim.text.match(/\b[A-Z]{3}\b/g) ?? [])];
    if (!tickers.length) return [];
    const lc = claim.text.toLowerCase();
    const events = EVENT_WORDS.filter((w) => lc.includes(w));
    const out: EvidenceItem[] = [];
    for (const feed of this.feeds) {
      let items: RssItem[] = [];
      try {
        items = await this.load(feed);
      } catch {
        continue; // a dead feed yields no evidence, never invented evidence
      }
      for (const it of items) {
        const t = it.title;
        if (!tickers.some((k) => new RegExp(`\\b${k}\\b`).test(t))) continue;
        const shared = events.filter((w) => t.toLowerCase().includes(w));
        out.push({
          id: it.guid || it.link,
          platform: "rss",
          url: it.link,
          publishedAt: new Date(it.pubDate || Date.now()).toISOString(),
          text: t,
          stance: shared.length ? "supports" : "neutral",
        });
      }
    }
    return out.slice(0, 20);
  }

  private async load(url: string): Promise<RssItem[]> {
    const c = this.cache.get(url);
    if (c && Date.now() - c.at < this.ttlMs) return c.items;
    const items = parseRss(await this.fetcher(url));
    this.cache.set(url, { at: Date.now(), items });
    return items;
  }
}

/** Routes each desk to its provider: live desks to live sources, the rest to fixtures. */
export class DeskRouter implements EvidenceProvider {
  constructor(private live: Record<string, EvidenceProvider>, private fallback: EvidenceProvider) {}
  fetch(claim: Claim, desk: Desk) {
    return (desk.live && this.live[desk.id] ? this.live[desk.id] : this.fallback).fetch(claim, desk);
  }
}
