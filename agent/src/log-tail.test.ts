import assert from "node:assert/strict";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { logFileQuerySchema, logsSnapshotQuerySchema, logsStreamQuerySchema } from "contract";

import { DockerEngine } from "./engine.js";
import {
  DEFAULT_LOG_TAIL_LINES,
  MAX_LOG_TAIL_LINES,
  resolveLogTail
} from "./log-tail.js";
import { handlerSource } from "./handler-source-test-support.js";

// Vorgang #81. Vor diesen Tests gab es KEINEN Lauf, der `tail=0` an den vier
// Log-Wegen unterschieden hätte: die Rechnung stand viermal wörtlich da, drei
// Kopien trugen den Nullfall und die vierte nicht — und kein Test hätte
// gemeldet, wenn eine der drei ihn beim Zusammenziehen verloren hätte. Genau
// diese stille Klasse nageln die Fälle hier fest, in beide Richtungen.

const ONLY_NEW_LINES = { zeroMeansNoHistory: true } as const;
const SNAPSHOT = { zeroMeansNoHistory: false } as const;

// --- Die Rechnung selbst -----------------------------------------------

test("die beiden Marken stehen als Zahlen da, nicht in einem Ausdruck", () => {
  // Ein Abgleichsskript liest sie; klaubte es sie aus einem Ausdruck, würde
  // es beim nächsten Umbau still etwas anderes lesen.
  assert.equal(MAX_LOG_TAIL_LINES, 2000);
  assert.equal(DEFAULT_LOG_TAIL_LINES, 200);
});

test("tail=0 heißt an den drei Strömen: keine Vergangenheit", () => {
  // Der S15-Alarmstrom. Fällt dieser Fall auf 200, meldet jeder planmäßige
  // Reconnect dieselben alten Treffer ein zweites Mal.
  assert.equal(resolveLogTail(0, ONLY_NEW_LINES), 0);
});

test("tail=0 heißt am Text-Abzug: der gewohnte Ausschnitt", () => {
  // Bestand vor #81, hier bewusst festgehalten: ohne `follow=1` wäre eine
  // Null eine leere Antwort und keine Zusage auf neue Zeilen.
  assert.equal(resolveLogTail(0, SNAPSHOT), DEFAULT_LOG_TAIL_LINES);
});

test("die beiden Wege unterscheiden sich NUR in der Null", () => {
  for (const tail of [1, 25, 199, 200, 201, 1999, 2000, 2001, -1, 1.5, Number.NaN]) {
    assert.equal(
      resolveLogTail(tail, ONLY_NEW_LINES),
      resolveLogTail(tail, SNAPSHOT),
      `tail=${tail} darf auf beiden Wegen nicht auseinanderlaufen`
    );
  }
});

test("über dem Deckel wird gekappt, darunter durchgereicht", () => {
  assert.equal(resolveLogTail(2001, ONLY_NEW_LINES), 2000);
  assert.equal(resolveLogTail(1_000_000, SNAPSHOT), 2000);
  assert.equal(resolveLogTail(2000, ONLY_NEW_LINES), 2000);
  assert.equal(resolveLogTail(25, SNAPSHOT), 25);
});

test("was kein Ausschnitt ist, fällt auf 200", () => {
  // NaN kommt aus `Number.parseInt` bei einem Query-Parameter wie `tail=abc`.
  for (const policy of [ONLY_NEW_LINES, SNAPSHOT]) {
    assert.equal(resolveLogTail(Number.NaN, policy), 200);
    assert.equal(resolveLogTail(-1, policy), 200);
    assert.equal(resolveLogTail(-2000, policy), 200);
    assert.equal(resolveLogTail(1.5, policy), 200);
    assert.equal(resolveLogTail(Number.POSITIVE_INFINITY, policy), 200);
  }
});

test("die Rechnung ist auf ihrem eigenen Ergebnis idempotent", () => {
  // ⚠️ index.ts rechnet und gibt das ERGEBNIS an `logsStream()`, die noch
  // einmal rechnet. Solange beide Seiten mit demselben Argument rufen, darf
  // der zweite Lauf nichts mehr bewegen — sonst würde aus einer 0 eine 200.
  for (const tail of [0, 1, 25, 200, 2000, 2001, -1, 1.5, Number.NaN]) {
    const once = resolveLogTail(tail, ONLY_NEW_LINES);
    assert.equal(resolveLogTail(once, ONLY_NEW_LINES), once, `tail=${tail}`);
    const snapshotOnce = resolveLogTail(tail, SNAPSHOT);
    assert.equal(resolveLogTail(snapshotOnce, SNAPSHOT), snapshotOnce, `tail=${tail}`);
  }
});

// --- Die Aufrufstellen in engine.ts ------------------------------------
//
// Ein Test nur auf den Helfer beweist nichts über die vier Wege: das falsche
// Argument an einer Aufrufstelle sähe darin grün aus. Geprüft wird deshalb,
// was beim DAEMON ankommt — dieselbe Bauart wie der Auth-Test in
// engine.test.ts: ein winziger Server auf einem Socket bzw. einer Named Pipe.

function socketPath(name: string): string {
  return process.platform === "win32"
    ? path.join(String.raw`\\.\pipe`, `agent-logtail-${process.pid}-${name}`)
    : path.join(os.tmpdir(), `agent-logtail-${process.pid}-${name}.sock`);
}

async function seenPaths(
  name: string,
  run: (engine: DockerEngine) => Promise<void>,
  after: (cleanup: () => Promise<void>) => void
): Promise<string[]> {
  const seen: string[] = [];
  const server = http.createServer((request, response) => {
    seen.push(request.url ?? "");
    response.writeHead(200, { "content-type": "application/octet-stream" });
    response.end();
  });
  const pathname = socketPath(name);
  await new Promise<void>((done) => server.listen(pathname, done));
  after(() => new Promise<void>((done) => void server.close(() => done())));
  await run(new DockerEngine({ socketPath: pathname }));
  return seen;
}

test("der Text-Abzug schickt bei tail=0 ein tail=200 an die Engine", async (t) => {
  const seen = await seenPaths(
    "abzug-null",
    (engine) => engine.logs("abc123", 0, true).then(() => undefined),
    (cleanup) => t.after(cleanup)
  );
  assert.equal(seen.length, 1);
  assert.match(seen[0], /[?&]tail=200(&|$)/, `angefragt wurde: ${seen[0]}`);
  // Kein `follow` — genau der Grund, warum die Null hier nicht durchgereicht
  // wird.
  assert.ok(!seen[0].includes("follow=1"), seen[0]);
});

test("der Live-Strom schickt bei tail=0 auch ein tail=0", async (t) => {
  const seen = await seenPaths(
    "strom-null",
    (engine) => engine.logsStream("abc123", { tail: 0, tty: true }, () => undefined),
    (cleanup) => t.after(cleanup)
  );
  assert.equal(seen.length, 1);
  assert.match(seen[0], /[?&]tail=0(&|$)/, `angefragt wurde: ${seen[0]}`);
  assert.ok(seen[0].includes("follow=1"), seen[0]);
});

test("beide Wege kappen einen zu großen Ausschnitt auf 2000", async (t) => {
  const snapshotPaths = await seenPaths(
    "abzug-deckel",
    (engine) => engine.logs("abc123", 999_999, true).then(() => undefined),
    (cleanup) => t.after(cleanup)
  );
  assert.match(snapshotPaths[0], /[?&]tail=2000(&|$)/, snapshotPaths[0]);
  const streamPaths = await seenPaths(
    "strom-deckel",
    (engine) => engine.logsStream("abc123", { tail: 999_999, tty: true }, () => undefined),
    (cleanup) => t.after(cleanup)
  );
  assert.match(streamPaths[0], /[?&]tail=2000(&|$)/, streamPaths[0]);
});

// --- Die Aufrufstellen in den Handlern ---------------------------------
//
// Die beiden Strom-Endpunkte hängen an der gesamten HTTP-Oberfläche (Grants,
// Audit, Stream-Plätze) und werden im Vertragstest des Hubs gefahren. Seit
// #272 lesen sie `tail` über die Schemas aus `contract/` und nicht mehr über
// `resolveLogTail`: dieser Fall hält fest, welches Schema dort steht — genau
// die Stelle, an der ein Vertippen heute lautlos das Verhalten des
// S15-Alarmstroms drehte (der Abzug kennt keinen Nullfall).

test("beide Strom-Endpunkte lesen tail mit dem Nullfall", () => {
  const source = handlerSource();
  assert.match(source, /parseRequest\(logsStreamQuerySchema, queryObject\(url\)\)/);
  assert.match(source, /parseRequest\(logFileQuerySchema, queryObject\(url\)\)/);
  assert.match(source, /parseRequest\(logsSnapshotQuerySchema, queryObject\(url\)\)/);
  assert.equal(logsStreamQuerySchema.parse({ tail: "0" }).tail, 0);
  assert.equal(logFileQuerySchema.parse({ tail: "0" }).tail, 0);
  assert.equal(logsSnapshotQuerySchema.safeParse({ tail: "0" }).success, false);
  assert.equal(logsStreamQuerySchema.parse({}).tail, DEFAULT_LOG_TAIL_LINES);
  assert.equal(logsStreamQuerySchema.safeParse({ tail: String(MAX_LOG_TAIL_LINES + 1) }).success, false);
});
