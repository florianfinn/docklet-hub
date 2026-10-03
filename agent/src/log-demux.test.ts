import assert from "node:assert/strict";
import test from "node:test";
import {
  LogDemuxer,
  LogStreamLimitError,
  MAX_LOG_FRAME_BYTES,
  MAX_LOG_LINE_CHARS,
  parseFrames,
  renderDemuxedLines,
  splitTimestamp
} from "./log-demux.js";

// Builds a single Docker multiplex frame: 1 byte stream id, 3 bytes unused,
// 4 bytes length (big-endian), then the payload.
function frame(streamType: number, text: string): Buffer {
  const payload = Buffer.from(text, "utf8");
  const header = Buffer.alloc(8);
  header.writeUInt8(streamType, 0);
  header.writeUInt32BE(payload.length, 4);
  return Buffer.concat([header, payload]);
}

test("parseFrames splits several complete frames", () => {
  const buffer = Buffer.concat([frame(1, "hallo\n"), frame(2, "error\n")]);
  const { frames, rest } = parseFrames(buffer);
  assert.equal(frames.length, 2);
  assert.equal(frames[0].streamType, 1);
  assert.equal(frames[0].payload.toString("utf8"), "hallo\n");
  assert.equal(frames[1].streamType, 2);
  assert.equal(rest.length, 0);
});

test("parseFrames leaves a partial frame in the rest", () => {
  const full = frame(1, "hallo\n");
  const partialFrame = full.subarray(0, full.length - 2);
  const { frames, rest } = parseFrames(partialFrame);
  assert.equal(frames.length, 0);
  assert.equal(rest.length, partialFrame.length);
});

test("parseFrames leaves a partial header in the rest", () => {
  const { frames, rest } = parseFrames(Buffer.from([1, 0, 0, 0]));
  assert.equal(frames.length, 0);
  assert.equal(rest.length, 4);
});

test("parseFrames rejects oversized announced frames immediately", () => {
  const header = Buffer.alloc(8);
  header.writeUInt8(1, 0);
  header.writeUInt32BE(MAX_LOG_FRAME_BYTES + 1, 4);
  assert.throws(() => parseFrames(header), LogStreamLimitError);
});

test("splitTimestamp splits off the RFC3339Nano timestamp", () => {
  const { ts, text } = splitTimestamp("2026-08-02T10:00:00.123456789Z Hallo Welt");
  assert.equal(ts, "2026-08-02T10:00:00.123456789Z");
  assert.equal(text, "Hallo Welt");
});

test("splitTimestamp leaves lines without a recognisable timestamp untouched", () => {
  const { ts, text } = splitTimestamp("keine Ahnung was das ist");
  assert.equal(ts, null);
  assert.equal(text, "keine Ahnung was das ist");
});

test("LogDemuxer separates stdout and stderr across several frames", () => {
  const demuxer = new LogDemuxer(false);
  const lines = demuxer.push(
    Buffer.concat([
      frame(1, "2026-08-02T10:00:00.000000000Z stdout-zeile\n"),
      frame(2, "2026-08-02T10:00:01.000000000Z stderr-zeile\n")
    ])
  );
  assert.deepEqual(
    lines.map((z) => [z.stream, z.text]),
    [
      ["stdout", "stdout-zeile"],
      ["stderr", "stderr-zeile"]
    ]
  );
});

test("LogDemuxer keeps a partial line together across push() calls", () => {
  const demuxer = new LogDemuxer(false);
  const payload = "2026-08-02T10:00:00.000000000Z eine lange zeile\n";
  const wholeFrame = frame(1, payload);
  const firstHalf = wholeFrame.subarray(0, 12);
  const secondHalf = wholeFrame.subarray(12);

  const firstLines = demuxer.push(firstHalf);
  assert.equal(firstLines.length, 0);

  const secondLines = demuxer.push(secondHalf);
  assert.equal(secondLines.length, 1);
  assert.equal(secondLines[0].text, "eine lange zeile");
});

test("LogDemuxer reassembles a multi-byte UTF-8 sequence correctly across chunk boundaries", () => {
  const demuxer = new LogDemuxer(false);
  const line = "2026-08-02T10:00:00.000000000Z Prüfung äöü ✓\n";
  const wholeFrame = frame(1, line);
  // Cuts in the middle of a multi-byte UTF-8 sequence ("ü" is 2 bytes).
  const cut = wholeFrame.length - 5;

  const first = demuxer.push(wholeFrame.subarray(0, cut));
  const second = demuxer.push(wholeFrame.subarray(cut));
  assert.equal(first.length, 0);
  assert.equal(second.length, 1);
  assert.equal(second[0].text, "Prüfung äöü ✓");
});

test("LogDemuxer.flush delivers a line without a trailing line break", () => {
  const demuxer = new LogDemuxer(false);
  demuxer.push(frame(1, "2026-08-02T10:00:00.000000000Z ohne umbruch"));
  const beforeFlush = demuxer.flush.bind(demuxer);
  const lines = beforeFlush();
  assert.equal(lines.length, 1);
  assert.equal(lines[0].text, "ohne umbruch");
  assert.equal(lines[0].stream, "stdout");
});

test("LogDemuxer in TTY mode reads the raw stream without frames as stdout", () => {
  const demuxer = new LogDemuxer(true);
  const lines = demuxer.push(Buffer.from("2026-08-02T10:00:00.000000000Z tty-zeile\n", "utf8"));
  assert.equal(lines.length, 1);
  assert.equal(lines[0].stream, "stdout");
  assert.equal(lines[0].text, "tty-zeile");
});

test("LogDemuxer limits lines even without a trailing line break", () => {
  const demuxer = new LogDemuxer(true);
  assert.throws(
    () => demuxer.push(Buffer.alloc(MAX_LOG_LINE_CHARS + 1, "a")),
    LogStreamLimitError
  );
});

test("LogDemuxer keeps stdout and stderr apart in arrival order", () => {
  const demuxer = new LogDemuxer(false);
  const lines = demuxer.push(
    Buffer.concat([
      frame(1, "a\n"),
      frame(2, "b\n"),
      frame(1, "c\n"),
      frame(2, "d\n")
    ])
  );
  assert.deepEqual(
    lines.map((z) => z.text),
    ["a", "b", "c", "d"]
  );
});

// --- renderDemuxedLines: the one-off text snapshot (engine.logs()) ---------
//
// Unlike the live stream, `engine.logs()` only wants readable TEXT — the same
// shape that `timestamps=1` used to deliver in the raw text (broken, with frame
// garbage). No new scope, no new format for the existing callers (the plain
// text snapshot and the 25-line attachment on the guided update) — just
// without the control bytes.

test("renderDemuxedLines puts the timestamp back in front of the text", () => {
  const text = renderDemuxedLines([
    { stream: "stdout", ts: "2026-08-02T10:00:00.000000000Z", text: "hallo" },
    { stream: "stderr", ts: "2026-08-02T10:00:01.000000000Z", text: "welt" }
  ]);
  assert.equal(text, "2026-08-02T10:00:00.000000000Z hallo\n2026-08-02T10:00:01.000000000Z welt");
});

test("renderDemuxedLines leaves lines without a timestamp untouched", () => {
  assert.equal(renderDemuxedLines([{ stream: "stdout", ts: null, text: "ohne stempel" }]), "ohne stempel");
});

test("renderDemuxedLines on an empty list yields empty text", () => {
  assert.equal(renderDemuxedLines([]), "");
});

// --- The actual bug proof: a one-off snapshot (no `follow`) ---------------
//
// Exactly the scenario from the finding: `engine.logs()` reads the WHOLE buffer
// in one go (no chunking as with the live stream) — a `push()` on the complete
// frame buffer, followed by `flush()` for a last line without a trailing line
// break, still has to separate stdout/stderr cleanly and leave no frame bytes
// in the text.

test("a one-off snapshot (push + flush on the whole buffer) stays clean", () => {
  const demuxer = new LogDemuxer(false);
  const buffer = Buffer.concat([
    frame(1, "2026-08-02T10:00:00.000000000Z Server gestartet\n"),
    frame(2, "2026-08-02T10:00:01.000000000Z Warnung: Konfiguration fehlt\n"),
    frame(1, "2026-08-02T10:00:02.000000000Z bereit, wartet ohne Zeilenumbruch")
  ]);

  const lines = [...demuxer.push(buffer), ...demuxer.flush()];
  const text = renderDemuxedLines(lines);

  // No frame control bytes (the three null bytes of the header) may
  // appear in the assembled text — that was exactly the finding: a
  // naive text access to the raw buffer left them standing between the
  // lines.
  assert.ok(!Buffer.from(text, "utf8").includes(0));
  assert.deepEqual(
    lines.map((z) => [z.stream, z.text]),
    [
      ["stdout", "Server gestartet"],
      ["stderr", "Warnung: Konfiguration fehlt"],
      ["stdout", "bereit, wartet ohne Zeilenumbruch"]
    ]
  );
  assert.equal(
    text,
    "2026-08-02T10:00:00.000000000Z Server gestartet\n" +
      "2026-08-02T10:00:01.000000000Z Warnung: Konfiguration fehlt\n" +
      "2026-08-02T10:00:02.000000000Z bereit, wartet ohne Zeilenumbruch"
  );
});

test("TTY container: the same one-off snapshot without frames, one stream", () => {
  const demuxer = new LogDemuxer(true);
  const buffer = Buffer.from(
    "2026-08-02T10:00:00.000000000Z Zeile eins\n2026-08-02T10:00:01.000000000Z Zeile zwei\n",
    "utf8"
  );
  const lines = [...demuxer.push(buffer), ...demuxer.flush()];
  assert.deepEqual(
    lines.map((z) => z.stream),
    ["stdout", "stdout"]
  );
  assert.equal(
    renderDemuxedLines(lines),
    "2026-08-02T10:00:00.000000000Z Zeile eins\n2026-08-02T10:00:01.000000000Z Zeile zwei"
  );
});
