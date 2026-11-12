import { EventEmitter } from "events";
import type { Approval, ApprovalCard, RunRecord } from "./runner";

/**
 * Pending approvals + recent runs, shared by the Telegram bot and the dashboard.
 * Fails closed: a card nobody answers is declined when it times out.
 */
export class ApprovalHub extends EventEmitter {
  private pending = new Map<string, { card: ApprovalCard; resolve: (a: Approval) => void; timer: NodeJS.Timeout }>();
  private runs: RunRecord[] = [];

  constructor(private timeoutMs = 120_000, private maxRuns = 50) {
    super();
  }

  request(card: ApprovalCard): Promise<Approval> {
    return new Promise((resolve) => {
      const timer = setTimeout(() => this.resolve(card.runId, false, "timeout"), this.timeoutMs);
      this.pending.set(card.runId, { card, resolve, timer });
      this.emit("approval", card);
    });
  }

  /** Returns false when the card is unknown or already answered (double taps are ignored). */
  resolve(runId: string, approved: boolean, by: string): boolean {
    const p = this.pending.get(runId);
    if (!p) return false;
    clearTimeout(p.timer);
    this.pending.delete(runId);
    p.resolve({ approved, by });
    this.emit("resolved", { runId, approved, by });
    return true;
  }

  listPending(): ApprovalCard[] {
    return [...this.pending.values()].map((p) => p.card);
  }

  record(r: RunRecord) {
    const i = this.runs.findIndex((x) => x.runId === r.runId);
    if (i >= 0) this.runs[i] = r;
    else this.runs.unshift(r);
    this.runs = this.runs.slice(0, this.maxRuns);
    this.emit("run", r);
  }

  recentRuns(): RunRecord[] {
    return this.runs;
  }
}
