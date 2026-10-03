// One store per running NDJSON stream of the web (#257).
//
// Before this step every view that showed a stream (container logs, stack
// logs, shell) held it in its own `useEffect`: its own AbortController, its
// own line buffer with its own cap, its own attempt counter for reconnecting.
// This store holds exactly that, without React and without knowing what the
// lines mean; a view reads it through `useStream` (`use-stream.ts`) and
// `useSyncExternalStore`.
//
// ⚠️ WHAT A STREAM COSTS ON THE OTHER SIDE. Every open stream holds one of the
// agent's simultaneous streams (`MAX_OPEN_STREAMS`); a forgotten one blocks the
// arm for everybody with `429`. Three rules below follow from that and only
// from that:
//
//   1. A stream runs only while somebody reads it. The last reader leaving
//      aborts it — after a grace period, see rule 3.
//   2. Two readers of the same key share ONE stream (`sharedStream`), they do
//      not open two.
//   3. Leaving and coming back within the grace period keeps the stream.
//      React's StrictMode mounts every effect twice in development
//      (subscribe, unsubscribe, subscribe); without the grace period that
//      would be two streams at the arm for every view.
//
// ⚠️ NO AUTOMATIC RECONNECT, and that is a decision (#126): a forgotten tab
// that knocks again by itself blocks the arm's logs for everybody else.
// `reconnect()` is called by a person pressing a button, nothing else.

/**
 * What the stream is doing.
 *
 * - `connecting`: requested, the hub has not answered yet.
 * - `open`: the hub answered with `200`; lines may or may not have come yet.
 * - `failed`: an error before the first line (`error`) or a failure line in
 *   the stream (`failure`). The lines already received stay readable.
 * - `closed`: the stream ended by itself, or it was released.
 */
export type StreamPhase = "connecting" | "open" | "failed" | "closed";

/** How a source reports into the store. */
export type StreamSink<TLine, TFailure> = {
  /** The hub answered and the body is being read; a status code can no longer come. */
  open: () => void;
  line: (line: TLine) => void;
  /** A failure line IN the stream. The source keeps reading; the phase is `failed`. */
  fail: (failure: TFailure) => void;
};

/**
 * Opens the stream and reports into `sink` until it ends.
 *
 * Resolving means "ended by itself", rejecting means "failed before or while
 * reading". ⚠️ The source must stop on `signal`; abort is the normal case
 * (the reader left) and is never reported as an error.
 */
export type StreamSource<TLine, TFailure> = (signal: AbortSignal, sink: StreamSink<TLine, TFailure>) => Promise<void>;

export type StreamSnapshot<TLine, TFailure> = {
  phase: StreamPhase;
  /** The held lines, oldest first, at most `cap`. */
  lines: readonly TLine[];
  /**
   * How many lines fell off the front because of the cap. The line at index
   * `i` is the `dropped + i`-th line of this attempt: a stable React key
   * even while the front is trimmed.
   */
  dropped: number;
  /** The rejection of the source, if it failed that way; `null` otherwise. */
  error: unknown;
  /** The last failure line, if one came; `null` otherwise. */
  failure: TFailure | null;
  /** Counts reconnects. A view that keys something by attempt reads it here. */
  attempt: number;
};

export type StreamStore<TLine, TFailure> = {
  subscribe: (listener: () => void) => () => void;
  getSnapshot: () => StreamSnapshot<TLine, TFailure>;
  /** Starts a fresh attempt after `failed` or `closed`. Does nothing while running. */
  reconnect: () => void;
};

/** Defers a call and returns how to cancel it. Injected by tests. */
export type Scheduler = (run: () => void) => () => void;

export type StreamStoreOptions = {
  /**
   * How many lines the store holds at most; older ones drop off the front.
   * ⚠️ Required: a stream of a container never ends by itself, and without a
   * cap the buffer grows until the tab stalls.
   */
  cap: number;
  /** Defers the release after the last reader left. Default: the next macrotask. */
  schedule?: Scheduler;
  /** Called when the stream was released because nobody reads it anymore. */
  onRelease?: () => void;
  /** Called when a released store gets a reader again and starts anew. */
  onRevive?: () => void;
};

/**
 * The grace period of rule 3: one macrotask.
 *
 * ⚠️ NOT A MICROTASK. React runs the StrictMode double invocation within one
 * commit, so a microtask would do there — but a passive effect may run in a
 * later task than the cleanup of the previous one when a screen switches
 * routes, and the stream must survive a view that unmounts and remounts in
 * the same switch.
 */
const nextTask: Scheduler = (run) => {
  const timer = setTimeout(run, 0);
  return () => clearTimeout(timer);
};

function initialSnapshot<TLine, TFailure>(attempt: number): StreamSnapshot<TLine, TFailure> {
  return { phase: "connecting", lines: [], dropped: 0, error: null, failure: null, attempt };
}

export function createStreamStore<TLine, TFailure>(
  source: StreamSource<TLine, TFailure>,
  options: StreamStoreOptions
): StreamStore<TLine, TFailure> {
  if (!Number.isInteger(options.cap) || options.cap < 1) {
    throw new RangeError(`cap must be a positive integer, got ${String(options.cap)}`);
  }
  const schedule = options.schedule ?? nextTask;
  const listeners = new Set<() => void>();
  let snapshot: StreamSnapshot<TLine, TFailure> = initialSnapshot(0);
  // The running attempt's controller; `null` while nothing runs.
  let controller: AbortController | null = null;
  let cancelRelease: (() => void) | null = null;
  let released = false;
  let started = false;

  const publish = (next: StreamSnapshot<TLine, TFailure>): void => {
    snapshot = next;
    for (const listener of [...listeners]) listener();
  };

  const start = (): void => {
    const own = new AbortController();
    controller = own;
    // ⚠️ EVERY REPORT CHECKS ITS OWN ATTEMPT. A source that ignores the abort
    // for one more line would otherwise write into the next attempt's buffer.
    const live = () => controller === own && !own.signal.aborted;
    const sink: StreamSink<TLine, TFailure> = {
      open: () => {
        if (!live() || snapshot.phase !== "connecting") return;
        publish({ ...snapshot, phase: "open" });
      },
      line: (line) => {
        if (!live()) return;
        const lines = [...snapshot.lines, line];
        const excess = lines.length - options.cap;
        publish(
          excess > 0
            ? { ...snapshot, lines: lines.slice(excess), dropped: snapshot.dropped + excess }
            : { ...snapshot, lines }
        );
      },
      fail: (failure) => {
        if (!live()) return;
        publish({ ...snapshot, phase: "failed", failure });
      }
    };
    let running: Promise<void>;
    try {
      running = source(own.signal, sink);
    } catch (error) {
      running = Promise.reject(error);
    }
    running.then(
      () => {
        if (!live()) return;
        controller = null;
        // A failure line already said why it ended; keep that.
        if (snapshot.phase !== "failed") publish({ ...snapshot, phase: "closed" });
      },
      (error: unknown) => {
        if (!live()) return;
        controller = null;
        publish({ ...snapshot, phase: "failed", error });
      }
    );
  };

  const stop = (): void => {
    controller?.abort();
    controller = null;
  };

  const release = (): void => {
    cancelRelease = null;
    if (listeners.size > 0) return;
    stop();
    released = true;
    options.onRelease?.();
  };

  // ⚠️ A STORE NOBODY EVER SUBSCRIBES TO RELEASES ITSELF. React may render a
  // view and throw the render away without committing it; the store that
  // render created would otherwise stay in the registry for good.
  cancelRelease = schedule(release);

  return {
    subscribe(listener) {
      listeners.add(listener);
      cancelRelease?.();
      cancelRelease = null;
      if (released) {
        released = false;
        // Came back after the grace period: a fresh stream, as on first use.
        // A store that never ran keeps attempt 0.
        if (started) snapshot = initialSnapshot(snapshot.attempt + 1);
        options.onRevive?.();
        started = true;
        start();
      } else if (!started) {
        started = true;
        start();
      }
      return () => {
        if (!listeners.delete(listener)) return;
        if (listeners.size === 0 && cancelRelease === null && !released) cancelRelease = schedule(release);
      };
    },
    getSnapshot: () => snapshot,
    reconnect() {
      if (released || (snapshot.phase !== "failed" && snapshot.phase !== "closed")) return;
      stop();
      publish(initialSnapshot(snapshot.attempt + 1));
      start();
    }
  };
}

// ── Sharing by key ──────────────────────────────────────────────────────────

const shared = new Map<string, StreamStore<unknown, unknown>>();

/**
 * The store for `key`, shared by every reader of that key (rule 2).
 *
 * `create` runs only when no store for the key exists yet; it must pass the
 * `onRelease`/`onRevive` it is given on to `createStreamStore`, so a released
 * store leaves the registry and a revived one returns to it.
 *
 * ⚠️ THE KEY MUST NAME EVERYTHING THE SOURCE READS (host, container, …). Two
 * views with the same key and different sources would read the first one's
 * stream.
 */
export function sharedStream<TLine, TFailure>(
  key: string,
  create: (hooks: Pick<StreamStoreOptions, "onRelease" | "onRevive">) => StreamStore<TLine, TFailure>
): StreamStore<TLine, TFailure> {
  const existing = shared.get(key);
  if (existing !== undefined) return existing as StreamStore<TLine, TFailure>;
  const store = create({
    onRelease: () => {
      if (shared.get(key) === store) shared.delete(key);
    },
    onRevive: () => {
      // ⚠️ A view that still holds a released store (a render React kept)
      // revives it; if another store took the key meanwhile, both run. That
      // costs one stream at the arm, never a wrong line.
      if (!shared.has(key)) shared.set(key, store as StreamStore<unknown, unknown>);
    }
  });
  shared.set(key, store as StreamStore<unknown, unknown>);
  return store;
}

/** How many shared stores exist right now. For tests only. */
export function sharedStreamCount(): number {
  return shared.size;
}
