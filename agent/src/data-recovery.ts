import { MUTATION_QUEUE_POLICY, UPDATE_MUTATION_RESERVE_MS, type StopIntentTarget } from "contract";
import { DataJournal } from "./data-journal.js";
import { KeyedMutex } from "./concurrency.js";
import { projectLockKey } from "./project-lock.js";
import { stopIntentTarget, targetKey } from "./stop-intent.js";
import { UpdateBudget } from "./update-budget.js";
import type { RawInspect } from "./engine.js";

export async function recoverDataOperations(deps: {
  journal: DataJournal; locks: KeyedMutex; known: (target: StopIntentTarget) => string[];
  inspect: (id: string, budget: UpdateBudget) => Promise<RawInspect>;
  resume: (raw: RawInspect, budget: UpdateBudget) => Promise<RawInspect>;
  intentional: (raw: RawInspect) => () => void;
  interrupted: (target: StopIntentTarget, id: string, message: string) => void;
}) {
  for (const pending of deps.journal.read()) {
    const key = projectLockKey(pending.target.kind === "compose" ? { projectName: pending.target.projectName } : { containerName: pending.target.containerName });
    await deps.locks.runExclusive(key, async () => {
      const entry = deps.journal.read().find((value) => targetKey(value.target) === targetKey(pending.target));
      if (!entry) return;
      const ids = deps.known(entry.target);
      if (ids.length !== 1 || ids[0] !== entry.containerId) throw new Error("data-recovery-target-mismatch");
      const budget = new UpdateBudget(UPDATE_MUTATION_RESERVE_MS);
      const current = await deps.inspect(entry.containerId, budget);
      const actual = stopIntentTarget(current);
      if (!actual || targetKey(actual) !== targetKey(entry.target)) throw new Error("data-recovery-target-mismatch");
      const raw = { ...current, State: { ...current.State, Running: entry.running, Restarting: entry.restarting, Paused: entry.paused } };
      const finish = deps.intentional(raw);
      try {
        await deps.resume(raw, budget);
        deps.interrupted(entry.target, entry.containerId, entry.extractStarted ? "restore-interrupted-after-extract" : `${entry.kind}-interrupted-before-exchange`);
        deps.journal.complete(entry.target);
      } finally { finish(); }
    }, { waitMs: MUTATION_QUEUE_POLICY.restore });
  }
}
