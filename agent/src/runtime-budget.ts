import { performance } from "node:perf_hooks";
import { HUB_RUNTIME_TIMEOUT_MS, RUNTIME_TRANSPORT_RESERVE_MS } from "contract";
import { StackEndpointError } from "./stack-control.js";

export type RuntimeCallOptions = { timeoutMs?: number; signal?: AbortSignal };

// One monotonic deadline, including all reads and queue time. Autonomous starts
// use the same finite envelope so healing cannot hold the shared lock forever.
export class RuntimeBudget {
  private readonly deadline: number;
  constructor(durationMs = HUB_RUNTIME_TIMEOUT_MS - RUNTIME_TRANSPORT_RESERVE_MS) {
    this.deadline = performance.now() + durationMs;
  }

  remaining(cap = Infinity): number {
    const remaining = Math.min(cap, this.deadline - performance.now());
    if (remaining <= 0) throw new StackEndpointError(504, "runtime-deadline-exceeded");
    return remaining;
  }

  async run<T>(operation: (options: Required<RuntimeCallOptions>) => Promise<T>, cap?: number): Promise<T> {
    const timeoutMs = this.remaining(cap);
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const expired = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        reject(new StackEndpointError(504, "runtime-deadline-exceeded"));
        controller.abort();
      }, timeoutMs);
    });
    try {
      const value = await Promise.race([operation({ timeoutMs, signal: controller.signal }), expired]);
      this.remaining();
      return value;
    } finally { clearTimeout(timer); }
  }
}

export function runtimeCall<T>(budget: RuntimeBudget | undefined, operation: (options: RuntimeCallOptions) => Promise<T>): Promise<T> {
  return budget ? budget.run(operation) : operation({});
}
