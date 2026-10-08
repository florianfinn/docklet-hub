import { performance } from "node:perf_hooks";
import { RuntimeBudget, type RuntimeCallOptions } from "./runtime-budget.js";
import type { UpdateError } from "contract";

export class UpdateFailure extends Error {
  constructor(readonly code: UpdateError) { super(code); }
}
export class UpdateBudget extends RuntimeBudget {
  private readonly updateDeadline: number;
  constructor(ms: number, private readonly clock = () => performance.now()) { super(ms); this.updateDeadline = clock() + ms; }
  remaining(cap = Infinity): number {
    const ms = Math.min(cap, this.updateDeadline - this.clock());
    if (ms <= 0) throw new UpdateFailure("update-phase-deadline-exceeded");
    return ms;
  }
  async run<T>(operation: (options: Required<RuntimeCallOptions>) => Promise<T>, cap = Infinity): Promise<T> {
    const timeoutMs = this.remaining(cap); const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const result = await Promise.race([operation({ timeoutMs, signal: controller.signal }), new Promise<never>((_, reject) => {
        timer = setTimeout(() => { reject(new UpdateFailure("update-phase-deadline-exceeded")); controller.abort(); }, timeoutMs);
      })]);
      this.remaining(); return result;
    } finally { clearTimeout(timer); }
  }
}
