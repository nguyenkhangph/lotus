export type SourceType = "primary" | "outlet" | "analyst";

/** One allowlisted source on a desk. Matched by exact handle/domain, never by display name. */
export type AllowedSource = {
  id: string;
  name: string;
  org: string; // independence unit: same org = one unit
  type: SourceType;
  handles?: string[]; // e.g. "x:@federalreserve", "fb:HochiminhStockExchange"
  domains?: string[]; // e.g. "federalreserve.gov"
};

/** An official body a claim can be attributed to ("the Fed said…"). */
export type OfficialBody = {
  id: string;
  patterns: string[]; // case-insensitive substrings/regex sources found in the claim
  sources: string[]; // AllowedSource ids that may confirm it
};

export type Desk = {
  id: string;
  name: string;
  live: boolean; // false = fixture desk (declared sample data)
  sources: AllowedSource[];
  officialBodies: OfficialBody[];
  staleAfterHours: number;
};

export type Measurement = { metric: string; value: number; unit: string };

/** A piece of retrieved evidence. Always untrusted data, never instructions. */
export type EvidenceItem = {
  id: string;
  platform: "x" | "fb" | "web" | "rss" | "image";
  handle?: string; // "@glassnode" for x, page slug for fb
  displayName?: string;
  url?: string;
  publishedAt: string; // ISO
  text: string;
  stance: "supports" | "contradicts" | "neutral";
  imageHash?: string;
  repostOf?: string; // id of the original item
  accountCreatedAt?: string;
  followers?: number;
  likes?: number;
  reposts?: number;
  measurement?: Measurement;
  synthetic?: boolean;
};

export type Claim = {
  text: string;
  desk: string;
  asOf?: string; // ISO; defaults to now
};

export type ReasonCode =
  | "OK"
  | "MISSING_PRIMARY"
  | "NO_EVIDENCE"
  | "TRADE_REQUEST"
  | "SHILL_LANGUAGE"
  | "PROMPT_INJECTION"
  | "IMPERSONATION"
  | "NOT_ALLOWLISTED"
  | "NEW_ACCOUNT"
  | "ENGAGEMENT_ANOMALY"
  | "ECHO_DUPLICATE"
  | "STALE"
  | "SCREENSHOT_ONLY"
  | "CONTRADICTION"
  | "UNIT_MISMATCH"
  | "FLOOD";

export type Verdict = "SUPPORTED" | "CONTRADICTED" | "CONTESTED" | "WEAK" | "MISSING_EVIDENCE" | "REFUSE";

export type ItemFinding = {
  itemId: string;
  sourceId?: string;
  org?: string;
  type?: SourceType;
  counted: boolean;
  unit?: string; // independence unit key
  flags: ReasonCode[];
};

export type ScoreResult = {
  claim: string;
  desk: string;
  deskLive: boolean;
  verdict: Verdict;
  score: number; // 0..100 evidence strength for the claim as stated
  independentSupport: number;
  independentContra: number;
  itemsSeen: number;
  echoIndex: number; // 0 = all independent, →1 = all echoes
  reasonCodes: ReasonCode[];
  findings: ItemFinding[];
  debate: {
    bull: { units: string[]; citations: string[] };
    bear: { units: string[]; citations: string[]; gaps: ReasonCode[] };
    skeptic: { verdict: Verdict; rules: string[] };
  };
  disclaimer: string;
};
