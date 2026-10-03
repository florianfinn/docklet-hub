import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  NO_CONFIRMATIONS,
  answered,
  applyInputOf,
  blockerOf,
  demandsOf,
  RESYNC_SETTLED,
  resyncWarns
} from "../src/features/compose/apply-state.ts";

// WAS DIESE DATEI PRÜFT UND WARUM GERADE DAS
//
// Die Prüfung des Agenten ist GENAUE MENGENGLEICHHEIT und nicht Teilmenge. Das
// hat eine Folge, die man beim Bauen einer Fläche übersieht: ein Haken zu VIEL
// macht den Aufruf genauso ungültig wie ein fehlender. Er entsteht ganz
// gewöhnlich — anhaken, weitertippen, der Service heißt jetzt anders.
//
// Eine Fläche, die nur ZÄHLT, lässt den Knopf frei und schickt einen Aufruf
// hinaus, der mit `service-confirmation-missing` zurückkommt. Der Betreiber sieht
// dann eine Ablehnung, obwohl er alles angehakt hat, und findet den Grund nicht.

function preview(overrides = {}) {
  return {
    source: "agent",
    valid: true,
    reason: null,
    errors: [],
    configError: null,
    services: ["a", "b"],
    diff: { remaining: ["a"], new: ["b"], removed: [] },
    imagesByService: { a: "a:1", b: "b:1" },
    missingImages: [],
    servicesWithoutImage: [],
    inventoryViolations: [],
    composeHash: "h1",
    stackName: "medien",
    currentServices: ["a"],
    steps: ["validate"],
    uncertainties: [],
    ...overrides
  };
}

function withSets(overrides) {
  return { ...NO_CONFIRMATIONS, ...overrides };
}

test("ohne Änderung geht gar nichts hinaus", () => {
  assert.deepEqual(blockerOf(preview(), NO_CONFIRMATIONS, false), { reason: "unchanged" });
});

test("ein neuer Service muss bestätigt sein", () => {
  const blocker = blockerOf(preview(), NO_CONFIRMATIONS, true);
  assert.equal(blocker?.reason, "unconfirmed-services");
  assert.deepEqual(blocker.missing, ["b"]);
  assert.equal(blockerOf(preview(), withSets({ services: new Set(["b"]) }), true), null);
});

test("EIN HAKEN ZU VIEL SPERRT GENAUSO WIE EIN FEHLENDER", () => {
  // ⚠️ Der Fall, den eine zählende Fläche durchlässt. Der Betreiber hat „b"
  // angehakt und dann weitergetippt; jetzt heißt der Service „c". Die
  // Bestätigung für „b" ist für den Agenten keine Kleinigkeit, sondern ein
  // Zeichen, dass der Aufrufer von einem anderen Dateistand ausgeht.
  const stale = withSets({ services: new Set(["b", "weg"]) });
  assert.deepEqual(blockerOf(preview(), stale, true), { reason: "stale-confirmation" });
});

test("ein untauglicher Entwurf sperrt, bevor irgendein Haken zählt", () => {
  const blocker = blockerOf(preview({ valid: false, reason: "no-services" }), NO_CONFIRMATIONS, true);
  assert.equal(blocker?.reason, "invalid");
  assert.equal(blocker.detail, "no-services");
});

test("nicht erhobene Images sperren NICHT — der Arm fragt danach", () => {
  // ⚠️ `null` heißt „nicht erhoben". Hier zu sperren hieße, einen Weg zu
  // verschließen, der offen ist: der Arm antwortet mit seiner Liste, und die
  // geht beim nächsten Versuch zurück.
  const unknown = preview({ missingImages: null });
  assert.equal(blockerOf(unknown, withSets({ services: new Set(["b"]) }), true), null);
  assert.equal(demandsOf(unknown).images, null);
});

test("erhobene Images müssen dagegen bestätigt sein", () => {
  const pending = preview({ missingImages: ["b:1"] });
  const blocker = blockerOf(pending, withSets({ services: new Set(["b"]) }), true);
  assert.equal(blocker?.reason, "unconfirmed-images");
  assert.equal(
    blockerOf(pending, withSets({ services: new Set(["b"]), images: new Set(["b:1"]) }), true),
    null
  );
});

test("die Antwort auf eine Rückfrage übernimmt die Liste des Arms unverändert", () => {
  // ⚠️ Der Hub bildet diese Liste NICHT selbst. Welche Images fehlen, weiß nur
  // der Arm, und die Prüfung ist Mengengleichheit — eine selbst
  // zusammengestellte Liste wird abgelehnt.
  const next = answered(NO_CONFIRMATIONS, { kind: "images", missing: ["x:1", "y:2"] });
  assert.deepEqual([...next.images], ["x:1", "y:2"]);

  const hardened = answered(NO_CONFIRMATIONS, {
    kind: "hardening",
    newViolations: ["a:privileged"],
    rolledBack: true
  });
  assert.deepEqual([...hardened.hardening], ["a:privileged"]);
});

test("nicht jede Rückfrage ist durch Bestätigen zu beantworten", () => {
  // ⚠️ Gegen `file-changed-externally` hilft keine Bestätigung, sondern nur neu
  // laden. Ein Knopf „bestätigen und erneut" wäre dort ein Bedienelement, das
  // in dieselbe Ablehnung läuft.
  assert.equal(answered(NO_CONFIRMATIONS, { kind: "changed-elsewhere", actualHash: "h2" }), null);
  assert.equal(
    answered(NO_CONFIRMATIONS, { kind: "start-failed", detail: "exit 1", rolledBack: false }),
    null
  );
});

test("die zwei Rückfragen der Prüfphase vor dem Schreiben sind es auch nicht", () => {
  // ⚠️ Beide fallen, bevor der Arm etwas schreibt: gegen den veralteten Anker
  // hilft nur, den Stack aus der Übersicht neu zu öffnen, gegen die unlesbare
  // Image-Angabe nur, den Entwurf zu berichtigen. Ein Knopf läuft in dieselbe
  // Ablehnung.
  assert.equal(answered(NO_CONFIRMATIONS, { kind: "anchor-stale" }), null);
  assert.equal(
    answered(NO_CONFIRMATIONS, { kind: "image-ref-unreadable", ref: "sonarr::2" }),
    null
  );
});

test("der Rumpf trägt genau die vier Listen und den Hash", () => {
  const input = applyInputOf(
    "services:\n",
    "h1",
    withSets({ services: new Set(["b"]), images: new Set(["b:1"]) })
  );
  assert.deepEqual(input, {
    content: "services:\n",
    expectedComposeHash: "h1",
    confirmNew: ["b"],
    confirmRemoved: [],
    acknowledgeImagePull: ["b:1"],
    acknowledgeHardening: []
  });
});

// #179: nach dem Anwenden hat jeder Abgleichsstatus eine entschiedene Anzeige.
// Die Liste der Status steht im Server; wer dort einen dazulegt, soll hier
// rot werden, statt still in den Zweig „unbekannt, also warnen" zu fallen.
test("jeder Abgleichsstatus des Hubs ist entschieden", () => {
  const source = readFileSync(new URL("../../server/src/domain/hosts/host-cycle.ts", import.meta.url), "utf8");
  const declaration = /export type HostCycleStatus = ([^;]+);/.exec(source);
  assert.ok(declaration, "HostCycleStatus nicht gefunden");
  const cycle = [...declaration[1].matchAll(/"([^"]+)"/g)].map((match) => match[1]);
  assert.ok(cycle.length > 0);
  const service = readFileSync(new URL("../../server/src/features/compose/resync.ts", import.meta.url), "utf8");
  assert.ok(service.includes('status: "skipped"'), "skipped kommt nicht mehr aus features/compose/resync.ts");

  assert.deepEqual(Object.keys(RESYNC_SETTLED).sort(), [...cycle, "skipped"].sort());
});

test("synced und unchanged warnen nicht, alles andere schon", () => {
  assert.equal(resyncWarns("synced"), false);
  assert.equal(resyncWarns("unchanged"), false);
  for (const status of ["pending", "unreachable", "failed", "skipped"]) {
    assert.equal(resyncWarns(status), true, status);
  }
  assert.equal(resyncWarns(null), true, "kein Status ist kein Beleg");
  assert.equal(resyncWarns("irgendwas"), true, "ein unbekannter Status ist kein Beleg");
  // `Object.hasOwn` und nicht `in`: ein geerbter Schlüssel ist kein Status.
  assert.equal(resyncWarns("toString"), true);
});
