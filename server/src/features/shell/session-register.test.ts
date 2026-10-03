import test from "node:test";
import assert from "node:assert/strict";

import { EXEC_MAX_DURATION_MS } from "contract";
import {
  clientViewOf,
  EXEC_MAX_SESSIONS,
  EXEC_MAX_SESSIONS_PER_USER,
  EXEC_SWEEP_GRACE_MS,
  ExecSessionRegister,
  type ExecSession
} from "./session-register.js";

// Das Sitzungsregister ist die EINZIGE Stelle, die zwischen zwei getrennten
// HTTP-Anfragen beantwortet, ob dieselbe Person tippt, die die Shell geöffnet
// hat. Wer eine Shell in einem Container hat, kann darin alles; die einzige
// Schranke gegen eine abgefangene Sitzungs-Id ist die Bindung an den Menschen.
//
// ⚠️ Die Fälle unten sind deshalb nicht „auch noch" geprüft, sondern der Grund
// für diese Datei. Jeder von ihnen war in der Quelle (`dashboard-homelab`,
// `server/src/docker-exec.test.ts` bei `92fbc0b`) schon ein eigener Fall; die
// beiden neuen — der Arm und der Sweep — sind die Erweiterungen dieses Hubs.

const NOW = 1_757_000_000_000;

function fixture(): {
  register: ExecSessionRegister;
  open: (input: { hostId?: string; containerId?: string; userId?: string; now?: number }) => ExecSession;
} {
  const register = new ExecSessionRegister();
  return {
    register,
    open: (input) =>
      register.open({
        hostId: input.hostId ?? "h1",
        containerId: input.containerId ?? "c1",
        containerName: input.containerId ?? "c1",
        userId: input.userId ?? "u-7",
        abort: new AbortController(),
        now: input.now ?? NOW
      })
  };
}

const AT = (session: ExecSession) => ({ userId: session.userId, hostId: session.hostId, containerId: session.containerId });

// ── Die Kopplung ────────────────────────────────────────────────────────────

test("eine Sitzung nimmt erst nach der Kopplung mit dem Agenten Eingaben an", () => {
  const { register, open } = fixture();
  const session = open({});
  assert.deepEqual(register.check(session.id, AT(session)), { ok: false, reason: "session-unknown" });
  register.couple(session.id, "agent-1");
  const access = register.check(session.id, AT(session));
  assert.equal(access.ok, true);
  assert.equal(access.ok && access.session.agentSession, "agent-1");
});

test("koppeln an eine unbekannte Id tut nichts und wirft nicht", () => {
  // Der Strom kann seine `start`-Zeile schicken, nachdem die Route ihre Sitzung
  // schon ausgetragen hat (der Browser war zuerst weg). Das ist kein Fehler.
  const { register } = fixture();
  register.couple("gibtsnicht", "agent-1");
  assert.equal(register.size, 0);
});

// ── Die vier Bedingungen ────────────────────────────────────────────────────

test("ein fremder Mensch kommt nicht in eine offene Sitzung", () => {
  const { register, open } = fixture();
  const session = open({});
  register.couple(session.id, "agent-1");
  assert.deepEqual(register.check(session.id, { ...AT(session), userId: "u-8" }), {
    ok: false,
    reason: "session-unknown"
  });
});

test("der Container im Pfad muss zur Sitzung passen", () => {
  const { register, open } = fixture();
  const session = open({});
  register.couple(session.id, "agent-1");
  assert.deepEqual(register.check(session.id, { ...AT(session), containerId: "c2" }), {
    ok: false,
    reason: "session-unknown"
  });
});

test("der Arm im Pfad muss zur Sitzung passen", () => {
  // ⚠️ DIE ERWEITERUNG GEGENÜBER DER QUELLE, und sie ist keine Formsache: das
  // Quellsystem hatte genau einen Docker-Host. Hier trägt dieselbe kurze
  // Container-Kennung auf zwei Armen zwei verschiedene Container — ohne diesen
  // Abgleich wäre der Arm ein frei wählbarer Parameter neben einer gültigen
  // Sitzung, und eine Shell auf Arm A tippte in einen Container auf Arm B.
  const { register, open } = fixture();
  const session = open({ hostId: "h1", containerId: "c1" });
  register.couple(session.id, "agent-1");
  assert.deepEqual(register.check(session.id, { ...AT(session), hostId: "h2" }), {
    ok: false,
    reason: "session-unknown"
  });
});

test("unbekannt, fremd, falscher Arm und noch nicht gekoppelt liefern DENSELBEN Grund", () => {
  // ⚠️ DER FALL, DER DIE AUSKUNFTSSPERRE HÄLT. Vier verschiedene Ursachen, eine
  // Antwort — sonst ließen sich gültige Sitzungs-Ids über die Fehlermeldung
  // bestätigen: „fremd" hieße „die Id existiert".
  const { register, open } = fixture();
  const coupled = open({});
  register.couple(coupled.id, "agent-1");
  const bare = open({ containerId: "c9" });

  const unknown = register.check("gibtsnicht", AT(coupled));
  const foreign = register.check(coupled.id, { ...AT(coupled), userId: "u-8" });
  const wrongHost = register.check(coupled.id, { ...AT(coupled), hostId: "h2" });
  const uncoupled = register.check(bare.id, AT(bare));

  assert.deepEqual(unknown, { ok: false, reason: "session-unknown" });
  assert.deepEqual(foreign, unknown);
  assert.deepEqual(wrongHost, unknown);
  assert.deepEqual(uncoupled, unknown);
});

// ── Die Id ──────────────────────────────────────────────────────────────────

test("Sitzungs-Ids sind 256 Bit aus dem CSPRNG und eindeutig", () => {
  const { open } = fixture();
  const first = open({});
  const second = open({});
  assert.equal(first.id.length, 64, "64 Hexzeichen sind 32 Byte sind 256 Bit");
  assert.match(first.id, /^[0-9a-f]{64}$/);
  assert.notEqual(first.id, second.id);
});

test("die Agent-Sitzungs-Id ist NICHT die Id, die der Browser bekommt", () => {
  // ⚠️ Der Kern der Zusage. Die beiden Ids gehören verschiedenen Seiten; wären
  // sie dieselbe, wäre die Bindung an den Menschen wertlos — der Browser hätte
  // den Schlüssel zu den drei kurzen Routen des Agenten in der Hand.
  const { register, open } = fixture();
  const session = open({});
  register.couple(session.id, "agent-1");
  assert.notEqual(session.id, session.agentSession);
});

test("was nach draußen geht, trägt die Agent-Sitzungs-Id nicht", () => {
  // ⚠️ Gegen das SERIALISIERTE Ergebnis geprüft und nicht gegen einzelne
  // Felder: ein neues Feld, das die Id mitnimmt, fiele einem Feldvergleich
  // nicht auf. Der Wert ist absichtlich auffällig, damit ein Treffer eindeutig
  // ist.
  const { register, open } = fixture();
  const session = open({});
  register.couple(session.id, "agent-id-bleibt-hier");
  const outward = JSON.stringify(clientViewOf(session));
  assert.ok(!outward.includes("agent-id-bleibt-hier"), `die Agent-Id steht in der Antwort: ${outward}`);
  assert.deepEqual(JSON.parse(outward), { session: session.id, containerName: "c1" });
});

// ── Die Zählung je Mensch ───────────────────────────────────────────────────

test("die Zählung je Mensch trägt die Pro-Nutzer-Grenze — und zählt je Arm", () => {
  const { register, open } = fixture();
  open({ containerId: "c1", userId: "u-7", hostId: "h1" });
  open({ containerId: "c2", userId: "u-7", hostId: "h1" });
  open({ containerId: "c3", userId: "u-7", hostId: "h2" });
  open({ containerId: "c4", userId: "u-9", hostId: "h1" });
  assert.equal(register.countFor("u-7", "h1"), 2);
  assert.equal(register.countFor("u-7", "h2"), 1, "der Arm trennt die Zählung");
  assert.equal(register.countFor("u-9", "h1"), 1);
  assert.equal(register.countFor("u-9", "h2"), 0);
  assert.equal(register.size, 4);
});

test("die Grenze je Mensch bleibt unter dem Deckel des Agenten", () => {
  // Ohne diesen Fall stünde die Begründung „zwei von vier lassen zwei übrig"
  // nur im Kommentar — und eine später gehobene Grenze machte sie still falsch.
  assert.ok(
    EXEC_MAX_SESSIONS_PER_USER < EXEC_MAX_SESSIONS,
    `${EXEC_MAX_SESSIONS_PER_USER} je Mensch bei ${EXEC_MAX_SESSIONS} je Arm — ein Mensch schöpft den Arm allein aus`
  );
});

test("entfernte Sitzungen sind sofort weg", () => {
  const { register, open } = fixture();
  const session = open({});
  register.couple(session.id, "agent-1");
  register.remove(session.id);
  assert.equal(register.check(session.id, AT(session)).ok, false);
  assert.equal(register.countFor(session.userId, session.hostId), 0);
  assert.equal(register.size, 0);
});

// ── Der Sweep ───────────────────────────────────────────────────────────────

test("eine Sitzung jenseits der Höchstdauer des Agenten wird abgeräumt und abgebrochen", () => {
  // ⚠️ Das Leck, gegen das der Sweep steht: zwei der vier Ausgänge des
  // Exec-Stroms haben gar keine letzte Zeile. Ein Eintrag, der davon übrig
  // bleibt, zählt gegen die Grenze je Mensch und bleibt ein gültiger Schlüssel
  // für eine Shell, die es nicht mehr gibt.
  const register = new ExecSessionRegister();
  const abort = new AbortController();
  const session = register.open({
    hostId: "h1",
    containerId: "c1",
    containerName: "c1",
    userId: "u-7",
    abort,
    now: NOW
  });
  register.couple(session.id, "agent-1");

  const stillAlive = NOW + EXEC_MAX_DURATION_MS + EXEC_SWEEP_GRACE_MS - 1;
  assert.equal(register.sweep(stillAlive), 0, "vor Ablauf der Zugabe wird nichts angefasst");
  assert.equal(abort.signal.aborted, false);
  assert.equal(register.check(session.id, { userId: "u-7", hostId: "h1", containerId: "c1" }).ok, true);

  assert.equal(register.sweep(stillAlive + 1), 1);
  assert.equal(abort.signal.aborted, true, "der Strom läuft weiter, für den niemand mehr Buch führt");
  assert.equal(register.size, 0);
  assert.deepEqual(register.check(session.id, { userId: "u-7", hostId: "h1", containerId: "c1" }), {
    ok: false,
    reason: "session-unknown"
  });
});

test("das Eröffnen räumt vorher auf, damit die Zählung je Mensch stimmt", () => {
  // ⚠️ Der Grund, warum der Sweep an `open` hängt und nicht an einem
  // Zeitgeber: die Zählung entscheidet gleich darunter über eine Ablehnung. Auf
  // einem ungeputzten Register wiese sie einen Menschen wegen einer Sitzung ab,
  // die seit einer halben Stunde tot ist.
  const { register, open } = fixture();
  open({ containerId: "c1", now: NOW });
  open({ containerId: "c2", now: NOW });
  assert.equal(register.countFor("u-7", "h1"), 2);

  const later = NOW + EXEC_MAX_DURATION_MS + EXEC_SWEEP_GRACE_MS + 1;
  open({ containerId: "c3", now: later });
  assert.equal(register.size, 1, "die beiden alten sind beim Eröffnen gefallen");
  assert.equal(register.countFor("u-7", "h1"), 1);
});

test("der Sweep lässt fremde Sitzungen in Ruhe, die noch jung sind", () => {
  const { register, open } = fixture();
  const old = open({ containerId: "c1", userId: "u-7", now: NOW });
  const young = open({ containerId: "c2", userId: "u-9", now: NOW + EXEC_MAX_DURATION_MS });
  assert.equal(register.sweep(NOW + EXEC_MAX_DURATION_MS + EXEC_SWEEP_GRACE_MS + 1), 1);
  assert.equal(register.size, 1);
  assert.equal(register.check(young.id, AT(young)).ok, false, "noch nicht gekoppelt, aber vorhanden");
  assert.equal(young.abort.signal.aborted, false);
  assert.equal(old.abort.signal.aborted, true);
});
