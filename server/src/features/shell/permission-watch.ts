import type { Role } from "../../platform/auth/roles.js";
import { EXEC_PERMISSION_CHECK_MS } from "./session-register.js";

// The repeated permission check next to a running shell (#260). It stood in the
// stream route of `api/routes/exec-routes.ts` as `startWatching`, tied to the
// response; here it is a function of its own, so that revoking a right, a
// different person behind the session cookie and the clean-up of the timer are
// checked without Express (`permission-watch.test.ts`).
//
// WHY IT EXISTS AT ALL. The log stream solves the same problem with a
// deliberately short connection: when it runs out, the browser reconnects and
// passes the full permission check again. A shell cannot do that, because a
// terminal that restarts every few minutes loses its state. So the connection
// stays and the check repeats next to it. Without it the hub would hold open a
// shell whose right was revoked until the agent seals it after 30 minutes.

/**
 * A repeating beat that can be cancelled.
 *
 * What comes back is the cancel function and not a handle on the timer: what a
 * caller does not hold, it cannot misuse.
 */
export type Scheduler = (task: () => void, everyMs: number) => () => void;

/**
 * The default beat: a real `setInterval`.
 *
 * ⚠️ `unref()` AND THE CLEAR IN THE CALLER'S `finally` BELONG TOGETHER, and
 * neither replaces the other. A running timer keeps the Node process alive;
 * `node --test` then hangs at the end of the suite without one red line, and
 * that looks like a timeout of the environment instead of a forgotten
 * `clearInterval`. `unref()` alone takes the weight off the timer but not the
 * work: a beat that outlives its stream would check the right of a session
 * that no longer exists forever.
 */
export const intervalSchedule: Scheduler = (task, everyMs) => {
  const timer = setInterval(task, everyMs);
  timer.unref();
  return () => clearInterval(timer);
};

/** The person behind the session NOW, or `null`: the answer of `resolveSession`. */
export type CurrentUser = () => Promise<{ id: string; role: Role } | null>;

export type PermissionWatch = {
  /** Cancels the beat. Safe to call twice. */
  stop: () => void;
  /** Whether the check found the right gone. */
  revoked: () => boolean;
};

export type PermissionWatchInput = {
  schedule: Scheduler;
  /** The person who opened the session; the session belongs to them. */
  userId: string;
  currentUser: CurrentUser;
  /** Runs once, the first time the check finds the right gone. */
  onRevoked: () => void;
  everyMs?: number;
};

export function startPermissionWatch(input: PermissionWatchInput): PermissionWatch {
  const state = { revoked: false };
  const stop = input.schedule(() => {
    void (async () => {
      // ⚠️ THE CURRENT SESSION AND NOT THE USER FROM WHEN THE SHELL OPENED. The
      // question is "is signed in" and not "was signed in": a deleted account,
      // a session that expired or that the break-glass ended, and a demotion
      // to the role User take effect at the next beat and not at the next
      // restart.
      //
      // ⚠️ AN ERROR WHILE RESOLVING COUNTS AS "NO RIGHT" and not as
      // "unchanged". Fail closed, the same stance as `require-admin.ts`: a
      // session that cannot be resolved is none. The price is named honestly —
      // a database that stumbles for a second costs the open shells.
      const current = await input.currentUser().catch(() => null);
      // The IDENTITY is compared too: the connection belongs to the person who
      // opened it, and a session cookie that now points to another account is
      // not theirs.
      if (current !== null && current.role === "admin" && current.id === input.userId) return;
      if (state.revoked) return;
      state.revoked = true;
      input.onRevoked();
    })();
  }, input.everyMs ?? EXEC_PERMISSION_CHECK_MS);
  return { stop, revoked: () => state.revoked };
}
