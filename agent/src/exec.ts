import crypto from "node:crypto";
import {
  EXEC_IDLE_MS,
  EXEC_MAX_DURATION_MS,
  EXEC_MAX_SESSIONS,
  EXEC_SHELL_CANDIDATES,
  type TerminalSize
} from "contract";

import { redactKnownSecrets } from "./redact.js";

// Shell in the container (S16 — K1d, CONTAINER_ETAPPENPLAN_LOCAL.md §20.1).
//
// The reason this stage exists at all is in §20.1 and turns the obvious
// argument around: `docker exec` from the UI is LESS privileged than the path
// it replaces. Whoever wants to look into a container today logs in to the
// host via SSH and thereby has host root. The UI grants container rights, not
// host root — and it is audited, the SSH session is not.
//
// Here are the two parts that can be tested without Docker: redacting a byte
// stream across chunk boundaries, and session management. Everything that
// touches a socket stays in routes/exec-routes.ts.

// The limits of a session live in the shared contract since #272
// (`contract/src/agent/limits.ts`), with their reasons: the shell order
// (§20.1: `bash`, otherwise `sh`), the cap on open sessions, the hard upper
// limit on duration and the idle timeout. The bounds of the window size are
// applied by `terminalSizeSchema` when the request is read.
export const SHELL_CANDIDATES = EXEC_SHELL_CANDIDATES;
export const MAX_EXEC_SESSIONS = EXEC_MAX_SESSIONS;
export { EXEC_IDLE_MS, EXEC_MAX_DURATION_MS };
export type { TerminalSize };

// --- Redacting a byte stream ------------------------------------------------
//
// ⚠️ Condition 2 from §20.1: "Output through redactKnownSecrets(), like the
// log stream. An `env` in the shell must not print what the masking hides
// elsewhere."
//
// The log stream has it easier: there the unit is a LINE, and a secret always
// stands completely within one. A terminal, by contrast, delivers a raw byte
// stream whose chunk boundaries the kernel sets — `redactKnownSecrets()` per
// chunk could be bypassed by nothing more than an unlucky cut, and a long
// secret, of all things, is very likely to be split.
//
// That is why this stream holds back the end, but ONLY as far as it could
// actually be the beginning of a known secret. In the normal case — the text
// does not end in the beginning of a secret — everything goes out without a
// single millisecond of delay; for a terminal whose echo the user sees while
// typing, that is no nicety.
export class RedactingStream {
  private rest = "";
  private readonly secrets: string[];
  private readonly maxHalt: number;

  // A very long secret (an embedded certificate) would otherwise hold back an
  // arbitrary amount of text. The cap costs nothing real: what gets split is
  // one write of the container, and that is rarely this large.
  static readonly MAX_HALT = 4096;

  constructor(secrets: readonly string[]) {
    // Congruent with redactKnownSecrets: what is never replaced there because
    // it is too short need not be held back here either. If the two limits
    // drifted apart, this stream would hold text back for nothing.
    this.secrets = [...new Set(secrets.filter((value) => value.length >= 8))];
    this.maxHalt = Math.min(
      RedactingStream.MAX_HALT,
      this.secrets.reduce((max, value) => Math.max(max, value.length - 1), 0)
    );
  }

  push(text: string): string {
    if (!text) return "";
    const total = this.rest + text;
    const halt = this.holdPosition(total);
    this.rest = total.slice(halt);
    return redactKnownSecrets(total.slice(0, halt), this.secrets);
  }

  // What is still held back but should now go out: at the end of the session
  // and when nothing more arrives for a longer time. Without this second case
  // a prompt that happens to look like the beginning of a secret would stay
  // invisible.
  flush(): string {
    const rest = this.rest;
    this.rest = "";
    return redactKnownSecrets(rest, this.secrets);
  }

  get heldBack(): number {
    return this.rest.length;
  }

  // The largest position from which the tail of the text could still be the
  // BEGINNING of a secret. Everything before it may go out.
  //
  // The search goes via the first character of each secret instead of over all
  // lengths: otherwise the effort per chunk would be quadratic in the secret
  // length, and this code runs in an interactive path.
  private holdPosition(text: string): number {
    if (this.maxHalt === 0 || text.length === 0) return text.length;
    let halt = text.length;
    for (const secret of this.secrets) {
      const lowerBound = Math.max(0, text.length - Math.min(secret.length - 1, this.maxHalt));
      for (let i = text.indexOf(secret[0], lowerBound); i >= 0; i = text.indexOf(secret[0], i + 1)) {
        const length = text.length - i;
        // A COMPLETE match is replaced by redactKnownSecrets and does not need
        // to be held back.
        if (length >= secret.length) continue;
        if (text.startsWith(secret.slice(0, length), i)) {
          if (i < halt) halt = i;
          break;
        }
      }
    }
    return halt;
  }
}

// --- Session management -----------------------------------------------------

export type ExecSession = {
  id: string;
  containerId: string;
  containerName: string;
  // Who opened it. Input and resizing check against it — the session id
  // alone should not suffice to type into someone else's shell.
  actor: string | null;
  execId: string;
  shell: string;
  started: number;
  // Byte counters in both directions. They are the only thing logged about a
  // session — volume instead of content (condition 1 from §20.1).
  sent: number;
  received: number;
  write(data: Buffer): void;
  resize(size: TerminalSize): Promise<void>;
  finish(reason: string): void;
};

export class ExecSessions {
  private readonly sessions = new Map<string, ExecSession>();

  constructor(private readonly maximum: number = MAX_EXEC_SESSIONS) {}

  get count(): number {
    return this.sessions.size;
  }

  isFull(): boolean {
    return this.sessions.size >= this.maximum;
  }

  // 256 bits from the CSPRNG. The id travels to the browser and back; it must
  // be neither guessable nor enumerable.
  static newId(): string {
    return crypto.randomBytes(32).toString("hex");
  }

  register(session: ExecSession): void {
    this.sessions.set(session.id, session);
  }

  remove(id: string): void {
    this.sessions.delete(id);
  }

  // `null` means "does not exist or belongs to someone else" — deliberately
  // the same answer for both, so that foreign session ids cannot be confirmed
  // via the error message.
  fetch(id: string, actor: string | null): ExecSession | null {
    const session = this.sessions.get(id);
    if (!session) return null;
    if (session.actor !== actor) return null;
    return session;
  }

  all(): ExecSession[] {
    return [...this.sessions.values()];
  }
}
