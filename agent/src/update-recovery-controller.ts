import type { StopIntentTarget } from "contract";

export const UPDATE_RECOVERY_RETRY_MS = 1000;
export const UPDATE_RECOVERY_MAX_RETRY_MS = 60_000;

export class UpdateRecoveryController {
  private ready = false;
  private running = false;
  private stopped = false;
  private retry = UPDATE_RECOVERY_RETRY_MS;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private unknownJournal = false;
  private targets: StopIntentTarget[] = [];
  constructor(private readonly deps: {
    recover: () => Promise<void>; pending: () => StopIntentTarget[];
    failed: (error: unknown, retryMs: number) => void;
  }) {}
  isReady(): boolean { return this.ready; }
  blocks(target: StopIntentTarget | null): boolean {
    if (this.ready || !target) return false;
    if (this.unknownJournal) return true;
    try { this.targets = [...new Map([...this.targets, ...this.deps.pending()].map((value) => [JSON.stringify(value), value])).values()]; }
    catch { this.unknownJournal = true; return true; }
    return this.targets.some((value) => JSON.stringify(value) === JSON.stringify(target));
  }
  start(): void {
    if (this.running || this.ready || this.stopped) return;
    this.running = true;
    void this.attempt();
  }
  stop(): void { this.stopped = true; if (this.timer) clearTimeout(this.timer); this.timer = null; }
  private async attempt(): Promise<void> {
    try {
      try { this.targets = [...new Map([...this.targets, ...this.deps.pending()].map((value) => [JSON.stringify(value), value])).values()]; } catch { this.unknownJournal = true; }
      await this.deps.recover();
      this.ready = true;
    } catch (error) {
      const delay = this.retry;
      try { this.deps.failed(error, delay); }
      catch { console.error("[agent] update recovery failure reporting failed"); }
      finally {
        this.retry = Math.min(delay * 2, UPDATE_RECOVERY_MAX_RETRY_MS);
        if (!this.stopped) { this.timer = setTimeout(() => { void this.attempt(); }, delay); this.timer.unref(); }
      }
    }
  }
}
