import test from "node:test";
import assert from "node:assert/strict";

import type { Role } from "../../platform/auth/roles.js";
import { intervalSchedule, startPermissionWatch, type CurrentUser, type Scheduler } from "./permission-watch.js";
import { EXEC_PERMISSION_CHECK_MS } from "./session-register.js";

// The repeated permission check of an open shell, without Express and without
// waiting a minute (#260). The beat is a stand-in the test fires by hand; what
// it asks is the person behind the session NOW.

const tick = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

/** A beat the test fires itself, recording the interval it was asked for and whether it was cancelled. */
function manualBeat(): { schedule: Scheduler; fire: () => Promise<void>; everyMs: () => number | null; stopped: () => boolean } {
  const state: { task: (() => void) | null; everyMs: number | null; stopped: boolean } = {
    task: null,
    everyMs: null,
    stopped: false
  };
  return {
    schedule: (task, everyMs) => {
      state.task = task;
      state.everyMs = everyMs;
      return () => {
        state.stopped = true;
      };
    },
    fire: async () => {
      state.task?.();
      await tick();
    },
    everyMs: () => state.everyMs,
    stopped: () => state.stopped
  };
}

function watching(currentUser: CurrentUser): {
  beat: ReturnType<typeof manualBeat>;
  revocations: () => number;
  watch: ReturnType<typeof startPermissionWatch>;
} {
  const beat = manualBeat();
  const state = { revocations: 0 };
  const watch = startPermissionWatch({
    schedule: beat.schedule,
    userId: "u-1",
    currentUser,
    onRevoked: () => {
      state.revocations += 1;
    }
  });
  return { beat, revocations: () => state.revocations, watch };
}

const asUser = (id: string, role: Role): CurrentUser => () => Promise.resolve({ id, role });

test("die Prüfung läuft im Takt von EXEC_PERMISSION_CHECK_MS", () => {
  const { beat } = watching(asUser("u-1", "admin"));
  assert.equal(beat.everyMs(), EXEC_PERMISSION_CHECK_MS);
});

test("derselbe Mensch mit der Rolle Admin behält die Shell", async () => {
  const { beat, revocations, watch } = watching(asUser("u-1", "admin"));
  await beat.fire();
  await beat.fire();
  assert.equal(revocations(), 0);
  assert.equal(watch.revoked(), false);
});

test("ein Herabstufen auf die Rolle User entzieht das Recht — und nur einmal", async () => {
  const { beat, revocations, watch } = watching(asUser("u-1", "user"));
  await beat.fire();
  await beat.fire();
  assert.equal(revocations(), 1, "the revocation was announced more than once");
  assert.equal(watch.revoked(), true);
});

test("ein anderes Konto hinter derselben Sitzung ist nicht der Mensch, der die Shell geöffnet hat", async () => {
  const { beat, revocations } = watching(asUser("u-2", "admin"));
  await beat.fire();
  assert.equal(revocations(), 1);
});

test("keine Sitzung mehr (Konto gelöscht, abgelaufen, Break-Glass) entzieht das Recht", async () => {
  const { beat, revocations } = watching(() => Promise.resolve(null));
  await beat.fire();
  assert.equal(revocations(), 1);
});

test("ein Fehler beim Auflösen gilt als kein Recht und nicht als unverändert", async () => {
  const { beat, revocations } = watching(() => Promise.reject(new Error("database stumbled")));
  await beat.fire();
  assert.equal(revocations(), 1);
});

test("stop bestellt den Takt ab", () => {
  const { beat, watch } = watching(asUser("u-1", "admin"));
  assert.equal(beat.stopped(), false);
  watch.stop();
  assert.equal(beat.stopped(), true);
});

test("der echte Takt läuft, bis er abbestellt wird, und hält den Prozess nicht am Leben", async () => {
  let runs = 0;
  const stop = intervalSchedule(() => {
    runs += 1;
  }, 5);
  await new Promise((resolve) => setTimeout(resolve, 40));
  stop();
  const after = runs;
  assert.ok(after >= 1, "the beat never ran");
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(runs, after, "the beat kept running after it was cancelled");
});
