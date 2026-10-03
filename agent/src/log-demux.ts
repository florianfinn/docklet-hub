// Demultiplexing of the Docker log stream (S6, CONTAINER_ETAPPENPLAN_LOCAL §12.4).
//
// Without a TTY Docker multiplexes stdout/stderr into a single byte stream:
// every payload is preceded by an 8-byte frame (1 byte stream id, 3 bytes
// unused, 4 bytes length, big-endian). A call that treats this raw stream as
// text (like the previous `logs()` fetch in engine.ts) gets control bytes
// between the lines and cannot separate stdout from stderr — exactly the
// finding from §12.2 point 3 that this module fixes.
//
// With a TTY (Config.Tty=true) Docker does NOT multiplex: the container then
// considers itself a terminal, there is only one raw stream without frames —
// stdout and stderr can then no longer be told apart even at the container
// itself.
//
// Separated as everywhere in this module (see engine-model.ts, bindSourcesOf):
// PARSING a single buffer is a pure function (parseFrames), ASSEMBLING across
// chunk boundaries — neither frames nor lines end at chunk boundaries — sits
// in the stateful class LogDemuxer.

export type LogLineStream = "stdout" | "stderr";

export type DemuxedLine = {
  stream: LogLineStream;
  // The RFC3339Nano timestamp prepended by Docker (`timestamps=1`),
  // or null if the line did not carry one for whatever reason.
  ts: string | null;
  text: string;
};

type Frame = { streamType: number; payload: Buffer };

const HEADER_SIZE = 8;
export const MAX_LOG_FRAME_BYTES = 1024 * 1024;
export const MAX_LOG_LINE_CHARS = 256 * 1024;

export class LogStreamLimitError extends Error {
  constructor(readonly reason: "frame-too-large" | "line-too-large") {
    super(reason);
    this.name = "LogStreamLimitError";
  }
}

// Splits a buffer into as many COMPLETE frames as possible. The rest
// (a partial header or a partial payload) is returned unchanged — the caller
// prepends it to the next chunk.
export function parseFrames(buffer: Buffer): { frames: Frame[]; rest: Buffer } {
  const frames: Frame[] = [];
  let offset = 0;
  for (;;) {
    if (buffer.length - offset < HEADER_SIZE) break;
    const streamType = buffer.readUInt8(offset);
    const size = buffer.readUInt32BE(offset + 4);
    // Do not trust the 32-bit frame length advertised by the daemon. Without
    // this check an invalid frame can keep frameRest growing towards 4 GiB.
    if (size > MAX_LOG_FRAME_BYTES) throw new LogStreamLimitError("frame-too-large");
    if (buffer.length - offset < HEADER_SIZE + size) break;
    frames.push({ streamType, payload: buffer.subarray(offset + HEADER_SIZE, offset + HEADER_SIZE + size) });
    offset += HEADER_SIZE + size;
  }
  return { frames, rest: buffer.subarray(offset) };
}

// The timestamp that `timestamps=1` prepends to every line, separated from
// the actual text. `.` for the fractional seconds is optional — some
// log drivers round to full seconds.
const TS_PATTERN = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z) (.*)$/s;

export function splitTimestamp(line: string): { ts: string | null; text: string } {
  const match = TS_PATTERN.exec(line);
  if (!match) return { ts: null, text: line };
  return { ts: match[1], text: match[2] };
}

// Stateful: a `push()` can stop in the middle of a header, a payload or a
// line, the next call continues exactly there. The two streams each get
// their own `TextDecoder` with `stream: true` — a frame can end in the
// middle of a multi-byte UTF-8 sequence, and a mere
// `buffer.toString("utf8")` per chunk would permanently destroy that with
// the replacement character U+FFFD instead of appending the remaining bytes
// in the next chunk.
export class LogDemuxer {
  private frameRest = Buffer.alloc(0);
  private readonly lineRest: Record<LogLineStream, string> = { stdout: "", stderr: "" };
  private readonly decoders: Record<LogLineStream, TextDecoder> = {
    stdout: new TextDecoder("utf-8"),
    stderr: new TextDecoder("utf-8")
  };

  constructor(private readonly tty: boolean) {}

  push(chunk: Buffer): DemuxedLine[] {
    if (this.tty) {
      // Without multiplexing there is only one stream, and here it is called stdout.
      return this.appendAndEmit("stdout", chunk);
    }

    this.frameRest = Buffer.concat([this.frameRest, chunk]);
    const { frames, rest } = parseFrames(this.frameRest);
    // `subarray` shares memory with the previous `frameRest` — without the
    // copy here the WHOLE previous buffer would stay reachable as long as
    // `rest` is referenced.
    this.frameRest = Buffer.from(rest);

    const lines: DemuxedLine[] = [];
    for (const frame of frames) {
      const stream: LogLineStream = frame.streamType === 2 ? "stderr" : "stdout";
      lines.push(...this.appendAndEmit(stream, frame.payload));
    }
    return lines;
  }

  // At connection end: whatever was left without a terminating line break
  // is still a line — otherwise the last output of a container that writes
  // something without `\n` shortly before stopping would disappear.
  flush(): DemuxedLine[] {
    const lines: DemuxedLine[] = [];
    for (const stream of ["stdout", "stderr"] as const) {
      // Partial byte sequences at the end count as complete — no more chunks
      // are coming.
      const rest = this.lineRest[stream] + this.decoders[stream].decode();
      if (rest.length > 0) lines.push({ stream, ...splitTimestamp(rest) });
      this.lineRest[stream] = "";
    }
    return lines;
  }

  private appendAndEmit(stream: LogLineStream, payload: Buffer): DemuxedLine[] {
    if (payload.length === 0) return [];
    const decoded = this.decoders[stream].decode(payload, { stream: true });
    const text = this.lineRest[stream] + decoded;
    const parts = text.split("\n");
    this.lineRest[stream] = parts.pop() ?? "";
    if (
      this.lineRest[stream].length > MAX_LOG_LINE_CHARS ||
      parts.some((line) => line.length > MAX_LOG_LINE_CHARS)
    ) {
      // A container controls its log contents. Bound the unterminated-line
      // state as well as complete lines before forwarding them to Node HTTP.
      throw new LogStreamLimitError("line-too-large");
    }
    return parts.map((line) => ({ stream, ...splitTimestamp(line) }));
  }
}

// For callers that (unlike the live stream) only want readable TEXT, not
// structured lines — the one-off fetch in `engine.logs()`. Prepends the
// timestamp to the text again (the same form that `timestamps=1` previously
// delivered unstructured in the raw text), stdout and stderr deliberately
// mixed together in arrival order — the same caller could not tell them
// apart before either, as raw text.
export function renderDemuxedLines(lines: readonly DemuxedLine[]): string {
  return lines.map((line) => (line.ts ? `${line.ts} ${line.text}` : line.text)).join("\n");
}
