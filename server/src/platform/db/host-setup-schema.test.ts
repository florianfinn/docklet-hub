import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

// Wächter über 008 — die Migration, die dem Arm die zwei Werte seines
// Zielhosts gibt (#4, B2 in #46).
//
// Geprüft wird der TEXT der Datei und nicht ihre Wirkung: ohne laufendes
// Postgres lässt sich nicht sehen, ob das SQL durchläuft. Prüfbar ist das,
// was hier still schiefgeht — eine Bedingung, die den falschen Wert durchlässt,
// und ein Wert, der auf dem Zielhost eine Compose-Datei zerlegt.

const DIRECTORY = new URL("./migrations/", import.meta.url);
const FILENAME = "008-host-setup.sql";
const SQL = readFileSync(fileURLToPath(new URL(FILENAME, DIRECTORY)), "utf8");

test("die Migration ergänzt genau die zwei Spalten des Zielhosts", () => {
  const added = [...SQL.matchAll(/ADD COLUMN\s+(\w+)/g)].map((match) => match[1]);
  assert.deepEqual(added.sort(), ["bind_base_path", "docker_gid"]);
});

test("beide Spalten kommen nullable herein", () => {
  // ⚠️ Der lokale Host hat sie nicht, und ein Arm aus der Zeit vor 008 auch
  // nicht. NOT NULL hier hielte den Start eines bestehenden Hubs an — die
  // allgemeine Fassung dieser Zusage steht in migration-sequence.test.ts, hier
  // steht sie noch einmal für die zwei Spalten, um die es geht.
  for (const match of SQL.matchAll(/ADD COLUMN\s+(\w+)[^,;]*/g)) {
    assert.ok(!/NOT NULL/.test(match[0]), `${match[1]} kommt NOT NULL herein`);
  }
});

test("die Gruppen-ID lässt 0 zu und negative Zahlen nicht", () => {
  // ⚠️ Genau hier läge der Fehler, den niemand sieht: `docker_gid > 0` sähe
  // richtig aus und wiese jeden Host ab, dessen Socket root gehört.
  const check = /ADD CONSTRAINT docker_host_docker_gid_check\s+CHECK \(([^)]*\))/.exec(SQL);
  assert.ok(check, "die Bedingung über die Gruppen-ID fehlt");
  assert.match(check[1], /docker_gid >= 0/);
  assert.ok(!/docker_gid > 0/.test(check[1]), "0 ist die Gruppe root und ein gültiger Wert");
  assert.match(check[1], /docker_gid IS NULL OR/, "eine Zeile ohne Wert muss weiterhin gültig sein");
});

test("der Basispfad lässt nichts durch, was eine Compose-Zeile zerlegt", () => {
  // Der Wert landet im Archiv unmaskiert in `- ${PFAD}:${PFAD}`. Ein
  // Doppelpunkt ergibt dort drei Felder, ein Leerzeichen zerlegt die Zeile —
  // und beides fällt erst auf dem fremden Host beim `compose up` auf.
  const check = /ADD CONSTRAINT docker_host_bind_base_path_check\s+CHECK \(([^;]*)\)/.exec(SQL);
  assert.ok(check, "die Bedingung über den Basispfad fehlt");
  const pattern = /bind_base_path ~ '([^']+)'/.exec(check[1]);
  assert.ok(pattern, "die Bedingung prüft den Pfad nicht gegen ein Muster");

  // Das Muster selbst gegengelesen, statt seinen Wortlaut festzuschreiben:
  // was es zulässt, ist die Aussage — nicht, wie es geschrieben ist.
  //
  // ⚠️ Postgres' ARE und die von JavaScript stimmen hier überein, weil das
  // Muster nur Anker, eine Zeichenklasse und `*` benutzt. `[:space:]` kennt
  // JavaScript nicht; es wird für diese Gegenprobe durch `\s` ersetzt.
  const asJs = new RegExp(pattern[1].replace("[:space:]", "\\s"));
  for (const good of ["/home/docker", "/mnt/user/appdata", "/srv"]) {
    assert.ok(asJs.test(good), `abgewiesen, obwohl brauchbar: ${good}`);
  }
  for (const bad of ["home/docker", "/mnt/my data", "/mnt:/mnt", ""]) {
    assert.ok(!asJs.test(bad), `durchgelassen, obwohl es die Compose-Zeile trifft: „${bad}"`);
  }
});

test("der Name der Datei nennt der Wächter, der ihn erzwingt", () => {
  assert.match(FILENAME, /^\d{3,}-[a-z0-9]+(?:-[a-z0-9]+)*\.sql$/);
});
