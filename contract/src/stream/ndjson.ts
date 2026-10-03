// The one NDJSON reader, used by the server (agent streams) and the web
// (hub streams). Until #252 both sides carried their own copy, each with its
// own `MAX_LINE_CHARS` and a guard holding the two numbers together.
//
// ⚠️ RUNTIME CODE IN `contract/` IS A BOUNDED EXCEPTION
// (docs/design/feature-architecture.md, section 5): this reader implements the
// wire format the contract describes and needs nothing but Web Streams. It
// therefore types the stream, the signal and the decoder structurally — the
// package loads neither the DOM nor the Node typings (`tsconfig.json`).
//
// Six special cases, each of which was wrong once in one of the old copies:
//
//   1. An envelope across TWO chunks. A chunk is not a line; without the rest
//      up to the next `\n` it would be broken JSON twice.
//   2. A multi-byte character ON the chunk boundary. Decoding per chunk turns a
//      split "ß" into two replacement characters for good. Hence ONE decoder
//      with `{ stream: true }` for the whole run.
//   3. An unparsable line. It is dropped and the stream goes on: taking the
//      whole running stream away because one line got mangled is the harder
//      answer to the smaller problem.
//   4. Cancellation by the caller. It is the NORMAL case (the page was left)
//      and ends quietly, also while `onEvent` is still waiting.
//   5. A line without `\n` that never ends (#131, finding 15 of #117: a 1 MiB
//      line came through whole). Its rest is dropped instead of buffered.
//   6. `\r\n` line endings. The `\r` belongs to the separator, not the line.
//
// The reader knows NO event kind. `kind` values belong to the streams that
// send them; whoever handles one here pulls one stream's knowledge into the
// reader of all others.

/**
 * How long a single line may be (without its line ending) before it is dropped.
 *
 * ⚠️ THE CAP IS MANDATORY (#131). Without it the hub's memory, and the tab's,
 * would be bounded by the other side: an agent losing a `\n` or a proxy
 * swallowing one fills the buffer until the stream ends.
 *
 * ⚠️ WHY 256 KiB. It is the largest cap this traffic already carries,
 * `MAX_COMPOSE_BYTES` (`contract/src/agent/limits.ts`); no line of the
 * protocol is longer. Both sides read with the same number by construction —
 * the hub builds its envelopes from what the agent sends, so a lower cap in
 * the web would drop lines the server has just let through.
 *
 * ⚠️ CHARACTERS, NOT BYTES: string length in UTF-16 units. An umlaut counts
 * once and weighs two bytes. The cap bounds growth; it promises no byte size.
 */
export const NDJSON_MAX_LINE_CHARS = 256 * 1024;

/**
 * How many characters the reader holds between two chunks — the unfinished
 * line. It never holds more, whatever the other side sends.
 *
 * One more than a line: a line exactly at `NDJSON_MAX_LINE_CHARS` may still be
 * waiting for the `\n` after its `\r`. Complete lines are not buffered at all;
 * they go to `onEvent` straight from the chunk.
 */
export const NDJSON_MAX_BUFFERED_CHARS = NDJSON_MAX_LINE_CHARS + 1;

/** The part of `ReadableStreamDefaultReader<Uint8Array>` the reader uses. */
export type NdjsonByteReader = {
  read(): Promise<{ done: boolean; value?: Uint8Array }>;
  cancel(reason?: unknown): Promise<void>;
};

/** The part of `ReadableStream<Uint8Array>` the reader uses. */
export type NdjsonByteStream = {
  getReader(): NdjsonByteReader;
};

/** The part of `AbortSignal` the reader uses. */
export type NdjsonAbortSignal = {
  readonly aborted: boolean;
  readonly reason?: unknown;
  addEventListener(type: "abort", listener: () => void): void;
  removeEventListener(type: "abort", listener: () => void): void;
};

export type NdjsonReadOptions = {
  /** The caller's cancellation path. */
  signal: NdjsonAbortSignal;
};

/** One parsed line: a JSON object, nothing else. */
export type NdjsonEvent = Record<string, unknown>;

type Utf8Decoder = { decode(input?: Uint8Array, options?: { stream?: boolean }): string };

// ⚠️ READ FROM `globalThis` AND NOT DECLARED GLOBALLY. A `declare global` here
// would collide with the DOM and Node declarations of the consumers; Node and
// every browser provide `TextDecoder`.
const Utf8DecoderClass = (globalThis as unknown as { TextDecoder: new (label: string) => Utf8Decoder })
  .TextDecoder;

/**
 * Is this error the caller's cancellation?
 *
 * ⚠️ Checks BOTH the signal and the error's name: a body that breaks off with
 * a network error instead of an `AbortError` at cancellation (Node and the
 * browser report either, depending on timing) is the same event.
 */
export function isAbort(signal: NdjsonAbortSignal, error: unknown): boolean {
  if (signal.aborted) return true;
  return error instanceof Error && error.name === "AbortError";
}

/**
 * Reads an NDJSON body and calls back once per envelope.
 *
 * ⚠️ NO RETURN VALUE AND NO COLLECTION. `onEvent` runs as soon as the line is
 * there; a stream that is read to the end first is none.
 *
 * ⚠️ WHAT IS NO OBJECT IS SKIPPED. A number or an array is valid JSON but no
 * envelope; letting it through would make every caller repeat the test.
 *
 * ⚠️ AN `onEvent` RETURNING A PROMISE IS AWAITED — the backpressure hangs on
 * it (#131). The server hands each line to a browser whose output buffer may
 * be full; its waiting slows the reading here and, through TCP, the agent.
 *
 * ⚠️ CANCELLATION ENDS THE READER WITHOUT A HANGING PROMISE. An abort cancels
 * the stream's reader, which settles a pending `read()`, and stops waiting for
 * an `onEvent` that may never settle (a write to a closed browser). After the
 * abort no further event is delivered.
 */
export async function readNdjson(
  body: NdjsonByteStream,
  options: NdjsonReadOptions,
  onEvent: (event: NdjsonEvent) => void | Promise<void>
): Promise<void> {
  const { signal } = options;
  const decoder = new Utf8DecoderClass("utf-8");
  const reader = body.getReader();
  // The unfinished line, at most `NDJSON_MAX_BUFFERED_CHARS` long.
  let pending = "";
  // Is an oversized line running? Then everything up to the next `\n` is
  // dropped. ⚠️ Dropping the WHOLE rest, not only the first overflow: a line
  // over many chunks would otherwise grow back to the cap right away.
  let discarding = false;

  // Settles on abort, so that an `onEvent` that never settles cannot hold the
  // reader. Resolved by `onAbort` only; the listener goes in `finally`.
  let settleAbort = (): void => undefined;
  const abortWait = new Promise<void>((resolve) => {
    settleAbort = resolve;
  });
  const onAbort = (): void => {
    settleAbort();
    void reader.cancel(signal.reason).catch(() => undefined);
  };

  const deliver = async (rawLine: string): Promise<void> => {
    if (signal.aborted) return;
    const line = rawLine.endsWith("\r") ? rawLine.slice(0, -1) : rawLine;
    // ⚠️ THE COMPLETE OVERSIZED LINE IS DROPPED HERE. The buffer check in
    // `keep` only sees a rest without `\n`; a line arriving with its `\n` in
    // ONE chunk would pass it.
    if (line === "" || line.length > NDJSON_MAX_LINE_CHARS) return;
    let event: unknown;
    try {
      event = JSON.parse(line);
    } catch {
      return;
    }
    if (typeof event !== "object" || event === null || Array.isArray(event)) return;
    const result = onEvent(event as NdjsonEvent);
    if (result) await Promise.race([result, abortWait]);
  };

  /** Holds the rest of a chunk without `\n` — or drops it, past the cap. */
  const keep = (rest: string): void => {
    if (discarding || rest === "") return;
    if (pending.length + rest.length > NDJSON_MAX_BUFFERED_CHARS) {
      discarding = true;
      pending = "";
      return;
    }
    pending += rest;
  };

  /** Delivers every complete line in `text` and keeps the rest. */
  const consume = async (text: string): Promise<void> => {
    let start = 0;
    for (;;) {
      if (signal.aborted) return;
      const index = text.indexOf("\n", start);
      if (index < 0) break;
      const piece = text.slice(start, index);
      start = index + 1;
      if (discarding) {
        discarding = false;
        continue;
      }
      // Checked before joining: a huge piece is dropped without a copy.
      const fits = pending.length + piece.length <= NDJSON_MAX_BUFFERED_CHARS;
      const line = fits ? pending + piece : "";
      pending = "";
      if (fits) await deliver(line);
    }
    keep(text.slice(start));
  };

  if (signal.aborted) {
    await reader.cancel(signal.reason).catch(() => undefined);
    return;
  }
  signal.addEventListener("abort", onAbort);
  try {
    while (!signal.aborted) {
      const { done, value } = await reader.read();
      if (done || signal.aborted) break;
      if (value) await consume(decoder.decode(value, { stream: true }));
    }
    if (signal.aborted) return;
    // ⚠️ THE LAST LINE WITHOUT A CLOSING `\n`. `decode()` without input flushes
    // the decoder; the rest is a line like any other — complete JSON goes
    // through, a half line falls away in `deliver`, an oversized one in
    // `keep`. Dropping it wholesale would lose the last line of a container
    // that is just ending.
    await consume(decoder.decode());
    if (!discarding && pending !== "") await deliver(pending);
  } catch (error) {
    if (isAbort(signal, error)) return;
    throw error;
  } finally {
    signal.removeEventListener("abort", onAbort);
    // Releases the connection when `onEvent` threw. After a regular end it is
    // a no-op, after a cancel an already closed stream — neither may throw.
    await reader.cancel().catch(() => undefined);
  }
}
