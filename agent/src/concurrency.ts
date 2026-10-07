// Maps `items` with bounded concurrency and PRESERVES the order (result[i]
// belongs to items[i]).
//
// Needed for the container list (container view performance, stage 3.1): the
// expensive part per container is the one-shot stats call (~1-2 s, because the
// daemon samples a CPU window). Strictly one after another this adds up over
// dozens of containers to a long first loading wave; running a few in parallel
// shortens the wait noticeably without hitting agent and engine with all
// requests at once.
//
// A module of its own, so that the order/error semantics stay testable without
// the server body (index.ts starts a listener on import). If `fn` throws for
// one element, the whole mapping rejects (Promise.all semantics); the callers
// handle expected cases like 404 themselves and return a value there instead
// of throwing.
export async function mapLimit<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let cursor = 0;
  const worker = async (): Promise<void> => {
    while (cursor < items.length) {
      const index = cursor++;
      results[index] = await fn(items[index], index);
    }
  };
  const lanes = Math.max(1, Math.min(limit, items.length));
  await Promise.all(Array.from({ length: lanes }, () => worker()));
  return results;
}

// Runtime callers opt into a bounded FIFO queue; other Compose paths keep
// their immediate busy rejection. Both share the same project lock.
export class KeyedMutexBusyError extends Error {
  constructor(readonly key: string) {
    super("stack-busy");
    this.name = "KeyedMutexBusyError";
  }
}

export class ActionQueueError extends Error {
  constructor(readonly code: "action-queue-timeout" | "action-caller-disconnected") {
    super(code);
    this.name = "ActionQueueError";
  }
}

type Waiter = { grant: () => void };
export class KeyedMutex {
  private readonly active = new Set<string>();
  private readonly queues = new Map<string, Waiter[]>();

  async runExclusive<T>(
    key: string,
    operation: () => Promise<T>,
    options?: { waitMs: number; signal?: AbortSignal; onQueued?: () => void }
  ): Promise<T> {
    if (options?.signal?.aborted) throw new ActionQueueError("action-caller-disconnected");
    if (this.active.has(key)) {
      if (!options) throw new KeyedMutexBusyError(key);
      await new Promise<void>((resolve, reject) => {
        const queue = this.queues.get(key) ?? [];
        this.queues.set(key, queue);
        const remove = () => {
          clearTimeout(timer);
          options.signal?.removeEventListener("abort", abort);
          const index = queue.indexOf(waiter);
          if (index >= 0) queue.splice(index, 1);
          if (queue.length === 0) this.queues.delete(key);
        };
        const fail = (code: "action-queue-timeout" | "action-caller-disconnected") => {
          remove();
          reject(new ActionQueueError(code));
        };
        const abort = () => fail("action-caller-disconnected");
        const waiter: Waiter = { grant: () => { remove(); resolve(); } };
        const timer = setTimeout(() => fail("action-queue-timeout"), options.waitMs);
        queue.push(waiter);
        options.signal?.addEventListener("abort", abort, { once: true });
        try { options.onQueued?.(); }
        catch (error) { remove(); reject(error); }
      });
    } else {
      this.active.add(key);
    }
    try {
      if (options?.signal?.aborted) throw new ActionQueueError("action-caller-disconnected");
      return await operation();
    } finally {
      const next = this.queues.get(key)?.[0];
      if (next) next.grant();
      else this.active.delete(key);
    }
  }

  pendingKeys(): number { return this.active.size; }
}

// Cap for simultaneously open streams (R3, security review 2026-08).
//
// Every following stream holds a connection to the Docker socket for its
// whole lifetime (log stream, pull stream) or a file follower with an open
// descriptor (log file stream). They do not end on their own: a log stream
// runs until the caller leaves. Without an upper bound a few dozen calls are
// enough to make the agent process run out of descriptors and the daemon out
// of connections — and the agent is the ONLY route to the socket. If it fails,
// the whole management path is gone, not just one stream.
//
// `exec` had this cap from the start (MAX_EXEC_SESSIONS, §20.1), stack actions
// the KeyedMutex above. The reading streams had nothing — R3 closes exactly
// this gap, in the same style: reject immediately (429) instead of holding
// invisibly in a queue.
//
// Deliberately global and NOT counted per caller: the bottleneck is the agent
// host, not the caller. A cap per actor would let ten actors together produce
// the same exhaustion the cap stands against.
//
// ⚠️ The limit does not only count, it also MEASURES (R5). "How long do the
// long-lived paths actually run in operation?" was the first task of R5 and
// the condition under which the transport deadlines could be chosen at all —
// a value below the real duration cuts it off. The answer therefore must not
// come from an estimate but from the agent itself: it alone knows when a
// stream opened.
export type StreamRelease = () => void;

export class StreamLimit {
  // Start time per open stream. The map REPLACES the earlier counter: its size
  // is the counter, and each entry additionally carries since when this slot
  // has been taken.
  private readonly started = new Map<number, number>();
  private nextId = 0;
  private longestFinished = 0;

  // The clock is injectable, so that the duration information can be tested
  // without real waiting.
  constructor(readonly maximum: number, private readonly now: () => number = Date.now) {}

  get count(): number {
    return this.started.size;
  }

  isFull(): boolean {
    return this.started.size >= this.maximum;
  }

  // How long the oldest CURRENTLY open stream has been running (0 if none is
  // open).
  get oldestMs(): number {
    let oldest = 0;
    const now = this.now();
    for (const start of this.started.values()) oldest = Math.max(oldest, now - start);
    return oldest;
  }

  // The longest duration this pool has seen since the agent started — open
  // streams included. Without it the information would only be a snapshot: a
  // stream that has been running for three days only shows up in `oldestMs`
  // as long as it is still open.
  get longestMs(): number {
    return Math.max(this.longestFinished, this.oldestMs);
  }

  // Check and take in ONE step. Separately (first `isFull()`, then take),
  // every `await` in between would be a window in which two requests see the
  // same free slot — a cap that gives way under load exactly when it is
  // needed.
  //
  // `null` means "full". Otherwise the release comes back, which the caller
  // calls in its `finally`.
  tryAcquire(): StreamRelease | null {
    if (this.isFull()) return null;
    const id = this.nextId;
    this.nextId += 1;
    this.started.set(id, this.now());
    return () => {
      // A double release does NOT count down twice. Otherwise a single path
      // that accidentally releases twice would raise the cap for everyone
      // else — the counter would go below zero and the protection would be
      // silently gone. The missing entry IS the lock here: what has been
      // removed once cannot be removed a second time.
      const start = this.started.get(id);
      if (start === undefined) return;
      this.started.delete(id);
      this.longestFinished = Math.max(this.longestFinished, this.now() - start);
    };
  }
}
