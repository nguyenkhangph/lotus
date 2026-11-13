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

const EVENT_WORDS = ["cổ tức", "chia", "lợi nhuận", "báo cáo tài chính", "kết quả kinh doanh", "phạt", "xử phạt", "hạn chế", "đình chỉ", "hủy niêm yết", "niêm yết", "bổ nhiệm", "miễn nhiệm", "đại hội", "nghị quyết", "phát hành", "trái phiếu", "giao dịch cổ phiếu", "kiểm toán", "nhân sự"];

/** Uppercase 3-letter words that are not tickers. */
const NOT_TICKERS = new Set(["HNX", "HSX", "USD", "VND", "CTCP", "BKS", "CBTT", "UBCK", "SGD", "NHNN", "TTCK", "CEO", "CFO", "HTML", "HTTP", "RSS", "UTF", "XML", "GMT", "ICT", "VSD", "TCT", "MTV", "TNHH", "THE", "AND", "FOR", "PDF", "DOC", "JPG", "PNG", "CSS"]);

/**
 * Minimal HTTP client with a cookie jar. hnx.vn sets a session cookie and redirects ("Object moved")
 * when it is missing; browsers handle that silently, plain fetch does not.
 */
export class CookieClient {
  private jar = new Map<string, string>();
  constructor(private fetchImpl: typeof fetch = fetch, private maxHops = 6) {}

  async get(url: string): Promise<string> {
    let u = url;
    for (let hop = 0; hop < this.maxHops; hop++) {
      const res = await this.fetchImpl(u, {
        redirect: "manual",
        headers: {
          "user-agent": "Mozilla/5.0 (compatible; LotusEvidenceBot/0.1; +https://github.com/nguyenkhangph/lotus)",
          accept: "application/rss+xml, application/xml, text/html;q=0.9, */*;q=0.8",
          ...(this.jar.size ? { cookie: [...this.jar].map(([k, v]) => `${k}=${v}`).join("; ") } : {}),
        },
      });
      const h: any = res.headers;
      const setCookies: string[] = typeof h.getSetCookie === "function" ? h.getSetCookie() : (h.get("set-cookie") ? [h.get("set-cookie")] : []);
      for (const c of setCookies) {
        const [pair] = c.split(";");
        const i = pair.indexOf("=");
        if (i > 0) this.jar.set(pair.slice(0, i).trim(), pair.slice(i + 1).trim());
      }
      const loc = res.headers.get("location");
      if (res.status >= 300 && res.status < 400 && loc) {
        u = new URL(loc, u).toString();
        continue;
      }
      if (!res.ok) throw new Error(`HTTP ${res.status} for ${u}`);
      const body = await res.text();
      // Some servers answer 200 with an "Object moved" page right after setting the cookie: retry once with it.
      if (/<title>\s*Object moved\s*<\/title>/i.test(body) && hop < this.maxHops - 1) continue;
      return body;
    }
    throw new Error(`too many redirects for ${url}`);
  }
}

/** The feed publishes links on an internal port (http://hnx.vn:7978/...); the public page is https://hnx.vn/... */
export function publicHnxUrl(link: string): string {
  try {
    const u = new URL(link);
    if (u.hostname.endsWith("hnx.vn")) {
      u.protocol = "https:";
      u.port = "";
    }
    return u.toString();
  } catch {
    return link;
  }
}

export function htmlToText(html: string): string {
  return html
    .replace(/<(script|style|nav|header|footer|noscript)[\s\S]*?<\/\1>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ")
    .trim();
}

/** Most frequent ticker-looking words in a disclosure page (used by the CLI and for display only). */
export function tickersIn(text: string): string[] {
  const counts = new Map<string, number>();
  for (const m of text.match(/\b[A-Z][A-Z0-9]{2}\b/g) ?? []) {
    if (NOT_TICKERS.has(m)) continue;
    counts.set(m, (counts.get(m) ?? 0) + 1);
  }
  return [...counts].sort((a, b) => b[1] - a[1]).map(([k]) => k);
}

type HnxItem = RssItem & { detail?: string };

/**
 * Live desk: HNX disclosure RSS (needs the session cookie). Feed titles carry no ticker, so for items whose
 * title shares an event word with the claim we open the disclosure page and look for the ticker there.
 * Strict on purpose: no ticker on the page → not counted, and the engine answers MISSING EVIDENCE.
 */
export class HnxRssProvider implements EvidenceProvider {
  static FEEDS = [
    "https://hnx.vn/3/vi_vn/thong-tin-cong-bo-tu-to-chuc-phat-hanh.rss",
    "https://hnx.vn/1/vi_vn/thong-tin-cong-bo-tu-so.rss",
  ];
  private cache = new Map<string, { at: number; items: HnxItem[] }>();
  private details = new Map<string, string>();

  constructor(
    private client: { get(url: string): Promise<string> } = new CookieClient(),
    private ttlMs = 5 * 60_000,
    private feeds = HnxRssProvider.FEEDS,
    private maxDetails = 12,
  ) {}

  async fetch(claim: Claim, _desk: Desk): Promise<EvidenceItem[]> {
    const tickers = [...new Set(claim.text.match(/\b[A-Z][A-Z0-9]{2}\b/g) ?? [])].filter((t) => !NOT_TICKERS.has(t));
    if (!tickers.length) return [];
    const lc = claim.text.toLowerCase();
    const events = EVENT_WORDS.filter((w) => lc.includes(w));

    const all: HnxItem[] = [];
    for (const feed of this.feeds) {
      try {
        all.push(...(await this.load(feed)));
      } catch {
        // a dead feed yields no evidence, never invented evidence
      }
    }
    const hasTicker = (t: string) => tickers.some((k) => new RegExp(`\\b${k}\\b`).test(t));
    const sharedEvents = (t: string) => events.filter((w) => t.toLowerCase().includes(w));

    // Candidates: ticker already in the title, or the title shares an event word with the claim.
    const candidates = all.filter((it) => hasTicker(it.title) || sharedEvents(it.title).length > 0).slice(0, this.maxDetails);
    const out: EvidenceItem[] = [];
    await Promise.all(
      candidates.map(async (it) => {
        let body = it.title;
        if (!hasTicker(it.title)) {
          const text = await this.detail(it.link);
          if (!text || !hasTicker(text)) return;
          body = `${it.title} — ${text.slice(0, 280)}`;
        }
        const shared = sharedEvents(it.title);
        out.push({
          id: it.guid || it.link,
          platform: "rss",
          url: publicHnxUrl(it.link),
          publishedAt: new Date(it.pubDate || Date.now()).toISOString(),
          text: body,
          stance: shared.length ? "supports" : "neutral",
        });
      }),
    );
    return out.slice(0, 20);
  }

  /** Lists recent disclosures with the tickers found on their pages (for picking demo claims). */
  async browse(filter = "", limit = 15): Promise<{ title: string; tickers: string[]; url: string; publishedAt: string }[]> {
    const all: HnxItem[] = [];
    for (const feed of this.feeds) all.push(...(await this.load(feed)));
    const picked = all.filter((it) => it.title.toLowerCase().includes(filter.toLowerCase())).slice(0, limit);
    return Promise.all(
      picked.map(async (it) => ({
        title: it.title.trim(),
        tickers: tickersIn((await this.detail(it.link)) ?? "").slice(0, 3),
        url: publicHnxUrl(it.link),
        publishedAt: it.pubDate,
      })),
    );
  }

  private async detail(link: string): Promise<string | undefined> {
    const url = publicHnxUrl(link);
    if (this.details.has(url)) return this.details.get(url);
    try {
      const text = htmlToText(await this.client.get(url));
      this.details.set(url, text);
      return text;
    } catch {
      return undefined;
    }
  }

  private async load(url: string): Promise<HnxItem[]> {
    const c = this.cache.get(url);
    if (c && Date.now() - c.at < this.ttlMs) return c.items;
    const items = parseRss(await this.client.get(url));
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
