import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

// Wächter über die Migration, die aus einem Host einen anmeldbaren Arm macht.
//
// Ohne laufendes Postgres lässt sich nicht prüfen, ob das SQL durchläuft.
// Prüfbar ist aber das, was hier still schiefgeht — und das ist nicht die
// Syntax, sondern die REIHENFOLGE und die VORGABEN:
//
//   - Eine neue Spalte mit NOT NULL und ohne Vorgabe hält den Start eines
//     BESTEHENDEN Hubs an. Auf einer frischen Datenbank fällt das nie auf,
//     weil dort keine Zeile steht, die verletzt würde.
//   - Eine Bedingung, die vor dem Füllen der Altdaten steht, tut dasselbe.
//
// Beides kommt in jeder Prüfumgebung grün durch und trifft genau den einen
// Betreiber, der schon einen Hub laufen hat.

const DIRECTORY = new URL("./migrations/", import.meta.url);
const FILENAME = "004-host-enrollment.sql";
const SQL = readFileSync(fileURLToPath(new URL(FILENAME, DIRECTORY)), "utf8");

test("die Migration ergänzt genau die Spalten, auf denen die Anmeldung steht", () => {
  const expected = [
    "tunnel_address",
    "wireguard_public_key",
    "agent_secret",
    "token_hash",
    "state",
    "failed_attempts",
    "registered_at",
    "endpoint_override"
  ];
  const added = [...SQL.matchAll(/ADD COLUMN\s+(\w+)/g)].map((match) => match[1]);
  assert.deepEqual([...added].sort(), [...expected].sort());
});

test("keine neue Spalte ist NOT NULL ohne Vorgabe", () => {
  // Der Fall, der nur einen bestehenden Betrieb trifft: die Zeile des lokalen
  // Hosts steht schon da und hat den neuen Wert nicht.
  const withoutDefault = [...SQL.matchAll(/ADD COLUMN\s+(\w+)\s+[^,;]*/g)]
    .map((match) => ({ name: match[1], clause: match[0] }))
    .filter((column) => /NOT NULL/.test(column.clause) && !/DEFAULT/.test(column.clause))
    .map((column) => column.name);
  assert.deepEqual(withoutDefault, []);
});

test("die Vorgabe des Zustands macht die bestehende Zeile gültig", () => {
  // `registered` und nicht `pending`: der lokale Host wurde eingetragen, nicht
  // angemeldet, und ein Hub, der ihn nach dieser Migration für ausstehend
  // hält, zeigt seinen eigenen Host als nicht angekommen.
  assert.match(SQL, /ADD COLUMN\s+state\s+text\s+NOT NULL DEFAULT 'registered'/);
  assert.match(SQL, /ADD COLUMN\s+failed_attempts\s+integer\s+NOT NULL DEFAULT 0/);
});

test("die Altdaten werden gefüllt, BEVOR die Bedingungen sie verlangen", () => {
  const update = SQL.indexOf("UPDATE docker_host SET registered_at");
  const firstConstraint = SQL.indexOf("ADD CONSTRAINT");
  assert.notEqual(update, -1, "die bestehende Zeile bekommt keinen Zeitstempel");
  assert.notEqual(firstConstraint, -1);
  assert.ok(
    update < firstConstraint,
    `die Bedingung „registriert heißt: registered_at steht" liefe sonst gegen die Altzeile`
  );
});

test("die Bedingungen tragen die Regeln des Datenmodells", () => {
  const constraints = [...SQL.matchAll(/ADD CONSTRAINT\s+(\w+)/g)].map((match) => match[1]);
  assert.deepEqual(constraints.sort(), [
    "docker_host_arm_check",
    "docker_host_failed_attempts_check",
    "docker_host_local_check",
    "docker_host_pending_token_check",
    "docker_host_registered_at_check",
    "docker_host_state_check",
    "docker_host_tunnel_address_host_check",
    "docker_host_tunnel_address_key"
  ]);
});

test("die Tunneladresse ist eindeutig und eine einzelne Adresse", () => {
  // Der eindeutige Index IST die Vergabestelle (domain/hosts/host-store.ts). Ohne ihn wäre die
  // Suche nach der nächsten freien Adresse ein Wettlauf ohne Schiedsrichter.
  assert.match(SQL, /ADD CONSTRAINT docker_host_tunnel_address_key\s+UNIQUE \(tunnel_address\)/);
  // ⚠️ Ohne diese Bedingung wäre '10.254.0.2/24' erlaubt und über seine eigene
  // Adresse nicht mehr auffindbar: `inet` vergleicht auch die Präfixlänge.
  assert.match(SQL, /masklen\(tunnel_address\) = 32/);
});

test("der Name der Datei nennt der Wächter, der ihn erzwingt", () => {
  assert.match(FILENAME, /^\d{3,}-[a-z0-9]+(?:-[a-z0-9]+)*\.sql$/);
});

// Die Folge selbst — „laufen alle, in der Reihenfolge der Nummern", und „auf
// einer bestehenden läuft die neueste nach" — prüft seit 005
// migration-sequence.test.ts. Dieser Fall stand bis dahin hier und war auf
// FILENAME festgeschrieben; er galt damit immer nur für die jeweils neueste
// Datei und wäre bei jeder weiteren Migration umgezogen. Er ist nicht
// entfallen, sondern verallgemeinert: dort bestimmt der Wächter die neueste
// Datei selbst.
