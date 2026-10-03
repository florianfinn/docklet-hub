import test from "node:test";
import assert from "node:assert/strict";

import {
  call,
  envelopes,
  openShell,
  readAll,
  ROW_SECRET,
  shortUrl,
  startAgent,
  startHub
} from "./exec-test-support.js";

// DIE DREI KURZEN ROUTEN der Shell-Fläche (Paket B6, Etappe E3, #5):
// `…/exec/:session/input`, `…/size` und `…/close`.
//
// ⚠️ EINE EIGENE DATEI UND KEIN ANHANG AN `exec-routes.test.ts`. Der Schnitt
// ist nicht kosmetisch: jene Datei stand mit beiden Hälften bei 1075 Zeilen und
// damit über der Marke von 1000 (`web/tests/source-file-size.test.mjs`). Der
// Schnitt folgt derselben Fachlichkeit wie im Erzeugnis — der Strom öffnet eine
// Sitzung, diese drei arbeiten auf einer bestehenden. Der gemeinsame Prüfstand
// steht in `exec-test-support.ts`.

// ── 6. Die Eingabe ─────────────────────────────────────────────────────────

test("ein ß und ein Steuerzeichen kommen als w58D beim Arm an", async () => {
  // ⚠️ DER FALL, DER DIE KODIERUNG FESTNAGELT. `ß` ist `0xC3 0x9F`, Strg-C ist
  // `0x03`; zusammen sind das die drei Bytes `C3 9F 03` und damit genau vier
  // base64-Zeichen. Der erwartete Wert steht als LITERAL da und nicht als
  // Rechnung: eine Rechnung im Test wäre dieselbe Rechnung wie im Erzeugnis und
  // ginge mit ihr gemeinsam falsch.
  //
  // Klartext an dieser Stelle tippte Zeichensalat in den Container. Bei einem
  // `ls` fiele es nicht auf, bei einem `ß` oder einem Strg-C sofort.
  const agent = await startAgent();
  const hub = await startHub({ agent });
  try {
    const shell = await openShell(hub, agent);
    const response = await call(shortUrl(hub, shell.session, "input"), { body: { data: "w58D" } });
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { ok: true });

    const input = agent.seen.find((entry) => entry.url.endsWith("/input"));
    assert.equal(input?.method, "POST");
    // Die Sitzungs-Id DES AGENTEN steht im Pfad zum Agenten — und nur dort.
    assert.equal(input?.url, `/exec/${shell.agentSession}/input`);
    assert.deepEqual(JSON.parse(input?.body ?? "{}"), { data: "w58D" });
    assert.equal(input?.actor, "user:admin-1");
    assert.equal(input?.secret, ROW_SECRET);
    shell.controller.abort();
  } finally {
    await hub.close();
    await agent.close();
  }
});

const BAD_INPUTS: { label: string; body: unknown }[] = [
  { label: "ohne Feld", body: {} },
  { label: "als Zahl", body: { data: 7 } },
  { label: "als null", body: { data: null } },
  { label: "leer", body: { data: "" } },
  { label: "fremde Zeichen", body: { data: "!!!!" } },
  { label: "Länge nicht durch vier teilbar", body: { data: "w58" } },
  { label: "nicht kanonisch gefüllt", body: { data: "w58D=" } }
];

test("ein Rumpf, der kein base64 trägt, ist 400 invalid-input und keine leere Eingabe", async () => {
  // ⚠️ DER FEHLER, DEN NIEMAND FINDET, wenn man ihn durchlässt: der Betreiber
  // tippt, es kommt eine `200`, im Container passiert nichts, und keine Zeile
  // irgendwo sagt warum. `Buffer.from(x, "base64")` prüft von sich aus NICHTS —
  // für `"!!!!"` liefert es einen leeren Puffer statt eines Fehlers.
  const agent = await startAgent();
  const hub = await startHub({ agent });
  try {
    const shell = await openShell(hub, agent);
    for (const bad of BAD_INPUTS) {
      const response = await call(shortUrl(hub, shell.session, "input"), { body: bad.body });
      assert.equal(response.status, 400, `${bad.label}: Status`);
      assert.equal(((await response.json()) as { error: string }).error, "invalid-input", `${bad.label}: Kennung`);
    }
    assert.deepEqual(
      agent.seen.filter((entry) => entry.url.endsWith("/input")),
      [],
      "ein ungültiger Rumpf wurde trotzdem an den Arm geschickt"
    );
    shell.controller.abort();
  } finally {
    await hub.close();
    await agent.close();
  }
});

const SHORT_ROUTE_CASES: { key: string; agentStatus: number; status: number; error: string }[] = [
  { key: "input-too-large", agentStatus: 413, status: 413, error: "input-too-large" },
  { key: "agent-read-only", agentStatus: 503, status: 503, error: "agent-read-only" },
  { key: "session-unknown", agentStatus: 404, status: 404, error: "session-unknown" }
];

test("die Ablehnungen der kurzen Routen werden übersetzt", async () => {
  const agent = await startAgent();
  const hub = await startHub({ agent });
  try {
    const shell = await openShell(hub, agent);
    for (const testCase of SHORT_ROUTE_CASES) {
      agent.short.set("input", { status: testCase.agentStatus, body: { error: testCase.key } });
      const response = await call(shortUrl(hub, shell.session, "input"), { body: { data: "AA==" } });
      const body = (await response.json()) as { error: string };
      assert.equal(response.status, testCase.status, `${testCase.key}: Status`);
      assert.equal(body.error, testCase.error, `${testCase.key}: Kennung`);
    }
    shell.controller.abort();
  } finally {
    await hub.close();
    await agent.close();
  }
});

// ── 7. Die Fenstergröße ────────────────────────────────────────────────────

test("die Größe geht über readTerminalSize an den Arm und wird nicht geklemmt", async () => {
  // ⚠️ NICHT GEKLEMMT: der Agent klemmt selbst auf 8…500 × 4…300
  // (`exec-protokoll.md` §4). Eine Klemme hier wäre die zweite Wahrheit über
  // eine fremde Grenze und würde still falsch, sobald er seine Zahlen ändert.
  const agent = await startAgent();
  const hub = await startHub({ agent });
  try {
    const shell = await openShell(hub, agent);

    const bad = await call(shortUrl(hub, shell.session, "size"), { body: { cols: "x", rows: 40 } });
    assert.equal(bad.status, 200);
    const first = agent.seen.filter((entry) => entry.url.endsWith("/size")).at(-1);
    assert.equal(first?.url, `/exec/${shell.agentSession}/size`);
    assert.deepEqual(JSON.parse(first?.body ?? "{}"), { cols: 80, rows: 40 });

    const huge = await call(shortUrl(hub, shell.session, "size"), { body: { cols: 9000, rows: 1.9 } });
    assert.equal(huge.status, 200, "eine zu große Größe darf mitten im Tippen kein 400 ergeben");
    const second = agent.seen.filter((entry) => entry.url.endsWith("/size")).at(-1);
    assert.deepEqual(JSON.parse(second?.body ?? "{}"), { cols: 9000, rows: 1 });

    shell.controller.abort();
  } finally {
    await hub.close();
    await agent.close();
  }
});

// ── 8. Das Schließen und sein Kill-Switch-Unterschied ──────────────────────

test("close schließt, entfernt den Eintrag und beendet den eigenen Strom", async () => {
  const agent = await startAgent();
  const hub = await startHub({ agent });
  try {
    const shell = await openShell(hub, agent);

    const response = await call(shortUrl(hub, shell.session, "close"));
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { ok: true });
    const closed = agent.seen.find((entry) => entry.url.endsWith("/close"));
    assert.equal(closed?.url, `/exec/${shell.agentSession}/close`);

    // Der eigene Strom endet mit — sonst liefe die Ausgabe weiter in eine
    // Verbindung, für die niemand mehr Buch führt. Der Grund sagt, dass die
    // Shell auf Auftrag zu ist und nicht gerissen (#173) — der Browser hört
    // hier noch zu.
    const rest = await readAll(shell.reader);
    assert.deepEqual(envelopes(rest), [{ kind: "error", reason: "session-closed" }]);

    // Und der Eintrag ist weg: ein zweites Schließen findet nichts mehr.
    const again = await call(shortUrl(hub, shell.session, "close"));
    assert.equal(again.status, 404);
    assert.equal(((await again.json()) as { error: string }).error, "session-unknown");
  } finally {
    await hub.close();
    await agent.close();
  }
});

test("close antwortet 200, auch wenn der Arm den Aufruf ablehnt", async () => {
  // ⚠️ DER GEMESSENE UNTERSCHIED. Beim Agenten trifft der Kill-Switch `input`
  // und `size`, NICHT `close` (`exec-protokoll.md` §3). Steht `close` im Hub
  // hinter derselben Sperre wie die anderen drei, entstehen Shells, die man
  // nicht mehr loswird — sie zählen gegen die eigene Grenze, und der Betreiber
  // kommt nicht mehr an sie heran.
  const agent = await startAgent();
  const hub = await startHub({ agent });
  try {
    const shell = await openShell(hub, agent);
    agent.short.set("close", { status: 503, body: { error: "agent-read-only" } });

    const response = await call(shortUrl(hub, shell.session, "close"));
    assert.equal(response.status, 200, "ein gescheiterter Aufruf am Arm darf close nicht scheitern lassen");
    assert.deepEqual(await response.json(), { ok: true });

    const again = await call(shortUrl(hub, shell.session, "close"));
    assert.equal(again.status, 404, "der Eintrag blieb trotz close stehen");
  } finally {
    await hub.close();
    await agent.close();
  }
});

test("close antwortet 200, auch wenn der Arm inzwischen aus dem Bestand ist", async () => {
  const agent = await startAgent();
  const hub = await startHub({ agent });
  try {
    const shell = await openShell(hub, agent);
    // Der Betreiber hat den Arm entfernt, während die Shell offen war.
    hub.arm.record = null;

    const response = await call(shortUrl(hub, shell.session, "close"));
    assert.equal(response.status, 200);
    assert.deepEqual(
      agent.seen.filter((entry) => entry.url.endsWith("/close")),
      [],
      "es gibt keinen Arm mehr zu fragen — gefragt wurde trotzdem"
    );
  } finally {
    await hub.close();
    await agent.close();
  }
});

test("input und size lehnen ab, wenn der Arm aus dem Bestand ist", async () => {
  // ⚠️ Anders als `close`, und das ist der Punkt: tippen kann man in eine
  // Shell auf einem Arm, den es nicht mehr gibt, nicht — schließen schon.
  const agent = await startAgent();
  const hub = await startHub({ agent });
  try {
    const shell = await openShell(hub, agent);
    hub.arm.record = null;

    for (const tail of ["input", "size"] as const) {
      const response = await call(shortUrl(hub, shell.session, tail), { body: { data: "AA==", cols: 80, rows: 24 } });
      assert.equal(response.status, 404, `${tail}: Status`);
      assert.equal(((await response.json()) as { error: string }).error, "session-unknown", `${tail}: Kennung`);
    }
    shell.controller.abort();
  } finally {
    await hub.close();
    await agent.close();
  }
});

// ── 9. `session-unknown` fasst vier Lagen zu EINER Antwort zusammen ────────

test("eine unbekannte, eine fremde und eine falsch adressierte Sitzung sind dieselbe Antwort", async () => {
  // ⚠️ KEIN SAMMELBECKEN, SONDERN GESPIEGELT VOM AGENTEN
  // (`exec-protokoll.md` §3): über unterschiedliche Antworten ließen sich
  // gültige Sitzungs-Ids bestätigen. Der Wortlaut wird deshalb MITGEPRÜFT —
  // eine der vier Lagen mit einem eigenen Satz zu beantworten hübe die Sperre
  // auf, ohne dass eine Kennung sich ändert.
  const agent = await startAgent();
  const hub = await startHub({ agent });
  try {
    const shell = await openShell(hub, agent);
    const answers: { status: number; body: unknown }[] = [];

    for (const target of [
      // 1. Eine Id, die es nie gab.
      shortUrl(hub, "a".repeat(64), "input"),
      // 2. Die eigene Id, aber ein anderer Arm im Pfad.
      shortUrl(hub, shell.session, "input", "host-2"),
      // 3. Die eigene Id, aber ein anderer Container im Pfad.
      shortUrl(hub, shell.session, "input", "host-1", "anderer")
    ]) {
      const response = await call(target, { body: { data: "AA==" } });
      answers.push({ status: response.status, body: await response.json() });
    }

    // 4. Die Sitzung von Mensch A, aufgerufen von Mensch B.
    const foreign = await call(shortUrl(hub, shell.session, "input"), {
      role: "admin-2",
      body: { data: "AA==" }
    });
    answers.push({ status: foreign.status, body: await foreign.json() });

    assert.equal(answers.length, 4);
    for (const answer of answers) {
      assert.equal(answer.status, 404);
      assert.deepEqual(answer.body, answers[0]?.body, "eine der vier Lagen antwortet anders als die übrigen");
    }
    assert.equal((answers[0]?.body as { error: string }).error, "session-unknown");
    shell.controller.abort();
  } finally {
    await hub.close();
    await agent.close();
  }
});

test("ein Benutzer ohne Adminrechte kommt an keine der drei kurzen Routen", async () => {
  // Der Verhaltensfall zur Stellung von `requireAdmin` an den kurzen Routen.
  // Verrutscht die Schicht, meldet er `200 !== 403` — bei `close` sogar an
  // einer Route, die aus Vorsatz alles quittiert.
  const agent = await startAgent();
  const hub = await startHub({ agent });
  try {
    const shell = await openShell(hub, agent);
    for (const tail of ["input", "size", "close"] as const) {
      const response = await call(shortUrl(hub, shell.session, tail), {
        role: "user",
        body: { data: "AA==", cols: 80, rows: 24 }
      });
      assert.equal(response.status, 403, `${tail}: Status`);
      assert.equal(((await response.json()) as { error: string }).error, "admin-required", `${tail}: Kennung`);
    }
    shell.controller.abort();
  } finally {
    await hub.close();
    await agent.close();
  }
});
