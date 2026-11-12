/**
 * Lotus Telegram bot — the human side of the jar.
 *  /check [desk] <claim>  agent asks Lotus; you get an approval card with ✅ Duyệt / ❌ Từ chối
 *  /status                jar balance, caps left today, lock state
 *  /lock                  kill switch (guardian key): nothing can be paid until the owner unlocks
 *  /pending /desks /help
 * Only TELEGRAM_OWNER_ID may use it. Unanswered cards are declined after the timeout.
 */
import { DESKS } from "../engine/desks";
import type { ApprovalHub } from "../agent/hub";
import type { ApprovalCard, RunRecord } from "../agent/runner";
import type { JarStatus } from "../agent/jar";

export class TelegramApi {
  constructor(private token: string, private fetchImpl: typeof fetch = fetch) {}
  async call<T = any>(method: string, params: Record<string, unknown> = {}): Promise<T> {
    const res = await this.fetchImpl(`https://api.telegram.org/bot${this.token}/${method}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(params),
    });
    const j: any = await res.json();
    if (!j.ok) throw new Error(`telegram ${method}: ${j.description ?? res.status}`);
    return j.result as T;
  }
}

export type BotDeps = {
  tg: Pick<TelegramApi, "call">;
  hub: ApprovalHub;
  ownerId?: string;
  explorer: string; // e.g. https://testnet.snowtrace.io
  startCheck: (claim: string, desk: string) => Promise<RunRecord>;
  jarStatus: () => Promise<JarStatus>;
  lock?: () => Promise<string>;
  dashboardUrl?: string;
};

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const short = (a: string) => (a.length > 14 ? `${a.slice(0, 8)}…${a.slice(-6)}` : a);

const VERDICT_ICON: Record<string, string> = {
  SUPPORTED: "🟢", WEAK: "🟡", CONTESTED: "🟠", CONTRADICTED: "🔴", MISSING_EVIDENCE: "⚪", REFUSE: "⛔",
};

export function parseCheck(text: string): { desk: string; claim: string } | null {
  const rest = text.replace(/^\/check(@\w+)?\s*/i, "").trim();
  if (!rest) return null;
  const [first, ...more] = rest.split(/\s+/);
  if (DESKS[first] && more.length) return { desk: first, claim: more.join(" ") };
  return { desk: guessDesk(rest), claim: rest };
}

/** Light routing when the user does not name a desk. Wrong desk → MISSING EVIDENCE, never a fake answer. */
export function guessDesk(claim: string): string {
  const c = claim.toLowerCase();
  if (/\b[A-Z]{3}\b/.test(claim) && /(cổ tức|niêm yết|hose|hnx|ubck|cổ phiếu|vn-?index)/i.test(claim)) return "vn_stocks";
  if (/(btc|bitcoin|hashrate|etf|on-?chain)/.test(c)) return "btc_ta";
  if (/(gold|vàng|nato|war|chiến tranh|tuyên chiến|article 5|điều 5)/.test(c)) return "gold_war";
  if (/(\bsec\b|nasdaq|nyse|8-k|10-k|form 4|finra)/.test(c)) return "us_stocks";
  return "macro_whitehouse";
}

export class LotusBot {
  private offset = 0;
  private running = false;
  private cardMsg = new Map<string, number>(); // runId → message id
  private announced = new Set<string>();

  constructor(private d: BotDeps) {
    d.hub.on("approval", (card: ApprovalCard) => this.sendCard(card).catch(() => undefined));
    d.hub.on("run", (r: RunRecord) => this.onRun(r).catch(() => undefined));
  }

  // ---------------------------------------------------------------- updates

  async handleUpdate(u: any): Promise<void> {
    if (u.callback_query) return this.onCallback(u.callback_query);
    const m = u.message;
    if (!m?.text) return;
    const chatId = String(m.chat.id);
    const fromId = String(m.from?.id ?? m.chat.id);
    const text: string = m.text.trim();

    if (!this.d.ownerId) {
      await this.say(chatId,
        `🪷 <b>Lotus</b>\nBot chưa có chủ. Chat id của bạn là <code>${esc(fromId)}</code>.\n` +
        `Thêm <code>TELEGRAM_OWNER_ID=${esc(fromId)}</code> vào .env rồi khởi động lại <code>npm run dev</code>.`);
      return;
    }
    if (fromId !== this.d.ownerId) {
      await this.say(chatId, "⛔ Bot này chỉ nhận lệnh từ chủ hũ.");
      return;
    }

    const cmd = text.split(/\s+/)[0].replace(/@\w+$/, "").toLowerCase();
    switch (cmd) {
      case "/start":
      case "/help":
        return this.say(chatId, HELP);
      case "/desks":
        return this.say(chatId, Object.values(DESKS).map((x) => `• <code>${x.id}</code> — ${esc(x.name)}${x.live ? " (LIVE)" : " (fixture)"}`).join("\n"));
      case "/status":
        return this.status(chatId);
      case "/lock":
        return this.lock(chatId);
      case "/pending": {
        const p = this.d.hub.listPending();
        return this.say(chatId, p.length ? p.map((c) => `• ${esc(c.claim)} — ${c.amountHuman} USDC`).join("\n") : "Không có khoản chờ duyệt.");
      }
      case "/check": {
        const parsed = parseCheck(text);
        if (!parsed) return this.say(chatId, "Cách dùng: <code>/check [desk] nhận định</code>\nVí dụ: <code>/check gold_war NATO has invoked Article 5</code>");
        await this.say(chatId, `🔎 Đang hỏi Lotus: <i>${esc(parsed.claim)}</i> [<code>${parsed.desk}</code>]`);
        void this.d.startCheck(parsed.claim, parsed.desk);
        return;
      }
      default:
        if (!text.startsWith("/")) {
          // Plain text = a claim to check.
          await this.say(chatId, `🔎 Đang hỏi Lotus: <i>${esc(text)}</i> [<code>${guessDesk(text)}</code>]`);
          void this.d.startCheck(text, guessDesk(text));
          return;
        }
        return this.say(chatId, HELP);
    }
  }

  private async onCallback(q: any) {
    const fromId = String(q.from?.id);
    const [act, runId] = String(q.data ?? "").split(":");
    if (fromId !== this.d.ownerId) {
      await this.d.tg.call("answerCallbackQuery", { callback_query_id: q.id, text: "Không có quyền." });
      return;
    }
    const ok = this.d.hub.resolve(runId, act === "ap", "telegram");
    await this.d.tg.call("answerCallbackQuery", {
      callback_query_id: q.id,
      text: ok ? (act === "ap" ? "Đã duyệt" : "Đã từ chối") : "Phiếu đã hết hạn hoặc đã xử lý",
    });
    if (ok && q.message) {
      await this.d.tg.call("editMessageReplyMarkup", { chat_id: q.message.chat.id, message_id: q.message.message_id, reply_markup: { inline_keyboard: [] } });
    }
  }

  // ---------------------------------------------------------------- outbound

  private async sendCard(card: ApprovalCard) {
    if (!this.d.ownerId) return;
    const text =
      `🪷 <b>Phiếu duyệt chi</b>\n` +
      `Nhận định: <i>${esc(card.claim)}</i>\n` +
      `Bàn: <code>${card.desk}</code>\n` +
      `Số tiền: <b>${card.amountHuman} test USDC</b> (upto, phần thừa được hoàn)\n` +
      `payTo: <code>${short(card.payTo)}</code>\n` +
      `Token: <code>${short(card.asset)}</code>\n` +
      `requestHash: <code>${short(card.requestHash)}</code>\n` +
      `Còn lại hôm nay: ${card.remainingToday} USDC\n` +
      `Preflight: ${card.reasons.join(", ")}\n\n` +
      `<i>Không duyệt trong 2 phút = tự từ chối.</i>`;
    const msg = await this.d.tg.call("sendMessage", {
      chat_id: this.d.ownerId,
      text,
      parse_mode: "HTML",
      reply_markup: { inline_keyboard: [[{ text: "✅ Duyệt", callback_data: `ap:${card.runId}` }, { text: "❌ Từ chối", callback_data: `rj:${card.runId}` }]] },
    });
    this.cardMsg.set(card.runId, msg.message_id);
  }

  private async onRun(r: RunRecord) {
    if (!this.d.ownerId || !["done", "declined", "blocked", "error"].includes(r.status) || this.announced.has(r.runId)) return;
    this.announced.add(r.runId);
    this.say(this.d.ownerId, formatRun(r, this.d.explorer));
  }

  private async status(chatId: string) {
    try {
      const s = await this.d.jarStatus();
      await this.say(chatId,
        `🫙 <b>Hũ bằng chứng</b> <code>${short(s.address)}</code>\n` +
        `Số dư: <b>${s.balance} USDC</b>\n` +
        `Còn chi được hôm nay: ${s.remainingToday} / ${s.perDay}\n` +
        `Mỗi lệnh tối đa: ${s.perTx} · Đã chi tổng: ${s.spentLifetime} / ${s.lifetime}\n` +
        `Hết hạn: ${new Date(s.expiresAt * 1000).toLocaleString("vi-VN")}\n` +
        `Trạng thái: ${s.locked ? "🔒 ĐÃ KHOÁ" : "🔓 mở"}\n` +
        `<a href="${this.d.explorer}/address/${s.address}">Xem trên Snowtrace</a>` +
        (this.d.dashboardUrl ? ` · <a href="${this.d.dashboardUrl}">Dashboard</a>` : ""));
    } catch (e: any) {
      await this.say(chatId, `Không đọc được hũ: ${esc(e?.shortMessage ?? e?.message ?? String(e))}`);
    }
  }

  private async lock(chatId: string) {
    if (!this.d.lock) return this.say(chatId, "Chưa cấu hình GUARDIAN_PRIVATE_KEY nên bot không khoá được hũ.");
    await this.say(chatId, "🔒 Đang khoá hũ…");
    try {
      const tx = await this.d.lock();
      await this.say(chatId, `🔒 Hũ đã khoá. Không khoản nào chi được cho tới khi chủ hũ mở lại (<code>npm run jar -- unlock</code>).\n<a href="${this.d.explorer}/tx/${tx}">Giao dịch khoá</a>`);
    } catch (e: any) {
      await this.say(chatId, `Khoá thất bại: ${esc(e?.shortMessage ?? e?.message ?? String(e))}`);
    }
  }

  private say(chatId: string, text: string) {
    return this.d.tg.call("sendMessage", { chat_id: chatId, text, parse_mode: "HTML", disable_web_page_preview: true });
  }

  // ---------------------------------------------------------------- polling

  async start() {
    this.running = true;
    await this.d.tg.call("setMyCommands", {
      commands: [
        { command: "check", description: "Chấm một nhận định: /check [desk] nội dung" },
        { command: "status", description: "Số dư và hạn mức của hũ" },
        { command: "lock", description: "Khoá hũ ngay (kill switch)" },
        { command: "pending", description: "Khoản đang chờ duyệt" },
        { command: "desks", description: "Danh sách bàn nguồn" },
        { command: "help", description: "Hướng dẫn" },
      ],
    }).catch(() => undefined);
    while (this.running) {
      try {
        const updates: any[] = await this.d.tg.call("getUpdates", { offset: this.offset, timeout: 25, allowed_updates: ["message", "callback_query"] });
        for (const u of updates) {
          this.offset = u.update_id + 1;
          await this.handleUpdate(u).catch((e) => console.error("[bot]", e?.message ?? e));
        }
      } catch (e: any) {
        console.error("[bot] poll:", e?.message ?? e);
        await new Promise((r) => setTimeout(r, 3000));
      }
    }
  }

  stop() {
    this.running = false;
  }
}

export function formatRun(r: RunRecord, explorer: string): string {
  const head = `<i>${esc(r.claim)}</i> [<code>${r.desk}</code>]`;
  if (r.status === "declined") return `❌ Không duyệt (${r.approvedBy}). Không trả tiền.\n${head}`;
  if (r.status === "blocked") return `🛑 Preflight chặn, không trả tiền: ${(r.preflightReasons ?? []).join(", ")}\n${head}`;
  if (r.status === "error") return `⚠️ Lỗi: ${esc(r.error ?? "")}\n${head}`;
  const x = r.result ?? {};
  const icon = VERDICT_ICON[x.verdict] ?? "•";
  const lines = [
    `${icon} <b>${x.verdict}</b> · điểm ${x.score}/100`,
    head,
    `Nguồn độc lập ủng hộ: ${x.independentSupport} · phản bác: ${x.independentContra}`,
    `Chỉ số buồng vang: ${x.echoIndex}`,
    `Mã lý do: <code>${(x.reasonCodes ?? []).join(", ")}</code>`,
  ];
  if (x.deskLive === false) lines.push("<i>Bàn này dùng dữ liệu mẫu (SYNTHETIC).</i>");
  const links = [];
  if (r.payTx) links.push(`<a href="${explorer}/tx/${r.payTx}">Thanh toán</a>`);
  if (x.receipt?.anchorTx) links.push(`<a href="${explorer}/tx/${x.receipt.anchorTx}">Biên nhận on-chain</a>`);
  if (x.receipt?.refundTx) links.push(`<a href="${explorer}/tx/${x.receipt.refundTx}">Hoàn ${Number(x.receipt.pricing.refundDue) / 1e6} USDC</a>`);
  if (links.length) lines.push(links.join(" · "));
  lines.push(`<i>${esc(x.disclaimer ?? "")}</i>`);
  return lines.join("\n");
}

const HELP =
  `🪷 <b>Lotus</b> — chấm bằng chứng cho tin thị trường, trả phí x402 trên Avalanche Fuji.\n\n` +
  `• Gõ thẳng một nhận định, hoặc <code>/check [desk] nội dung</code>\n` +
  `• Mỗi khoản chi cần bạn bấm ✅ Duyệt\n` +
  `• <code>/status</code> số dư và hạn mức · <code>/lock</code> khoá hũ ngay\n` +
  `• <code>/desks</code> danh sách bàn nguồn\n\n` +
  `<i>Lotus không tư vấn đầu tư, không giá mục tiêu, không dự báo. Chỉ testnet.</i>`;
