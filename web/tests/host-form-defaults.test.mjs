import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { stripComments } from "./strip-comments.mjs";

// Wächter über drei Zeichenketten, die in web UND server stehen müssen — und
// die niemand zusammenhält, wenn dieser Fall es nicht tut.
//
// Web und Server sind getrennte Pakete ohne gemeinsamen Code; eine Abschrift
// ist deshalb unvermeidlich. Vermeidbar ist, dass sie still auseinanderläuft:
//
//   1. Der vorbelegte Basispfad im Formular gegen die Vorgabe, die der
//      Archiv-Erzeuger schreibt. Laufen sie auseinander, zeigt der Dialog
//      einen Pfad an, den das erzeugte Paket nicht trägt — und der Betreiber
//      hat einen Wert bestätigt, den er nie bekommt.
//   2. Der Befehl im Hinweis unter dem Feld gegen den, der in der `.env` und
//      in der README des Pakets steht. Ein Betreiber, dem der Dialog einen
//      anderen Befehl nennt als das Paket, hat zwei Wahrheiten über eine Zahl.
//   3. Beide Befehle in de und en gegeneinander: ein Befehl wird nicht
//      übersetzt. Wer ihn in einer Sprache anpasst und in der anderen
//      vergisst, hat zwei Fassungen, und die zweite fällt niemandem auf.
//
// ⚠️ Der Fall liest QUELLTEXT und kein Verhalten — wie seine Geschwister in
// diesem Verzeichnis. Er hält die Gewohnheit, nicht die Absicht.

const FORM = fileURLToPath(new URL("../src/features/hosts/HostForm.tsx", import.meta.url));
const DIALOG = fileURLToPath(new URL("../src/features/hosts/HostCreateDialog.tsx", import.meta.url));
const MESSAGES_DE = fileURLToPath(new URL("../src/features/hosts/messages/de.ts", import.meta.url));
const MESSAGES_EN = fileURLToPath(new URL("../src/features/hosts/messages/en.ts", import.meta.url));
const ARCHIVE_INPUT = fileURLToPath(new URL("../../server/src/features/hosts/bootstrap/host-archive-input.ts", import.meta.url));
const ARCHIVE_ENV = fileURLToPath(new URL("../../server/src/features/hosts/bootstrap/host-archive-env.ts", import.meta.url));
const ARCHIVE_README = fileURLToPath(new URL("../../server/src/features/hosts/bootstrap/host-archive-readme.ts", import.meta.url));

/** Der Wert einer `export const NAME = "…"`-Zeile, ohne Kommentare drumherum. */
function constantOf(file, name) {
  const source = stripComments(readFileSync(file, "utf8"));
  const match = new RegExp(`\\b${name}\\s*=\\s*"([^"]*)"`).exec(source);
  return match ? match[1] : null;
}

/** Der Wert eines Nachrichtenschlüssels. */
function messageOf(file, key) {
  const source = stripComments(readFileSync(file, "utf8"));
  const match = new RegExp(`\\b${key}:\\s*"([^"]*)"`).exec(source);
  return match ? match[1] : null;
}

test("der vorbelegte Basispfad im Formular ist der, den das Paket wirklich trägt", () => {
  const inForm = constantOf(FORM, "DEFAULT_BIND_BASE_PATH");
  const inServer = constantOf(ARCHIVE_INPUT, "DEFAULT_BIND_BASE_PATH");
  assert.ok(inForm, "das Formular führt keinen vorbelegten Basispfad mehr");
  assert.ok(inServer, "der Archiv-Erzeuger führt keine Vorgabe mehr");
  assert.equal(inForm, inServer, "Dialog und Paket nennen verschiedene Pfade");
});

test("der Befehl im Hinweis ist der, den das Paket selbst nennt", () => {
  const command = messageOf(MESSAGES_DE, "hostDockerGidCommand");
  assert.ok(command, "der Schlüssel hostDockerGidCommand fehlt");

  // Er muss in BEIDEN Vorlagen des Pakets stehen: die `.env` trägt ihn als
  // Kommentar über der Zeile, die README als Schritt beziehungsweise als
  // Gegenprobe. Eine der beiden allein zurückzudrehen wäre sonst still
  // möglich — genau der Fund aus #4.
  for (const [file, label] of [
    [ARCHIVE_ENV, "host-archive-env.ts"],
    [ARCHIVE_README, "host-archive-readme.ts"]
  ]) {
    assert.ok(readFileSync(file, "utf8").includes(command), `„${command}" fehlt in ${label}`);
  }
});

test("die Befehle des Dialogs stehen so auch im Paket", () => {
  // ⚠️ Der Anlege-Dialog fasst seit D7c die drei Schritte auf dem Zielhost
  // zusammen — Ort, Rechte, Start. Die ausführliche Fassung steht in der
  // README IM Paket, und beide müssen dieselben Befehle nennen. Ein Betreiber,
  // dem der Dialog `chmod 600 .env` sagt und das Paket
  // `chmod 600 .env wg0.conf`, hat zwei Anleitungen und lässt nach der ersten
  // den privaten Schlüssel für alle lesbar liegen — gemessener Fund beim
  // Schreiben dieses Falls, der erste Entwurf des Dialogs nannte wirklich nur
  // die `.env`.
  // ⚠️ GEGEN GANZE ZEILEN geprüft und nicht mit `includes`. Der erste Entwurf
  // dieses Falls fragte `readme.includes(command)` — und war grün, als der
  // Dialog auf `sudo chmod 600 .env` gekürzt wurde, denn das ist ein Teilstring
  // von `sudo chmod 600 .env wg0.conf`. Ausgerechnet die gefährliche Richtung
  // ging also durch: die gekürzte Fassung lässt `wg0.conf` mit dem privaten
  // Schlüssel für alle lesbar liegen. Gemessen in der Mutationsprobe
  // „chmod-both" am 2026-09-07, die zuerst grün blieb.
  const lines = new Set(
    readFileSync(ARCHIVE_README, "utf8")
      .split("\n")
      .flatMap((line) => [...line.matchAll(/"([^"]*)"/g)].map((match) => match[1].trim()))
  );
  for (const key of ["hostArchiveStepPermissionsCommand", "hostArchiveStepStartCommand"]) {
    const command = messageOf(MESSAGES_DE, key);
    assert.ok(command, `der Schlüssel ${key} fehlt`);
    assert.ok(lines.has(command), `„${command}" steht in host-archive-readme.ts nicht als eigene Zeile`);
  }
});

test("Dialog und Paket legen den Arm in dasselbe Verzeichnis", () => {
  // Der Dialog sagt „lege es hier an", die README sagt „hier liegt es". Nennen
  // beide verschiedene Orte, sucht der Betreiber im zweiten Schritt an einer
  // Stelle, an der nichts ist — und zwar ohne Fehlermeldung, denn beide Wege
  // sind für sich gültig.
  const inDialog = constantOf(DIALOG, "DIRECTORY_NAME");
  const inServer = constantOf(ARCHIVE_README, "DIRECTORY_NAME");
  assert.ok(inDialog, "der Dialog führt keinen Verzeichnisnamen mehr");
  assert.ok(inServer, "der Archiv-Erzeuger führt keinen Verzeichnisnamen mehr");
  assert.equal(inDialog, inServer, "Dialog und Paket nennen verschiedene Verzeichnisse");
});

test("ein Befehl wird nicht übersetzt", () => {
  for (const key of [
    "hostDockerGidCommand",
    "hostBindBasePathCommand",
    "hostArchiveStepPermissionsCommand",
    "hostArchiveStepStartCommand"
  ]) {
    const de = messageOf(MESSAGES_DE, key);
    const en = messageOf(MESSAGES_EN, key);
    assert.ok(de, `${key} fehlt in de.ts`);
    assert.ok(en, `${key} fehlt in en.ts`);
    assert.equal(de, en, `${key} steht in de und en verschieden da`);
  }
});

test("die Leser dieses Falls finden wirklich etwas", () => {
  // ⚠️ Ohne diesen Fall wären die drei darüber grün, sobald ein Leser nichts
  // mehr findet: `constantOf` und `messageOf` geben dann `null` zurück, und
  // ein Vergleich von `null` mit `null` ginge durch. Die Zusagen oben fangen
  // das mit `assert.ok` je Seite ab — hier steht die Gegenprobe dazu.
  assert.equal(constantOf(ARCHIVE_INPUT, "DEFAULT_BIND_BASE_PATH"), "/home/docker");
  assert.equal(constantOf(FORM, "GIBT_ES_NICHT"), null);
  assert.equal(messageOf(MESSAGES_DE, "gibtEsNicht"), null);
  assert.match(messageOf(MESSAGES_DE, "hostDockerGidCommand"), /^stat /);
});
