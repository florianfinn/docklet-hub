import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

// The agent's own, append-only audit log (stage plan 3.2).
//
// Deliberately separate from the main API's audit log: if the API is
// compromised or bypassed, its log is worthless. This one is attached to the
// process that actually performs the action — there is no route to the socket
// that bypasses it.
//
// JSONL instead of a database: the agent is not supposed to have a DB
// dependency, and appending a line is the operation that is hardest to break.
// There is deliberately no function for changing and none for deleting.
//
// The ONLY exception is `discardPrefix` (#30) — and it is not a back door but
// the opposite: it discards only bytes whose SHA-256 the caller has PROVEN
// beforehand, i.e. only those of which a verified copy has already arrived
// elsewhere. Without this route the only choice left is between a log that
// fills up the /state volume (and thereby shuts the agent down, see
// assertWritable) and a button that throws away evidence. The operation logs
// itself.

// Upper limit per text field of an entry.
//
// ⚠️ The reason is not a cosmetic flaw but an amplification: several fields
// come RAW from the request (the path of a rejected request, the `actor`
// header). Node accepts headers of up to 16 KB — without a cap, EVERY
// unauthenticated request therefore writes up to 16 KB into a log that by
// construction is never deleted. A connection attempt thus becomes a way to
// fill up the /state volume and paralyse the agent, because without a
// writable audit log it executes nothing any more.
//
// 240 characters are generous for every real value (action names, container
// ids, rejection reasons) and tight enough that an entry keeps a known order
// of magnitude. Truncation is VISIBLE (`…`), so that nobody takes a cut-off
// value for the complete one.
export const MAX_FIELD_CHARS = 240;

export function truncateField(value: string | null): string | null {
  if (value === null) return null;
  // Control characters would not break the JSONL line apart (JSON.stringify
  // escapes them), but they would mislead every reader of the file.
  // eslint-disable-next-line no-control-regex -- matching control characters is the point here
  const clean = value.replace(/[\u0000-\u001f\u007f]/g, " ");
  return clean.length <= MAX_FIELD_CHARS ? clean : `${clean.slice(0, MAX_FIELD_CHARS)}…`;
}

export type AuditEntry = {
  action: string;
  containerId: string | null;
  containerName: string | null;
  // Supplied by the main API; the agent logs what it was given.
  actor: string | null;
  networkTier: string | null;
  outcome: "allowed" | "denied" | "error";
  reason?: string;
};

// What was handed out in a handoff: the NUMBER of bytes and the SHA-256 of
// exactly these bytes.
//
// Both belong together and both are necessary. The byte count alone does not
// say WHICH bytes were meant — the log keeps growing in the meantime, and "the
// first 4 MB" is no fixed statement on a growing file as soon as someone asks
// twice. The SHA-256 alone does not say where the prefix ends. Together they
// name exactly one prefix.
export type Handoff = {
  bytes: number;
  sha256: string;
};

export type DiscardResult =
  | { ok: true; removed: number; rest: number }
  | { ok: false; reason: "no-log" | "already-running" | "too-short" | "sha-mismatch" };

// The SHA-256 of the first `bytes` bytes of a file, read as a stream.
//
// Streamed and not via readFileSync: in a runaway case the log can be large,
// and exactly then the answer to "is it too large?" must not be that the agent
// loads it into memory.
async function prefixSha256(filePath: string, bytes: number): Promise<string> {
  const hash = crypto.createHash("sha256");
  if (bytes === 0) return hash.digest("hex");
  const stream = fs.createReadStream(filePath, { start: 0, end: bytes - 1 });
  for await (const chunk of stream) hash.update(chunk as Buffer);
  return hash.digest("hex");
}

export class AgentAuditLog {
  // Whether a truncation is currently running. Two simultaneous runs would
  // otherwise pull the rug out from under each other: one checks the prefix,
  // the other cuts it away, and the first then truncates based on a proof
  // that applied to a file that no longer exists.
  private truncationRunning = false;

  constructor(private readonly filePath: string) {
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
  }

  // Check at startup whether writing is possible at all, and abort otherwise.
  //
  // The first attempt only logged the failure and carried on — in the smoke
  // test the agent thus ran with a silently dead audit log (the volume was
  // owned by root, the process runs as node). An agent that performs actions
  // without a log is worse than one that does not start: traceability is half
  // the purpose of this component.
  assertWritable(): void {
    this.append({
      at: new Date().toISOString(),
      action: "agent-start",
      containerId: null,
      containerName: null,
      actor: null,
      networkTier: null,
      outcome: "allowed"
    });
  }

  write(entry: AuditEntry): void {
    // Truncation happens HERE and not at the caller: there are over forty
    // write() call sites, and a rule that forty callers have to remember is no
    // rule.
    this.append({
      at: new Date().toISOString(),
      ...entry,
      action: truncateField(entry.action) ?? "",
      containerId: truncateField(entry.containerId),
      containerName: truncateField(entry.containerName),
      actor: truncateField(entry.actor),
      networkTier: truncateField(entry.networkTier),
      ...(entry.reason === undefined ? {} : { reason: truncateField(entry.reason) })
    });
  }

  // The size of the log in bytes, or null if there is none (yet).
  //
  // The log is deliberately append-only and does NOT rotate — it is the log of
  // the component with root-equivalent access, and a rotation that throws away
  // entries throws away evidence. The price for that is that it grows; hence
  // the size is a QUERYABLE number (see /health) and not a surprise that only
  // shows up once the volume is full.
  sizeBytes(): number | null {
    try {
      return fs.statSync(this.filePath).size;
    } catch {
      return null;
    }
  }

  // The free space of the volume the log lives on — or null if the file
  // system cannot be asked for it.
  //
  // Sits next to `sizeBytes()` because one number without the other is only
  // half the answer. "The log is 1 GB" is a side note on a 30 GB volume and the
  // last warning on a 2 GB volume before the agent comes to a standstill
  // (without a writable audit log it executes nothing any more). Only both
  // together allow a RELATIVE threshold instead of a guessed absolute byte
  // mark.
  //
  // `bavail` and not `bfree`: what is measured is what is available to this
  // process, not what is free including the reserve kept for root. The agent
  // does not run as root, and a number that counts a supply it cannot reach
  // would be too optimistic — in exactly the direction in which a
  // misjudgement hurts here.
  freeSpaceBytes(): number | null {
    try {
      const volume = fs.statfsSync(path.dirname(this.filePath));
      return volume.bavail * volume.bsize;
    } catch {
      return null;
    }
  }

  // What CAN be handed over right now: the current size and the SHA-256 of
  // exactly these bytes.
  //
  // ⚠️ Two passes over the file (hash once, then — by the caller — deliver)
  // instead of a running hash. The reason is the response header: `bytes` and
  // `sha256` have to be fixed BEFORE the body, otherwise the proof would come
  // as an HTTP trailer, and with the usual clients trailers are the route by
  // which a proof silently gets lost.
  //
  // That both passes see the same thing is not a hope but by design: the log
  // is only ever APPENDED to. What was once at bytes 0..N-1 is still there at
  // the second read — everything new lands behind it.
  //
  // The only exception would be a truncation in between: it replaces the file,
  // and then the header would refer to other bytes than the body. Hence the
  // handoff is under the same bolt as the truncation itself and says "running
  // right now" instead of delivering something inconsistent. The caller
  // repeats it afterwards — it is the cheap part anyway.
  async prepareHandoff(): Promise<Handoff | "already-running" | null> {
    if (this.truncationRunning) return "already-running";
    const bytes = this.sizeBytes();
    if (bytes === null) return null;
    return { bytes, sha256: await prefixSha256(this.filePath, bytes) };
  }

  // The read stream for exactly the handed-over bytes.
  //
  // Hard-limited to `bytes - 1`: the log keeps growing during delivery, and a
  // stream that delivers more bytes than the `content-length` announces is
  // not a cosmetic flaw — it breaks the HTTP framing, and the next request on
  // the same connection hangs.
  readStream(bytes: number): NodeJS.ReadableStream {
    return fs.createReadStream(this.filePath, { start: 0, end: bytes - 1 });
  }

  // Discard exactly the proven prefix — nothing else.
  //
  // The order is the point: first it is recomputed that the file still begins
  // with exactly these bytes today, and only then is anything touched. If the
  // proof does not match, NOTHING happens — no "roughly", no truncate on
  // suspicion.
  async discardPrefix(handoff: Handoff): Promise<DiscardResult> {
    if (this.truncationRunning) return { ok: false, reason: "already-running" };
    this.truncationRunning = true;
    try {
      const size = this.sizeBytes();
      if (size === null) return { ok: false, reason: "no-log" };
      // A prefix longer than the file cannot exist. That is the case "the
      // proof comes from another agent" or "from a log that has meanwhile
      // already been truncated once".
      if (size < handoff.bytes) return { ok: false, reason: "too-short" };
      if (await prefixSha256(this.filePath, handoff.bytes) !== handoff.sha256) {
        return { ok: false, reason: "sha-mismatch" };
      }
      return this.truncateSync(handoff.bytes);
    } finally {
      this.truncationRunning = false;
    }
  }

  // The intervention itself. ⚠️ SYNCHRONOUS, and that is the promise
  // everything depends on.
  //
  // Node executes JavaScript in one thread: as long as this function runs, no
  // request handler gets in between, and so no `append` either. If it were
  // asynchronous, there would be a window between "rest read" and "renamed" in
  // which an entry is still written into the OLD file — and it would be gone
  // after the rename. An archiving run that silently loses entries is exactly
  // the damage this route is supposed to prevent.
  //
  // The price is a block for the duration of the copy. It is small, because
  // what gets copied is what has been ADDED since the handoff — usually the
  // one line that the handoff itself logged. The expensive half (hashing the
  // prefix) explicitly comes before and runs as a stream.
  private truncateSync(bytes: number): DiscardResult {
    const size = fs.statSync(this.filePath).size;
    // Between the check and here the file can only have GROWN.
    if (size < bytes) return { ok: false, reason: "too-short" };
    // An empty prefix is allowed (the caller fetched nothing), but there is
    // nothing to do. Without this case the file would be copied completely
    // once, only to look exactly the same at the end — and SYNCHRONOUSLY.
    if (bytes === 0) return { ok: true, removed: 0, rest: size };

    // Temp file and rename instead of an in-place truncate: a crash midway
    // then leaves an unfinished temp file and an unchanged log — and not a
    // half-truncated log whose first line starts in the middle of a JSON
    // object.
    const temp = `${this.filePath}.archiv-${process.pid}`;
    const source = fs.openSync(this.filePath, "r");
    let target: number | null = null;
    try {
      target = fs.openSync(temp, "w");
      const buffer = Buffer.allocUnsafe(1024 * 1024);
      let position = bytes;
      while (position < size) {
        const loaded = fs.readSync(source, buffer, 0, Math.min(buffer.length, size - position), position);
        if (loaded === 0) break;
        let written = 0;
        while (written < loaded) {
          written += fs.writeSync(target, buffer, written, loaded - written);
        }
        position += loaded;
      }
      // First to disk, then rename. Otherwise a power failure can leave behind
      // a log that carries the old file's name and is empty.
      fs.fsyncSync(target);
    } catch (failure) {
      if (target !== null) fs.closeSync(target);
      target = null;
      try {
        fs.unlinkSync(temp);
      } catch {
        // Leaving the temp file behind is the lesser evil; the actual error
        // propagates right away.
      }
      throw failure;
    } finally {
      fs.closeSync(source);
      if (target !== null) fs.closeSync(target);
    }
    fs.renameSync(temp, this.filePath);
    return { ok: true, removed: bytes, rest: size - bytes };
  }

  private append(record: Record<string, unknown>): void {
    // "a" = append. No read-modify-write, so that parallel actions do not
    // overwrite each other.
    //
    // Errors are deliberately NOT swallowed: they propagate up into the
    // request handler and become a 500 there. Better a visibly failed action
    // than an unlogged one.
    fs.appendFileSync(this.filePath, JSON.stringify(record) + "\n", "utf8");
  }
}
