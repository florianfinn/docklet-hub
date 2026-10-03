import test from "node:test";
import assert from "node:assert/strict";

import { DEFAULT_GLOBAL_THEME, DEFAULT_HOST_THEME, THEME_KNOBS } from "contract";

import { GLOBAL_KNOBS, HOST_KNOBS, parseGlobalTheme, parseHostDisplay } from "./input.js";

// Die Prüfung der Eingaben des Editors — ohne Datenbank, ohne Router.
//
// ⚠️ WAS HIER DIE EIGENTLICHE ZUSICHERUNG IST: dass ein unbekannter Wert ein
// FEHLER wird und nicht die Vorgabe. Ein stiller Rückfall wäre der Fall, den
// kein Test von selbst zeigt — die Route antwortete 200, die Oberfläche
// zeichnete etwas, und der Editor hielte seinen Tippfehler für angenommen.
//
// ⚠️ Die erwarteten Werte kommen aus `THEME_KNOBS` und sind hier NICHT noch
// einmal hingeschrieben. Ein Test, der die Liste abschreibt, prüft, dass zwei
// Abschriften gleich sind, und nicht, dass die Prüfung gegen die Quelle läuft.

/** Die erste Stufe einer Stellschraube — irgendein gültiger Wert. */
function firstStep(knob: keyof typeof THEME_KNOBS): string {
  return (THEME_KNOBS[knob].steps as readonly { name: string }[])[0].name;
}

test("die Reichweiten sind abgeleitet und nicht aufgezählt", () => {
  // Der Wächter `theme-schema.test.ts` hält dieselbe Ableitung gegen die
  // Vorgabesätze. Hier steht sie noch einmal aus der Sicht der Prüfung: was
  // `parseGlobalTheme` annimmt, ist genau das, was in `hub_theme` steht.
  assert.deepEqual([...GLOBAL_KNOBS].sort(), Object.keys(DEFAULT_GLOBAL_THEME).sort());
  assert.deepEqual([...HOST_KNOBS].sort(), Object.keys(DEFAULT_HOST_THEME).sort());
  // 11 seit B6/E4 (#5), vorher 7: die vier Stellschrauben des Terminals
  // (`terminalScheme`, `terminalSurface`, `terminalSize`,
  // `terminalScrollback`) tragen `scope: ["global"]`. Nachgezählt mit
  // `grep -c 'scope: \["global"\]' contract/src/presets.ts` → 11.
  assert.equal(GLOBAL_KNOBS.length, 11);
  assert.equal(HOST_KNOBS.length, 2);
});

/** Ein vollständiger, gültiger Satz für den Hub. */
function fullTheme(overrides: Record<string, string> = {}): Record<string, string> {
  return { ...DEFAULT_GLOBAL_THEME, ...overrides };
}

test("jede gültige Stufe jeder globalen Stellschraube kommt durch", () => {
  // Nicht ein Beispiel, sondern ALLE: eine Prüfung, die eine Stufe versehentlich
  // ausschließt, ist mit einem Beispiel unsichtbar.
  for (const knob of GLOBAL_KNOBS) {
    for (const step of THEME_KNOBS[knob].steps as readonly { name: string }[]) {
      const parsed = parseGlobalTheme({ theme: fullTheme({ [knob]: step.name }) });
      assert.ok(parsed.ok, `${knob} = ${step.name} wurde abgelehnt`);
      assert.equal((parsed.value as unknown as Record<string, string>)[knob], step.name);
    }
  }
});

test("der Rumpf trägt den Umschlag „theme“ und nichts daneben", () => {
  // Hausmuster von `PUT /session/language` (Vertrag aus #64 in der Fassung vom
  // 2026-09-06). Ein Rumpf, der heute genau der Satz wäre, müsste umgebaut
  // werden, sobald neben ihm ein zweites Feld steht.
  assert.equal(parseGlobalTheme(fullTheme()).ok, false, "ein Satz ohne Umschlag wurde angenommen");
  assert.equal(parseGlobalTheme({ theme: fullTheme(), extra: 1 }).ok, false);
  assert.equal(parseGlobalTheme({ theme: null }).ok, false);
  assert.ok(parseGlobalTheme({ theme: fullTheme() }).ok);
});

test("ein halber Satz ist ein Fehler und wird NICHT mit dem Gespeicherten zusammengeführt", () => {
  // ⚠️ Die Kehrtwende gegenüber dem ersten Auftragstext: eine Teilmenge hieße,
  // dass nach dem Schreiben ein Stand dasteht, der weder der alte noch der
  // neue ist.
  for (const knob of GLOBAL_KNOBS) {
    const partial = fullTheme();
    delete partial[knob];
    const parsed = parseGlobalTheme({ theme: partial });
    assert.equal(parsed.ok, false, `ohne „${knob}" kam der Satz durch`);
    assert.ok(parsed.ok === false && parsed.message.includes(knob));
  }
  assert.equal(parseGlobalTheme({ theme: {} }).ok, false);
});

test("der volle Satz kommt vollständig heraus", () => {
  const parsed = parseGlobalTheme({ theme: fullTheme({ scheme: "light" }) });
  assert.ok(parsed.ok);
  assert.deepEqual(parsed.value, { ...DEFAULT_GLOBAL_THEME, scheme: "light" });
  assert.deepEqual(Object.keys(parsed.value).sort(), [...GLOBAL_KNOBS].sort());
});

test("ein unbekannter WERT ist ein Fehler und kein Rückfall auf die Vorgabe", () => {
  const parsed = parseGlobalTheme({ theme: fullTheme({ scheme: "sepia" }) });
  assert.equal(parsed.ok, false);
  assert.ok(parsed.ok === false && parsed.message.includes("sepia"));
});

test("ein unbekannter SCHLÜSSEL ist ebenso ein Fehler", () => {
  // Der Tippfehler, den ein Schlüssel-Wert-Schema stillschweigend als neue
  // Zeile angelegt hätte.
  const parsed = parseGlobalTheme({ theme: { ...fullTheme(), shceme: "dark" } });
  assert.equal(parsed.ok, false);
  assert.ok(parsed.ok === false && parsed.message.includes("shceme"));
});

test("eine Stellschraube des Hosts ist keine des Hubs", () => {
  // `hue` und `ink` hängen am Arm und nicht am Hub. Ohne diese Trennung wäre
  // die Reichweite aus `THEME_KNOBS` eine Angabe ohne Wirkung.
  for (const knob of HOST_KNOBS) {
    const parsed = parseGlobalTheme({ theme: { ...fullTheme(), [knob]: firstStep(knob) } });
    assert.equal(parsed.ok, false, `${knob} kam als globale Stellschraube durch`);
  }
});

test("kein Objekt, kein Rumpf", () => {
  for (const body of [null, undefined, "dark", 7, ["dark"]]) {
    assert.equal(parseGlobalTheme(body).ok, false, `${JSON.stringify(body)} wurde angenommen`);
    assert.equal(parseHostDisplay(body).ok, false, `${JSON.stringify(body)} wurde angenommen`);
  }
});

test("die Darstellung eines Arms verlangt den Umschlag und beide Felder", () => {
  const both = parseHostDisplay({ display: { hue: "teal", ink: "card" } });
  assert.ok(both.ok);
  assert.deepEqual(both.value, { hue: "teal", ink: "card" });

  // Ohne Umschlag: abgelehnt.
  assert.equal(parseHostDisplay({ hue: "teal", ink: "card" }).ok, false);
  // Unvollständig: abgelehnt. „Nichts geschickt" und „auf Vorgabe gestellt"
  // sind sonst dieselbe Anfrage.
  assert.equal(parseHostDisplay({ display: { hue: "teal" } }).ok, false);
  assert.equal(parseHostDisplay({ display: { ink: "card" } }).ok, false);
  assert.equal(parseHostDisplay({ display: {} }).ok, false);
});

test("jeder Ton aus dem Vorrat und jede Stufe des Farbeinsatzes kommt durch", () => {
  for (const knob of HOST_KNOBS) {
    for (const step of THEME_KNOBS[knob].steps as readonly { name: string }[]) {
      const other = HOST_KNOBS.find((candidate) => candidate !== knob);
      assert.ok(other);
      const display = { [knob]: step.name, [other]: firstStep(other) };
      assert.ok(parseHostDisplay({ display }).ok, `${knob} = ${step.name} wurde abgelehnt`);
    }
  }
});

test("ein Ton, den es nicht gibt, ist ein Fehler", () => {
  // Die drei Zustandstöne sind in `presets.ts` ausdrücklich GESPERRT (D0: kein
  // Host soll aussehen wie eine Störung). Ein Editor, der „red" schickt, muss
  // es erfahren.
  const parsed = parseHostDisplay({ display: { hue: "red", ink: "head" } });
  assert.equal(parsed.ok, false);
  assert.ok(parsed.ok === false && parsed.message.includes("red"));
});

test("ein unbekannter Schlüssel am Arm ist ein Fehler", () => {
  const parsed = parseHostDisplay({ display: { hue: "teal", ink: "head", scheme: "dark" } });
  assert.equal(parsed.ok, false);
  assert.ok(parsed.ok === false && parsed.message.includes("scheme"));
});

test("die Meldung nennt die erlaubten Stufen", () => {
  // Sonst wäre der 400 zwar richtig und für den Editor trotzdem eine
  // Sackgasse.
  const parsed = parseHostDisplay({ display: { hue: "gold", ink: "head" } });
  assert.equal(parsed.ok, false);
  if (parsed.ok) return;
  for (const step of THEME_KNOBS.hue.steps) {
    assert.ok(parsed.message.includes(step.name), `„${step.name}" fehlt in der Meldung: ${parsed.message}`);
  }
});
