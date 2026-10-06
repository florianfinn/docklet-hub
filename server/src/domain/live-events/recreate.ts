export const RECREATE_WINDOW_MS = 150;

export function createRecreateBatch(options: {
  signal: AbortSignal;
  wait: (ms: number, signal: AbortSignal) => Promise<void>;
  resync: () => Promise<void>;
  changed: () => void;
  onError: (error: unknown) => void;
}) {
  let dirty = false;
  let task: Promise<void> | undefined;
  const run = async () => {
    while (dirty && !options.signal.aborted) {
      await options.wait(RECREATE_WINDOW_MS, options.signal);
      if (options.signal.aborted) return;
      dirty = false;
      await options.resync();
      if (!options.signal.aborted) options.changed();
    }
  };
  const schedule = () => {
    if (options.signal.aborted) return;
    dirty = true;
    // One bit records further demand while a cycle is running.
    task ??= run().catch(options.onError).finally(() => {
      task = undefined;
      if (dirty && !options.signal.aborted) schedule();
    });
  };
  return {
    schedule,
    settled: () => task
  };
}
