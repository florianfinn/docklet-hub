import test from "node:test";
import assert from "node:assert/strict";

import { EXEC_REJECTION_KEYS } from "contract";

import { EXEC_MAX_SESSIONS_PER_USER, EXEC_PERMISSION_CHECK_MS, type Scheduler } from "../features/shell/index.js";
import {
  agentStart,
  ANCIENT,
  call,
  CONTAINER_NAME,
  envelopes,
  execUrl,
  GONE,
  openShell,
  readAll,
  readUntil,
  ROW_SECRET,
  shortUrl,
  startAgent,
  startHub,
  waitFor,
  type SessionControl
} from "./exec-test-support.js";

// Die STROMROUTE der Shell-Fläche (Paket B6, Etappe E3, #5):
// `POST /hosts/:hostId/containers/:containerId/exec`.
//
// Der Prüfstand — ein echter Zuhörer als Arm, ein echter Express als Hub —
// steht in `exec-test-support.ts`, samt der Begründung, warum er echt ist. Er
// liegt dort und nicht hier, weil die drei kurzen Routen denselben brauchen
// (`exec-session-routes.test.ts`) und zwei Abschriften desselben Prüfstands
// zwei Wahrheiten wären: wer die eine um einen Fall erweitert, erweitert die
// andere nicht, und beide bleiben für sich grün.

// ── 1. Der Erfolgsweg ───────────────────────────────────────────────────────

test("der Strom reicht jede Ausgabezeile einzeln durch und endet mit „ende“", async () => {
  const agent = await startAgent();
  const hub = await startHub({ agent });
  try {
    const response = await call(execUrl(hub), { body: { cols: 120, rows: 40 } });
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("content-type"), "application/x-ndjson; charset=utf-8");
    assert.equal(response.headers.get("cache-control"), "no-store, no-transform");
    assert.equal(response.headers.get("x-accel-buffering"), "no");

    await agent.arrived;
    const reader = response.body?.getReader();
    assert.ok(reader);

    agent.push(agentStart());
    const started = await readUntil(reader, (text) => text.includes('"start"'), "die start-Zeile kam nicht an");
    const start = envelopes(started)[0];
    assert.equal(start?.kind, "start");
    assert.equal(start?.containerName, CONTAINER_NAME);
    assert.equal(typeof start?.session, "string");
    // 256 Bit hexadezimal — die Id des HUBS und nicht die des Agenten.
    assert.equal(String(start?.session).length, 64);

    agent.push(`${JSON.stringify({ kind: "output", text: "erste" })}\n`);
    await readUntil(reader, (text) => text.includes('"erste"'), "die erste Ausgabezeile kam nicht an");

    // Erst JETZT die zweite. Sie kann in keinem Puffer gelegen haben.
    agent.push(`${JSON.stringify({ kind: "output", text: "zweite" })}\n`);
    await readUntil(reader, (text) => text.includes('"zweite"'), "die zweite Ausgabezeile kam nicht an");

    agent.push(`${JSON.stringify({ kind: "end", exitCode: 0 })}\n`);
    agent.finish();
    const rest = await readAll(reader);
    assert.deepEqual(envelopes(rest), [{ kind: "end", exitCode: 0 }]);
  } finally {
    await hub.close();
    await agent.close();
  }
});

test("die Fenstergröße aus dem Rumpf geht an den Arm, ein Unsinn fällt auf 80 × 24", async () => {
  const agent = await startAgent();
  const hub = await startHub({ agent });
  try {
    const controller = new AbortController();
    const response = await call(execUrl(hub), { body: { cols: "x", rows: 40 }, signal: controller.signal });
    await agent.arrived;
    const exec = agent.seen.find((entry) => entry.url.endsWith("/exec"));
    // ⚠️ `Number("x")` wäre `NaN`, und `JSON.stringify` schriebe es als `null`
    // an den Arm. `readTerminalSize` fängt genau das ab.
    assert.deepEqual(JSON.parse(exec?.body ?? "{}"), { cols: 80, rows: 40 });
    controller.abort();
    await response.body?.cancel().catch(() => undefined);
  } finally {
    await hub.close();
    await agent.close();
  }
});

test("der Aufrufer und das Geheimnis des Arms kommen beim Agenten an", async () => {
  const agent = await startAgent();
  const hub = await startHub({ agent });
  try {
    const controller = new AbortController();
    const response = await call(execUrl(hub), { signal: controller.signal });
    await agent.arrived;
    const exec = agent.seen.find((entry) => entry.url.endsWith("/exec"));
    assert.equal(exec?.method, "POST");
    assert.equal(exec?.actor, "user:admin-1");
    assert.equal(exec?.secret, ROW_SECRET);
    controller.abort();
    await response.body?.cancel().catch(() => undefined);
  } finally {
    await hub.close();
    await agent.close();
  }
});

test("geht der Browser, kappt der Hub den Strom zum Arm", async () => {
  // ⚠️ Ohne diese Bindung belegte eine verlassene Shell einen der VIER
  // Sitzungsplätze des Arms, bis der Agent nach 30 Minuten selbst abriegelt.
  const agent = await startAgent();
  const hub = await startHub({ agent });
  try {
    const controller = new AbortController();
    const response = await call(execUrl(hub), { signal: controller.signal });
    await agent.arrived;
    const reader = response.body?.getReader();
    assert.ok(reader);
    agent.push(agentStart());
    await readUntil(reader, (text) => text.includes('"start"'), "die start-Zeile kam nicht an");

    assert.equal(agent.hungUp, 0);
    controller.abort();
    await waitFor(() => agent.hungUp === 1, "der Hub hat den Strom zum Arm nicht gekappt");
  } finally {
    await hub.close();
    await agent.close();
  }
});

// ── 2. Die Ablehnungen aus `openContainer` ──────────────────────────────────

test("ein Arm, den der Hub nicht führt, ist 404 host-unknown", async () => {
  const hub = await startHub({ host: null });
  try {
    const response = await call(execUrl(hub));
    assert.equal(response.status, 404);
    assert.equal(((await response.json()) as { error: string }).error, "host-unknown");
  } finally {
    await hub.close();
  }
});

test("ein Arm, der nicht antwortet, ist 503 host-unreachable", async () => {
  const agent = await startAgent();
  const hub = await startHub({ agent, health: GONE });
  try {
    const response = await call(execUrl(hub));
    assert.equal(response.status, 503);
    assert.equal(((await response.json()) as { error: string }).error, "host-unreachable");
    assert.deepEqual(agent.seen, [], "ein unerreichbarer Arm darf gar nicht erst gefragt werden");
  } finally {
    await hub.close();
    await agent.close();
  }
});

test("ein zu alter Arm ist 409 agent-outdated, und zwar VOR dem Agentenaufruf", async () => {
  // ⚠️ Eine Shell ist der schreibendste Zugriff dieses Hubs. Die Sperre greift
  // deshalb, und sie greift, bevor der Arm angefasst wird — eine Sperre, die
  // erst danach zieht, hat nichts gesperrt.
  const agent = await startAgent();
  const hub = await startHub({ agent, health: ANCIENT });
  try {
    const response = await call(execUrl(hub));
    assert.equal(response.status, 409);
    assert.equal(((await response.json()) as { error: string }).error, "agent-outdated");
    assert.deepEqual(agent.seen, [], "der Arm wurde trotz der Sperre gefragt");
  } finally {
    await hub.close();
    await agent.close();
  }
});

test("ein Container, den dieser Arm nicht führt, ist 404 container-unknown", async () => {
  const agent = await startAgent();
  const hub = await startHub({ agent });
  try {
    const response = await call(execUrl(hub, "host-1", "gibtesnicht"));
    assert.equal(response.status, 404);
    assert.equal(((await response.json()) as { error: string }).error, "container-unknown");
  } finally {
    await hub.close();
    await agent.close();
  }
});

// ── 3. Die Ablehnungen des Agenten, übersetzt ─────────────────────────

const AGENT_CASES: { key: string; agentStatus: number; status: number; error: string }[] = [
  { key: "unauthorized", agentStatus: 401, status: 502, error: "agent-unreachable" },
  { key: "agent-read-only", agentStatus: 503, status: 503, error: "agent-read-only" },
  { key: "not-allowlisted", agentStatus: 404, status: 403, error: "agent-forbidden" },
  { key: "container-gone", agentStatus: 404, status: 404, error: "container-unknown" },
  { key: "observe-only", agentStatus: 403, status: 403, error: "container-observe-only" },
  { key: "self-management-locked: /mnt/user/appdata", agentStatus: 403, status: 403, error: "agent-forbidden" },
  { key: "container-not-started", agentStatus: 409, status: 409, error: "container-not-running" },
  { key: "too-many-sessions", agentStatus: 429, status: 429, error: "too-many-sessions" },
  { key: "no-shell", agentStatus: 409, status: 409, error: "no-shell" },
  { key: "exec-start-failed", agentStatus: 502, status: 502, error: "agent-unreachable" }
];

test("alle Ablehnungen des Agenten werden übersetzt, nicht durchgereicht", async () => {
  // ⚠️ ÜBER DEN SCHLÜSSEL UND NICHT ÜBER DEN STATUS. Diese Tabelle enthält
  // absichtlich zwei `409`, zwei `404` und zwei `403` mit VERSCHIEDENEM
  // Ausgang — eine Abbildung nach dem Status träfe für den ersten Fall zu und
  // für die späteren nicht.
  assert.deepEqual(
    new Set(AGENT_CASES.map((testCase) => testCase.key.split(":")[0])),
    new Set(EXEC_REJECTION_KEYS)
  );
  const agent = await startAgent();
  const hub = await startHub({ agent });
  try {
    for (const testCase of AGENT_CASES) {
      agent.exec = { kind: "status", status: testCase.agentStatus, body: { error: testCase.key } };
      const response = await call(execUrl(hub));
      const body = (await response.json()) as { error: string; message: string };
      assert.equal(response.status, testCase.status, `${testCase.key}: Status`);
      assert.equal(body.error, testCase.error, `${testCase.key}: Kennung`);
      // Die Kennungen des Hubs sind seine eigenen — kein Schlüssel des
      // Agenten darf durchgereicht werden.
      //
      // ⚠️ MIT DREI BENANNTEN AUSNAHMEN, und sie sind keine Durchreichung:
      // `agent-read-only`, `too-many-sessions` und `no-shell` sind EIGENE
      // Kennungen des Hubs (`AGENT_START_REJECTIONS` in
      // `features/shell/rejections.ts`), und dass der Agent seit #278 dasselbe
      // englische Wort für dieselbe Sache benutzt, macht sie nicht zu seinen.
      // Eine Ausnahme ohne Namen wäre hier das Loch, durch das die nächste
      // echte Durchreichung ginge.
      const ownWords = new Set(["agent-read-only", "too-many-sessions", "no-shell"]);
      const passedThrough = AGENT_CASES.map((other) => other.key.split(":")[0]).filter((key) => !ownWords.has(key));
      assert.ok(
        !passedThrough.includes(body.error),
        `${testCase.key}: die Kennung des Agenten steht in der Antwort des Hubs`
      );
    }
  } finally {
    await hub.close();
    await agent.close();
  }
});

test("der Schlüssel mit angehängtem Text wird getroffen und behält ihn", async () => {
  // ⚠️ Wer `self-management-locked: /mnt/…` mit `===` verglich, träfe ihn
  // NIE: die Gleichheit scheitert am Zusatz, und der Betreiber bekäme eine
  // pauschale Ablehnung statt der Auskunft, welches Verzeichnis gesperrt ist.
  const agent = await startAgent();
  const hub = await startHub({ agent });
  try {
    agent.exec = {
      kind: "status",
      status: 403,
      body: { error: "self-management-locked: /mnt/user/appdata/immich" }
    };
    const response = await call(execUrl(hub));
    const body = (await response.json()) as { error: string; message: string };
    assert.equal(response.status, 403);
    assert.equal(body.error, "agent-forbidden");
    assert.ok(
      body.message.includes("/mnt/user/appdata/immich"),
      `der angehängte Text fehlt in der Meldung: ${body.message}`
    );
  } finally {
    await hub.close();
    await agent.close();
  }
});

test("ein unbekannter Schlüssel fällt auf den vagen Satz und nicht auf einen falschen", async () => {
  const agent = await startAgent();
  const hub = await startHub({ agent });
  try {
    agent.exec = { kind: "status", status: 418, body: { error: "etwas-ganz-neues" } };
    const response = await call(execUrl(hub));
    assert.equal(response.status, 502);
    assert.equal(((await response.json()) as { error: string }).error, "agent-unreachable");
  } finally {
    await hub.close();
    await agent.close();
  }
});

// ── 4. Die Pro-Mensch-Grenze ────────────────────────────────────────────────

test("die dritte eigene Shell auf demselben Arm ist 429 own-session-limit", async () => {
  // ⚠️ EIGENE KENNUNG UND NICHT `too-many-sessions`. Die Abhilfe ist eine
  // andere: hier schließt man seine EIGENE Shell, dort wartet man auf einen
  // anderen Menschen.
  const agent = await startAgent();
  const hub = await startHub({ agent });
  const held: AbortController[] = [];
  try {
    for (let index = 0; index < EXEC_MAX_SESSIONS_PER_USER; index += 1) {
      const controller = new AbortController();
      held.push(controller);
      const response = await call(execUrl(hub), { signal: controller.signal });
      assert.equal(response.status, 200, `Shell ${index + 1} ging nicht auf`);
      const reader = response.body?.getReader();
      assert.ok(reader);
      agent.push(agentStart(`agent-${index}`));
      await readUntil(reader, (text) => text.includes('"start"'), `Shell ${index + 1}: keine start-Zeile`);
    }

    const seenBefore = agent.seen.length;
    const refused = await call(execUrl(hub));
    assert.equal(refused.status, 429);
    assert.equal(((await refused.json()) as { error: string }).error, "own-session-limit");
    // ⚠️ VOR dem Agentenaufruf. Eine Grenze, die erst danach greift, hat die
    // Sitzung beim Arm schon eröffnet und zählt gegen dessen eigenen Deckel.
    assert.equal(
      agent.seen.filter((entry) => entry.url.endsWith("/exec")).length,
      agent.seen.slice(0, seenBefore).filter((entry) => entry.url.endsWith("/exec")).length,
      "der Arm wurde trotz der eigenen Grenze nach einer weiteren Shell gefragt"
    );
  } finally {
    for (const controller of held) controller.abort();
    await hub.close();
    await agent.close();
  }
});

test("eine geschlossene Shell gibt den eigenen Platz sofort wieder frei", async () => {
  // ⚠️ DER NACHWEIS FÜR `remove` IM `finally`. Der Sweep ist der Rückfall und
  // läuft nur beim Eröffnen einer Sitzung; ohne das `remove` bliebe der
  // Leichnam stehen, zählte gegen die Grenze — und dieser Fall meldete `429`
  // statt `200`.
  const agent = await startAgent();
  const hub = await startHub({ agent });
  const held: AbortController[] = [];
  try {
    for (let index = 0; index < EXEC_MAX_SESSIONS_PER_USER; index += 1) {
      const controller = new AbortController();
      held.push(controller);
      const response = await call(execUrl(hub), { signal: controller.signal });
      const reader = response.body?.getReader();
      assert.ok(reader);
      agent.push(agentStart(`agent-${index}`));
      await readUntil(reader, (text) => text.includes('"start"'), `Shell ${index + 1}: keine start-Zeile`);
    }

    // Eine davon zumachen — der Weg, den ein geschlossener Reiter geht.
    held[0]?.abort();
    await waitFor(() => agent.hungUp === 1, "der Hub hat den Strom zum Arm nicht gekappt");

    const fresh = new AbortController();
    held.push(fresh);
    const again = await call(execUrl(hub), { signal: fresh.signal });
    assert.equal(
      again.status,
      200,
      "nach dem Schließen einer eigenen Shell ging keine neue auf — der Eintrag blieb im Register stehen"
    );
    await again.body?.cancel().catch(() => undefined);
  } finally {
    for (const controller of held) controller.abort();
    await hub.close();
    await agent.close();
  }
});

// ── 5. Die Rolle ────────────────────────────────────────────────────────────

test("ein Benutzer ohne Adminrechte bekommt 403 — der Verhaltensfall zur Stellung", async () => {
  // ⚠️ DER FALL, DEN DER TEXTWÄCHTER NICHT LEISTEN KANN.
  // `web/tests/api-read-only.test.mjs` liest, dass `requireAdmin` unmittelbar
  // hinter dem Pfad steht; er kann nicht sagen, was passiert, wenn es woanders
  // steht. Verrutscht die Schicht, meldet dieser Fall `200 !== 403`.
  const agent = await startAgent();
  const hub = await startHub({ agent });
  try {
    const response = await call(execUrl(hub), { role: "user" });
    assert.equal(response.status, 403);
    assert.equal(((await response.json()) as { error: string }).error, "admin-required");
    assert.deepEqual(agent.seen, [], "der Arm wurde trotz fehlender Rechte gefragt");
    await response.body?.cancel().catch(() => undefined);
  } finally {
    await hub.close();
    await agent.close();
  }
});

test("ohne Anmeldung gibt es keine Shell", async () => {
  const agent = await startAgent();
  const hub = await startHub({ agent });
  try {
    const response = await call(execUrl(hub), { role: "niemand" });
    assert.equal(response.status, 401);
    assert.deepEqual(agent.seen, []);
    await response.body?.cancel().catch(() => undefined);
  } finally {
    await hub.close();
    await agent.close();
  }
});

// ── 6. Die WIEDERHOLTE Rechteprüfung ───────────────────────────────────────

/**
 * Eine Uhr, die der Test stellt — statt sechzig Sekunden zu warten.
 *
 * ⚠️ SIE ERSETZT DEN TAKT UND NICHT DIE PRÜFUNG. Was hier eingespeist wird,
 * ist ausschließlich das WANN; das WAS läuft unverändert im Handler. Ein Test,
 * der stattdessen die Prüffunktion selbst nachbaute, prüfte seine eigene
 * Nachbildung — und ein Test, der echte sechzig Sekunden abwartete, würde nach
 * dem ersten Mal aus dem Lauf genommen.
 *
 * Sie zählt außerdem die Abbestellungen: ein Zeitgeber, den niemand löscht,
 * hält den Node-Prozess am Leben, und `node --test` hängt dann am Ende der
 * Suite ohne eine einzige rote Zeile.
 */
type Clock = {
  schedule: Scheduler;
  tasks: (() => void)[];
  /** Mit welchem Abstand jeder Takt angemeldet wurde. */
  everyMs: number[];
  /** Wie oft ein Takt abbestellt wurde. */
  stopped: number;
  tick: () => Promise<void>;
};

function manualClock(): Clock {
  const clock: Clock = {
    schedule: (task, everyMs) => {
      clock.tasks.push(task);
      clock.everyMs.push(everyMs);
      return () => {
        clock.stopped += 1;
        const index = clock.tasks.indexOf(task);
        if (index >= 0) clock.tasks.splice(index, 1);
      };
    },
    tasks: [],
    everyMs: [],
    stopped: 0,
    tick: async () => {
      for (const task of [...clock.tasks]) task();
      // ⚠️ Der Takt arbeitet asynchron (er löst die Sitzung neu auf). Ohne
      // diese Pause prüfte der Fall danach einen Zustand, den der Takt noch
      // gar nicht erreicht hat — und wäre grün, weil noch nichts passiert ist.
      await new Promise<void>((resolve) => setTimeout(resolve, 25));
    }
  };
  return clock;
}

const REVOCATIONS: { label: string; apply: (control: SessionControl) => void }[] = [
  { label: "die Sitzung ist weg", apply: (control) => (control.revoked = true) },
  { label: "die Rolle ist nicht mehr admin", apply: (control) => (control.demoted = true) },
  { label: "das Merkmal zeigt auf ein anderes Konto", apply: (control) => (control.identity = "jemand-anderes") },
  // ⚠️ FAIL CLOSED, und der Preis ist ehrlich benannt: eine Datenbank, die eine
  // Sekunde stolpert, kostet die offenen Shells. Die Gegenrichtung wäre
  // schlimmer — ein `catch`, das die Verbindung weiterlaufen lässt, machte aus
  // einer nicht erreichbaren Datenbank eine Shell ohne Rechteprüfung.
  { label: "das Auflösen selbst scheitert", apply: (control) => (control.broken = true) }
];

test("wird das Recht während des Stroms entzogen, endet die Shell mit permission-revoked", async () => {
  // ⚠️ OHNE DIESE PRÜFUNG hielte der Hub eine Shell offen, deren Recht längst
  // entzogen ist — bis der Agent nach 30 Minuten von selbst abriegelt. Der
  // Log-Strom löst dasselbe Problem über eine kurze Verbindungsdauer; für ein
  // Terminal geht das nicht, es verlöre seinen Zustand.
  for (const revocation of REVOCATIONS) {
    const clock = manualClock();
    const agent = await startAgent();
    const hub = await startHub({ agent, schedule: clock.schedule });
    try {
      const shell = await openShell(hub, agent);

      // Der Takt hängt an der Konstante des Registers und nicht an einer Zahl,
      // die jemand hier hingeschrieben hat.
      assert.deepEqual(clock.everyMs, [EXEC_PERMISSION_CHECK_MS], `${revocation.label}: Abstand`);
      assert.equal(EXEC_PERMISSION_CHECK_MS, 60_000, "der gemessene Abstand ist eine Minute");

      revocation.apply(hub.session);
      await clock.tick();

      const rest = await readAll(shell.reader);
      assert.deepEqual(
        envelopes(rest),
        [{ kind: "error", reason: "permission-revoked" }],
        `${revocation.label}: der Strom endete anders`
      );

      // ⚠️ UND DER ARM ERFÄHRT ES AUCH. Eine Antwort, die im Browser endet,
      // während die Shell auf dem Rechner weiterläuft, wäre die halbe Sache:
      // die Sitzung belegte weiter einen der vier Plätze des Arms.
      await waitFor(() => agent.hungUp === 1, `${revocation.label}: der Strom zum Arm lief weiter`);

      // ⚠️ ERST DAS RECHT ZURÜCKGEBEN, DANN NACHSEHEN. Die Frage lautet „ist
      // der EINTRAG ausgetragen?" — mit entzogenem Recht antwortete schon
      // `requireAdmin` (mit `401` bzw. `403`), und der Fall wäre grün, ohne das
      // Register je erreicht zu haben. Gemessen am 2026-09-08: die erste
      // Fassung dieses Falls las `401 !== 404` und prüfte damit die falsche
      // Schranke.
      hub.session.revoked = false;
      hub.session.demoted = false;
      hub.session.identity = null;
      hub.session.broken = false;

      const after = await call(shortUrl(hub, shell.session, "input"), { body: { data: "AA==" } });
      assert.equal(after.status, 404, `${revocation.label}: die Sitzung nahm noch Eingaben an`);
      assert.equal(((await after.json()) as { error: string }).error, "session-unknown", `${revocation.label}`);

      assert.equal(clock.stopped, 1, `${revocation.label}: der Zeitgeber wurde nicht gelöscht`);
      assert.deepEqual(clock.tasks, [], `${revocation.label}: es läuft noch ein Takt`);
    } finally {
      await hub.close();
      await agent.close();
    }
  }
});

test("ein Takt mit unverändertem Recht schreibt nichts in den Strom", async () => {
  // ⚠️ DIE GEGENPROBE, ohne die der Fall darüber nichts aussagt: ein Takt, der
  // IMMER abbricht, wäre dort ebenso grün. Hier läuft er zweimal, und die
  // Shell tippt danach weiter.
  const clock = manualClock();
  const agent = await startAgent();
  const hub = await startHub({ agent, schedule: clock.schedule });
  try {
    const shell = await openShell(hub, agent);
    await clock.tick();
    await clock.tick();

    agent.push(`${JSON.stringify({ kind: "output", text: "immer noch da" })}\n`);
    await readUntil(shell.reader, (text) => text.includes("immer noch da"), "der Strom war vorzeitig zu");
    assert.equal(clock.stopped, 0, "der Zeitgeber wurde gelöscht, obwohl der Strom läuft");

    shell.controller.abort();
  } finally {
    await hub.close();
    await agent.close();
  }
});

test("nach dem Ende des Stroms ist der Zeitgeber gelöscht", async () => {
  // ⚠️ DER FALL GEGEN EIN HÄNGENDES `node --test`. Ein `setInterval`, den
  // niemand löscht, hält den Prozess am Leben; die Suite steht dann am Ende
  // ohne eine einzige rote Zeile, und das sieht wie ein Fehler der Umgebung
  // aus. Hier ist es eine Zusage mit einem Fall daneben.
  const clock = manualClock();
  const agent = await startAgent();
  const hub = await startHub({ agent, schedule: clock.schedule });
  try {
    const shell = await openShell(hub, agent);
    agent.push(`${JSON.stringify({ kind: "end", exitCode: 0 })}\n`);
    agent.finish();

    const rest = await readAll(shell.reader);
    assert.deepEqual(envelopes(rest), [{ kind: "end", exitCode: 0 }]);

    assert.equal(clock.stopped, 1, "der Zeitgeber überlebte seinen Strom");
    assert.deepEqual(clock.tasks, []);

    // Und ein Takt danach tut nichts mehr — er ist gar nicht mehr angemeldet.
    hub.session.revoked = true;
    await clock.tick();
  } finally {
    await hub.close();
    await agent.close();
  }
});
