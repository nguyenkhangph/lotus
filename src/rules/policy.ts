/**
 * Spending rules in plain Vietnamese (or English) → LotusJar parameters, with a dry-run simulation before anything is signed.
 * Messages come back in the requested language ("vi" by default, "en" for the English site).
 *
 * The parser is deterministic on purpose: every clause is either mapped to a contract field (and shown
 * to the owner as such) or reported as "not understood" and ignored. Nothing is guessed. The owner then
 * signs the resulting setCaps / setTiming / setPayTo calls with their own key; the bot never can.
 */
import { Interface, getAddress, isAddress, parseUnits } from "ethers";
import { foldDiacritics } from "../engine/patterns";

const DEC = 6;
export const usd = (n: number | string) => parseUnits(String(n), DEC);
export const fmtUsd = (x: bigint) => {
  const s = (Number(x) / 10 ** DEC).toFixed(6).replace(/\.?0+$/, "");
  return s === "" ? "0" : s;
};

/** What the jar enforces, in contract units (USDC 6 decimals, seconds). */
export type Policy = {
  perTx: bigint;
  perDay: bigint;
  lifetime: bigint;
  delay: number;
  expiresAt: number;
  burstWindow: number;
  burstMax: number;
  /** Payees the owner wants allowed (true) or blocked (false). Unlisted payees keep their on-chain state. */
  payees: Record<string, boolean>;
};

/** Live jar state the simulation starts from. */
export type JarState = { spentToday: bigint; spentLifetime: bigint; locked: boolean; now: number };

export type Lang = "vi" | "en";
const pick = (lang: Lang) => (en: string, vi: string) => (lang === "en" ? en : vi);

export type Understood = { clause: string; field: string; text: string };
export type ParseResult = {
  policy: Policy;
  understood: Understood[];
  unknown: { clause: string; why: string }[];
  warnings: string[];
};

const UNIT_SEC: Record<string, number> = {
  giay: 1, s: 1, phut: 60, p: 60, gio: 3600, h: 3600, ngay: 86400, tuan: 7 * 86400, thang: 30 * 86400,
  second: 1, seconds: 1, sec: 1, secs: 1, minute: 60, minutes: 60, min: 60, mins: 60, hour: 3600, hours: 3600,
  day: 86400, days: 86400, week: 7 * 86400, weeks: 7 * 86400, month: 30 * 86400, months: 30 * 86400,
};
const EN_COUNT = "requests?|payments?|calls?|transactions?|spends?|times";
const EN_UNIT = "seconds?|secs?|minutes?|mins?|hours?";
const NUM = String.raw`(\d+(?:_\d+)?)`;
const num = (s: string) => Number(s.replace("_", "."));
const words: Record<string, string> = { mot: "1", hai: "2", ba: "3", bon: "4", nam: "5", muoi: "10", nua: "0_5" };

function clauses(text: string): { raw: string; c: string }[] {
  // Keep decimals ("0,5" / "0.5") intact while splitting on punctuation and "và".
  const protectedText = text.replace(/(\d)[.,](\d)/g, "$1_$2");
  return protectedText
    .split(/[.;\n]|,(?!\d)|\s+và\s+|\s+va\s+|\s+and\s+/i)
    .map((raw) => raw.trim())
    .filter((raw) => raw.length > 1)
    .map((raw) => {
      let c = foldDiacritics(raw).toLowerCase().replace(/\s+/g, " ");
      for (const [w, d] of Object.entries(words)) c = c.replace(new RegExp(`\\b${w}\\b(?= (lan|ngay|phut|gio|giay|tuan|thang|khoan|lenh|usdc))`, "g"), d);
      return { raw: raw.replace(/(\d)_(\d)/g, "$1,$2"), c };
    });
}

/** First amount in the clause after removing the period words ("mỗi ngày", "1 lần"…). */
function amountIn(c: string): number | undefined {
  const stripped = c.replace(/\b(moi|1|mot|hang) (lan|ngay|giao dich|khoan|lenh|tuan|thang)\b/g, " ").replace(/\b(per|a|an|each|every|1) (day|week|month|payment|call|request|transaction|spend|tx)\b/g, " ");
  // A number followed by a count word ("3 lần", "3 requests") is a count, not money.
  const m = stripped.match(new RegExp(`${NUM}(?! ?(?:lan|lenh|khoan|giao dich|yeu cau|${EN_COUNT})\\b)(?!\\d)\\s*(usdc|usd|\\$|do)?`));
  return m ? num(m[1]) : undefined;
}

export function parseRules(text: string, base: Policy, opts: { now: number; treasury: string; lang?: Lang }): ParseResult {
  const lang: Lang = opts.lang ?? "vi";
  const M = pick(lang);
  const amt = (a: number) => (lang === "en" ? String(a) : vn(a));
  const human = (sec: number) => humanT(sec, lang);
  const dateStr = (t: number) => new Date(t * 1000).toLocaleDateString(lang === "en" ? "en-GB" : "vi-VN");
  const policy: Policy = { ...base, payees: { ...base.payees } };
  const understood: Understood[] = [];
  const unknown: ParseResult["unknown"] = [];
  const warnings: string[] = [];
  const say = (clause: string, field: string, t: string) => understood.push({ clause, field, text: t });

  for (const { raw, c } of clauses(text)) {
    const addrs = (raw.match(/0x[0-9a-fA-F]{40}/g) ?? []).filter((a) => isAddress(a)).map((a) => getAddress(a));

    // Burst guard: "quá 5 lệnh trong 1 phút thì khoá", "tối đa 10 lần mỗi giờ".
    let m =
      c.match(new RegExp(`(?:qua|hon|vuot qua|vuot) ${NUM} ?(?:lenh|lan|khoan|giao dich|yeu cau)[^\\d]*?(?:trong|moi) ?(\\d+)? ?(giay|phut|gio)`)) ??
      c.match(new RegExp(`(?:toi da|khong qua|chi) ${NUM} ?(?:lenh|lan|khoan|giao dich|yeu cau) ?(?:moi|trong|\\/|mot|1)? ?(\\d+)? ?(giay|phut|gio)`)) ??
      c.match(new RegExp(`(?:more than|over|above|exceeds?) ${NUM} ?(?:${EN_COUNT})[^\\d]*?(?:in|within|per|a|an|each) ?(\\d+)? ?(${EN_UNIT})\\b`)) ??
      c.match(new RegExp(`(?:max|maximum|at most|no more than|up to) ${NUM} ?(?:${EN_COUNT}) ?(?:per|in|within|a|an|each|\\/)? ?(\\d+)? ?(${EN_UNIT})\\b`));
    if (m) {
      const n = Math.floor(num(m[1]));
      const win = (m[2] ? Number(m[2]) : 1) * UNIT_SEC[m[3]];
      if (n < 1 || win < 1 || win > 86400) { unknown.push({ clause: raw, why: M("Invalid count or window (at most 1 day).", "Số lệnh hoặc khoảng thời gian không hợp lệ (tối đa 1 ngày).") }); continue; }
      policy.burstMax = n; policy.burstWindow = win;
      say(raw, "burst", M(`More than ${n} requests in ${human(win)} locks the jar`, `Quá ${n} lệnh trong ${human(win)} thì hũ tự khoá`));
      continue;
    }

    // Unsupported periods: say so instead of approximating.
    if ((/\b(moi|1|mot|hang) (tuan|thang|nam)\b/.test(c) || /\b(per|a|each|every) (week|month|year)\b|\b(weekly|monthly|yearly)\b/.test(c)) && amountIn(c) !== undefined) {
      unknown.push({ clause: raw, why: M("The contract only has per-payment, per-day and lifetime caps; no weekly/monthly/yearly cap yet.", "Hợp đồng chỉ có hạn mức theo lần, theo ngày và tổng; chưa có theo tuần/tháng/năm.") });
      continue;
    }

    // Daily cap.
    if (/\b(moi|1|mot|hang) ngay\b|\bhang ngay\b|\b(per|a|each|every) day\b|\bdaily\b/.test(c) && !/het han|han dung|expir/.test(c)) {
      if (new RegExp(`\\d+ ?(lan|lenh|khoan|giao dich|${EN_COUNT})\\b`).test(c) && amountIn(c) === undefined) {
        unknown.push({ clause: raw, why: M("The contract does not count requests per day. Use \"lock if more than N requests in X minutes\", or a daily money cap.", "Hợp đồng chưa đếm số lần theo ngày. Dùng \"quá N lệnh trong X phút thì khoá\", hoặc hạn mức tiền mỗi ngày.") });
        continue;
      }
      const a = amountIn(c);
      if (a === undefined || a <= 0) { unknown.push({ clause: raw, why: M("No amount found.", "Không thấy số tiền.") }); continue; }
      policy.perDay = usd(a); say(raw, "perDay", M(`At most ${amt(a)} USDC per day`, `Mỗi ngày tối đa ${amt(a)} USDC`)); continue;
    }

    // Per-transaction cap.
    if (/\b(moi|1|mot) (lan|giao dich|khoan|lenh)\b|\b(per|each|every|a) (tx|transaction|payment|call|request|spend)\b/.test(c)) {
      const a = amountIn(c);
      if (a === undefined || a <= 0) { unknown.push({ clause: raw, why: M("No amount found.", "Không thấy số tiền.") }); continue; }
      policy.perTx = usd(a); say(raw, "perTx", M(`At most ${amt(a)} USDC per payment`, `Mỗi lần tối đa ${amt(a)} USDC`)); continue;
    }

    // Lifetime cap.
    if (/\b(tong|tron doi|toan bo|ca doi|lifetime|total|overall|in all)\b/.test(c)) {
      const a = amountIn(c);
      if (a === undefined || a <= 0) { unknown.push({ clause: raw, why: M("No amount found.", "Không thấy số tiền.") }); continue; }
      policy.lifetime = usd(a); say(raw, "lifetime", M(`At most ${amt(a)} USDC in total`, `Tổng cộng tối đa ${amt(a)} USDC`)); continue;
    }

    // Expiry: "hết hạn sau 30 ngày", "dùng đến 31/12/2026".
    m = c.match(new RegExp(`(?:het han|han dung|hieu luc|dung)[^\\d]*?(?:sau|trong)? ?${NUM} ?(ngay|tuan|thang)`)) ??
      c.match(new RegExp(`(?:expires?|expiry|valid|good)[^\\d]*?(?:in|after|for)? ?${NUM} ?(days?|weeks?|months?)\\b`));
    if (m) {
      const sec = Math.round(num(m[1]) * UNIT_SEC[m[2]]);
      if (sec < 3600 || sec > 365 * 86400) { unknown.push({ clause: raw, why: M("Expiry must be between 1 hour and 1 year.", "Hạn dùng phải từ 1 giờ đến 1 năm.") }); continue; }
      policy.expiresAt = opts.now + sec; say(raw, "expiresAt", M(`Expires in ${human(sec)} (${dateStr(policy.expiresAt)})`, `Hết hạn sau ${human(sec)} (${dateStr(policy.expiresAt)})`)); continue;
    }
    m = c.match(/(?:den|toi|het han|han)[^\d]*?ngay (\d{1,2})\/(\d{1,2})(?:\/(\d{4}))?/);
    if (m) {
      const y = m[3] ? Number(m[3]) : new Date(opts.now * 1000).getUTCFullYear();
      const t = Math.floor(Date.UTC(y, Number(m[2]) - 1, Number(m[1]), 16, 59, 59) / 1000); // 23:59:59 Asia/Saigon
      if (!(t > opts.now + 3600 && t < opts.now + 366 * 86400)) { unknown.push({ clause: raw, why: M("The expiry date must be within the next year.", "Ngày hết hạn phải nằm trong 1 năm tới.") }); continue; }
      policy.expiresAt = t; say(raw, "expiresAt", M(`Expires at 23:59 (Vietnam time) on ${m[1]}/${m[2]}/${y}`, `Hết hạn lúc 23:59 ngày ${m[1]}/${m[2]}/${y}`)); continue;
    }

    // Delay / cancel window: "chờ 2 phút rồi mới chi", "không chờ".
    if (/\bkhong (cho|tri hoan)\b|\bchi ngay\b|\bno delay\b|\bpay (immediately|at once|right away)\b/.test(c)) { policy.delay = 0; say(raw, "delay", M("Pay immediately, no cancel window", "Chi ngay, không có thời gian chờ huỷ")); continue; }
    m = c.match(new RegExp(`(?:cho|tri hoan|doi|delay)[^\\d]*?${NUM} ?(giay|phut|gio)`)) ??
      c.match(new RegExp(`(?:wait|delay|hold)[^\\d]*?${NUM} ?(${EN_UNIT})\\b`));
    if (m) {
      const sec = Math.round(num(m[1]) * UNIT_SEC[m[2]]);
      if (sec > 86400) { unknown.push({ clause: raw, why: M("The delay can be at most 1 day.", "Thời gian chờ tối đa 1 ngày.") }); continue; }
      policy.delay = sec; say(raw, "delay", M(`Each payment waits ${human(sec)} before it executes; the owner or guardian can cancel meanwhile`, `Mỗi khoản chờ ${human(sec)} trước khi chi; chủ hoặc người bảo vệ huỷ được trong lúc chờ`)); continue;
    }

    // Block a payee.
    if (/\b(chan|cam|khong (tra|chi|chuyen) cho|block|deny|ban|never pay)\b/.test(c)) {
      if (!addrs.length) { unknown.push({ clause: raw, why: M("Give a 0x… wallet address to block.", "Cần địa chỉ ví 0x… để chặn.") }); continue; }
      for (const a of addrs) policy.payees[a] = false;
      say(raw, "payees", M(`Block ${addrs.map(short).join(", ")}`, `Chặn ${addrs.map(short).join(", ")}`)); continue;
    }

    // Allow payees: "chỉ trả cho Lotus", "cho phép trả cho 0x…".
    if (/\b(chi|cho phep|duoc) (tra|chi|chuyen|thanh toan) (cho|toi|den|vao)\b|\bonly (pay|send|transfer)\b|\b(allow|permit) (paying|payments to|pay)\b/.test(c)) {
      const list = [...addrs];
      if (/\blotus\b/.test(c)) list.push(getAddress(opts.treasury));
      if (!list.length) { unknown.push({ clause: raw, why: M("No payee found: write \"Lotus\" or a 0x… address.", "Không thấy người nhận: ghi \"Lotus\" hoặc địa chỉ 0x…") }); continue; }
      for (const a of list) policy.payees[a] = true;
      const only = /\bchi (tra|chi|chuyen|thanh toan)\b|\bonly\b/.test(c);
      const who = list.map((a) => (a === getAddress(opts.treasury) ? `Lotus (${short(a)})` : short(a))).join(", ");
      say(raw, "payees", only ? M(`Only pay ${who}`, `Chỉ trả cho ${who}`) : M(`Allow paying ${who}`, `Cho phép trả cho ${who}`));
      if (only) warnings.push(M("The contract cannot list its whole current whitelist. To drop an old payee, add \"block 0x…\" for each one.", "Hợp đồng không liệt kê được toàn bộ whitelist hiện có. Muốn bỏ người nhận cũ thì thêm câu \"chặn 0x…\" cho từng ví."));
      continue;
    }

    unknown.push({ clause: raw, why: M("Not understood, so not applied.", "Chưa hiểu câu này, nên không áp dụng.") });
  }

  if (policy.perTx > policy.perDay) warnings.push(M("The per-payment cap is above the daily cap: in practice one payment can only reach the daily cap.", "Hạn mức mỗi lần lớn hơn mỗi ngày: thực tế mỗi lần chỉ chi được tới hạn mức ngày."));
  if (policy.perDay > policy.lifetime) warnings.push(M("The daily cap is above the lifetime cap: the lifetime cap will bind first.", "Hạn mức mỗi ngày lớn hơn tổng: tổng sẽ chặn trước."));
  if (policy.perTx > usd(5)) warnings.push(M("Over 5 USDC per payment is a lot for an agent paying API fees.", "Mỗi lần trên 5 USDC là khá lớn cho một agent trả phí API."));
  if (policy.burstMax === 0) warnings.push(M("Burst auto-lock is off.", "Chưa bật tự khoá khi có lệnh dồn dập."));
  if (policy.expiresAt <= opts.now) warnings.push(M("The jar has expired: every payment is refused until it is extended.", "Hũ đã hết hạn: mọi khoản chi sẽ bị từ chối cho tới khi gia hạn."));
  return { policy, understood, unknown, warnings };
}

function humanT(sec: number, lang: Lang): string {
  const u = (n: number, en: string, vi: string) => (lang === "en" ? `${n} ${en}${n === 1 ? "" : "s"}` : `${n} ${vi}`);
  if (sec % 86400 === 0) return u(sec / 86400, "day", "ngày");
  if (sec % 3600 === 0) return u(sec / 3600, "hour", "giờ");
  if (sec % 60 === 0) return u(sec / 60, "minute", "phút");
  return u(sec, "second", "giây");
}
const vn = (n: number) => String(n).replace(".", ",");
const short = (a: string) => `${a.slice(0, 6)}…${a.slice(-4)}`;

// ------------------------------------------------------------------ simulation

export type SimSpend = { at: number; amount: bigint; payTo: string };
export type SimStep = { at: number; amount: string; payTo: string; ok: boolean; code: string; note: string };
export type Scenario = { id: string; title: string; spends: SimSpend[] };

const NOTE: Record<string, [string, string]> = {
  OK: ["Paid", "Được chi"],
  QUEUED: ["Queued: paid after the delay unless the owner or guardian cancels", "Vào hàng chờ: chi sau thời gian chờ nếu chủ hoặc người bảo vệ không huỷ"],
  JarLocked: ["Jar is locked", "Hũ đang khoá"],
  JarExpired: ["Jar has expired", "Hũ đã hết hạn"],
  PayToNotAllowed: ["Payee is not whitelisted", "Người nhận không có trong whitelist"],
  ZeroAmount: ["Zero amount", "Số tiền bằng 0"],
  PerTxCapExceeded: ["Over the per-payment cap", "Vượt hạn mức mỗi lần"],
  DailyCapExceeded: ["Over the daily cap", "Vượt hạn mức trong ngày"],
  LifetimeCapExceeded: ["Over the lifetime cap", "Vượt hạn mức tổng"],
  BURST_LOCK: ["Burst of requests: the jar locks itself, this payment is not made", "Quá nhiều lệnh dồn dập: hũ tự khoá, khoản này không được chi"],
};

/**
 * Replays LotusJar.request() checks in the contract's order (lock, expiry, payee, amount, per-tx,
 * per-day, lifetime, burst). test/rules-sim.test.ts runs the same scenarios on the real contract.
 */
export function simulate(policy: Policy, start: JarState, spends: SimSpend[], payeeAllowed: (a: string) => boolean, lang: Lang = "vi"): SimStep[] {
  let { spentToday, spentLifetime, locked } = start;
  let day = Math.floor(start.now / 86400);
  let windowStart = 0, windowCount = 0;
  const out: SimStep[] = [];
  for (const s of spends) {
    const step = (code: string) => out.push({ at: s.at, amount: fmtUsd(s.amount), payTo: s.payTo, ok: code === "OK", code, note: code === "OK" && policy.delay > 0 ? NOTE.QUEUED[lang === "en" ? 0 : 1] : NOTE[code] ? NOTE[code][lang === "en" ? 0 : 1] : code });
    if (locked) { step("JarLocked"); continue; }
    if (s.at > policy.expiresAt) { step("JarExpired"); continue; }
    const d = Math.floor(s.at / 86400);
    if (d !== day) { day = d; spentToday = 0n; }
    const allowed = s.payTo in policy.payees ? policy.payees[s.payTo] : payeeAllowed(s.payTo);
    if (!allowed) { step("PayToNotAllowed"); continue; }
    if (s.amount === 0n) { step("ZeroAmount"); continue; }
    if (s.amount > policy.perTx) { step("PerTxCapExceeded"); continue; }
    if (spentToday + s.amount > policy.perDay) { step("DailyCapExceeded"); continue; }
    if (spentLifetime + s.amount > policy.lifetime) { step("LifetimeCapExceeded"); continue; }
    if (policy.burstMax > 0) {
      if (s.at > windowStart + policy.burstWindow) { windowStart = s.at; windowCount = 0; }
      windowCount += 1;
      if (windowCount > policy.burstMax) { locked = true; step("BURST_LOCK"); continue; }
    }
    spentToday += s.amount; spentLifetime += s.amount;
    step("OK");
  }
  return out;
}

/** Fixed attack and usage scenarios, the same for "current rules" and "new rules" so they compare. */
export function defaultScenarios(now: number, treasury: string, policy: Policy, lang: Lang = "vi"): Scenario[] {
  const M = pick(lang);
  const T = getAddress(treasury);
  const stranger = "0xBADBADBADBADBADBADBADBADBADBADBADBADBAD0";
  const tenMin = (n: number, a: bigint) => Array.from({ length: n }, (_, i) => ({ at: now + 60 + i * 600, amount: a, payTo: T }));
  return [
    { id: "normal", title: M("Normal Lotus fee (0.45 USDC)", "Trả phí Lotus bình thường (0,45 USDC)"), spends: [{ at: now + 60, amount: usd(0.45), payTo: T }] },
    { id: "overpay", title: M("Agent tricked into paying 2 USDC for one question", "Agent bị dụ trả 2 USDC cho một câu hỏi"), spends: [{ at: now + 60, amount: usd(2), payTo: T }] },
    { id: "stranger", title: M("Agent tricked into sending 0.3 USDC to a stranger", "Agent bị dụ chuyển 0,3 USDC cho ví lạ"), spends: [{ at: now + 60, amount: usd(0.3), payTo: getAddress(stranger.toLowerCase()) }] },
    { id: "burst", title: M("Prompt injection makes the agent send 12 × 0.05 USDC in 1 minute", "Prompt injection bắt agent gửi 12 lệnh 0,05 USDC trong 1 phút"), spends: Array.from({ length: 12 }, (_, i) => ({ at: now + 60 + i * 4, amount: usd(0.05), payTo: T })) },
    { id: "drain", title: M("0.45 USDC every 10 minutes for 3 hours (18 calls)", "Gọi 0,45 USDC mỗi 10 phút suốt 3 tiếng (18 lần)"), spends: tenMin(18, usd(0.45)) },
    { id: "expired", title: M("A 0.1 USDC payment after the jar expires", "Một khoản 0,1 USDC sau khi hũ hết hạn"), spends: [{ at: Math.max(policy.expiresAt, now) + 3600, amount: usd(0.1), payTo: T }] },
  ];
}

export type ScenarioResult = { id: string; title: string; current: Summary; proposed: Summary };
export type Summary = { paid: number; blocked: number; spent: string; first: string; steps: SimStep[] };

function summarize(steps: SimStep[], lang: Lang): Summary {
  const paid = steps.filter((s) => s.ok);
  const firstBlock = steps.find((s) => !s.ok) ?? steps.find((s) => s.note !== NOTE.OK[0] && s.note !== NOTE.OK[1]);
  const spent = paid.reduce((a, s) => a + usd(s.amount), 0n);
  return { paid: paid.length, blocked: steps.length - paid.length, spent: fmtUsd(spent), first: firstBlock ? firstBlock.note : lang === "en" ? "All paid" : "Tất cả được chi", steps };
}

export function compare(current: Policy, proposed: Policy, start: JarState, treasury: string, payeeAllowed: (a: string) => boolean, lang: Lang = "vi"): ScenarioResult[] {
  // Scenario timing uses the later expiry so the "after expiry" case is meaningful for both.
  const sc = defaultScenarios(start.now, treasury, proposed.expiresAt >= current.expiresAt ? proposed : current, lang);
  return sc.map((s) => ({
    id: s.id,
    title: s.title,
    current: summarize(simulate(current, start, s.spends, payeeAllowed, lang), lang),
    proposed: summarize(simulate(proposed, start, s.spends, payeeAllowed, lang), lang),
  }));
}

// ------------------------------------------------------------------ owner transactions

export const OWNER_ABI = [
  "function setCaps((uint256 perTx,uint256 perDay,uint256 lifetime) c)",
  "function setTiming(uint64 delay_, uint64 expiresAt_, uint32 burstWindow_, uint32 burstMax_)",
  "function setPayTo(address payTo, bool allowed)",
];
const iface = new Interface(OWNER_ABI);

export type OwnerCall = { fn: string; args: string; data: string; why: string };

/** Only the calls that change something. The owner signs them; nothing here holds a key. */
export function ownerCalls(current: Policy, proposed: Policy, payeeAllowed: (a: string) => boolean, lang: Lang = "vi"): OwnerCall[] {
  const M = pick(lang);
  const calls: OwnerCall[] = [];
  if (proposed.perTx !== current.perTx || proposed.perDay !== current.perDay || proposed.lifetime !== current.lifetime) {
    calls.push({
      fn: "setCaps",
      args: `${fmtUsd(proposed.perTx)} / ${fmtUsd(proposed.perDay)} / ${fmtUsd(proposed.lifetime)} USDC`,
      data: iface.encodeFunctionData("setCaps", [{ perTx: proposed.perTx, perDay: proposed.perDay, lifetime: proposed.lifetime }]),
      why: M("Per-payment / daily / lifetime caps", "Hạn mức mỗi lần / mỗi ngày / tổng"),
    });
  }
  if (proposed.delay !== current.delay || proposed.expiresAt !== current.expiresAt || proposed.burstWindow !== current.burstWindow || proposed.burstMax !== current.burstMax) {
    calls.push({
      fn: "setTiming",
      args: `delay ${proposed.delay}s · ${M("expires", "hết hạn")} ${new Date(proposed.expiresAt * 1000).toISOString().slice(0, 16)}Z · ${proposed.burstMax} ${M("requests", "lệnh")}/${proposed.burstWindow}s`,
      data: iface.encodeFunctionData("setTiming", [proposed.delay, proposed.expiresAt, proposed.burstWindow, proposed.burstMax]),
      why: M("Delay, expiry, burst auto-lock", "Thời gian chờ, hạn dùng, tự khoá khi dồn dập"),
    });
  }
  for (const [a, allowed] of Object.entries(proposed.payees)) {
    if (payeeAllowed(a) === allowed) continue;
    calls.push({ fn: "setPayTo", args: `${a} ${allowed}`, data: iface.encodeFunctionData("setPayTo", [a, allowed]), why: allowed ? M("Allow payee", "Thêm người nhận") : M("Block payee", "Chặn người nhận") });
  }
  return calls;
}

export const RULE_EXAMPLES = [
  "Mỗi lần tối đa 0,5 USDC. Mỗi ngày không quá 3 USDC. Tổng cộng 100 USDC. Chỉ trả cho Lotus. Quá 5 lệnh trong 1 phút thì khoá hũ. Hết hạn sau 30 ngày.",
  "Mỗi lần không quá 0,2 USDC, chờ 2 phút rồi mới chi",
  "Mỗi tuần tối đa 10 USDC",
];
