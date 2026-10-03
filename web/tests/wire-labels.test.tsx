// Was passiert, wenn die Gegenseite einen Wert schickt, den diese Fläche nicht
// kennt (#5, Nachtrag zu Paket B5).
//
// ⚠️ Die Reihenfolge der Importe ist BEDEUTUNG und keine Formatierung: der DOM
// muss stehen, bevor React geladen wird (siehe `dom-harness.tsx`). Wer hier
// alphabetisch sortiert, bekommt „document is not defined".
import { renderInDom } from "./dom-harness.js";

// ⚠️ React steht hier NAMENTLICH, obwohl keine Zeile es aufruft — `tsx`
// übersetzt das JSX dieser Datei mit dem alten Laufzeitmodell
// (`React.createElement`). Die Begründung samt Messung steht im Kopf von
// `language-switch.test.tsx`.
import React from "react";

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { useTranslations } from "use-intl";

import type { SessionUser } from "../src/platform/session/session-user.js";
import { AppLanguageProvider } from "../src/app/i18n/AppLanguageProvider.js";
import { ProfilePanel } from "../src/features/account/ProfilePanel.js";
import { HostStatusBadge } from "../src/domain/hosts/index.js";
import { ContainerStateDot } from "../src/features/containers/container-state.js";

// WAS DIESE DATEI PRÜFT UND WARUM GERADE DAS
//
// Ein gemessener Fehler, kein erdachter. Am 2026-09-07 stand an der gebauten
// Fassung in der Konsole, sobald IRGENDEINE Container-Zeile gezeichnet wurde:
//
//     MISSING_MESSAGE: Cannot read properties of undefined (reading 'split')
//
// Ursache war `t(STATE_KEYS[state])` — eine Tabelle `Record<ContainerState,
// keyof Messages>`, indiziert mit einem Wert, der über die Leitung kam. `tsc`
// erlaubt den Zugriff ohne `| undefined`, weil der Typ geschlossen ist; die
// ANTWORT hält sich daran aber nicht notwendig.
//
// ⚠️ WARUM DAS KEIN BESTEHENDER WÄCHTER SIEHT:
//   * `languages.test.mjs` hält Schlüssel gegen Schlüssel — beide Sprachen
//     tragen dieselben, und jeder Schlüssel wird benutzt. Ein AUFRUF mit
//     `undefined` ist kein Schlüssel und kommt in keiner der Listen vor.
//   * `ui-texts.test.mjs` sucht festen Text im JSX. Hier steht kein Text.
//   * `tsc` sieht eine Tabelle, die über ihrem Typ vollständig ist.
//   * Und der Bau bleibt grün: `use-intl` FÄNGT den Fehler ab und zeichnet
//     einen Rückfall. Man sieht nichts. Genau deshalb stand er wochenlang da.
//
// ⚠️ WAS DIE ZUSICHERUNGEN MESSEN, IST NICHT DIE KONSOLENZEILE, SONDERN IHRE
// FOLGE. Beim Punkt des Containers ist der unsichtbare Text der EINZIGE
// Träger seiner Aussage (siehe `container-state.tsx`); er verschwand still.
// Bei der Marke eines Arms blieb die Marke leer, und leer sieht aus wie „kein
// Zustand" und nicht wie ein Fehler. Deshalb prüft jeder Fall unten BEIDES:
// dass kein Fehler fliegt UND dass etwas Lesbares dasteht.
//
// NICHT geprüft: dass der Server solche Werte je schickt. Er tut es heute
// nicht — `ContainerState` ist am Server geschlossen. Der Fall ist die
// FASSUNGSDIFFERENZ: ein Hub, der älter ist als sein Server, und ein Feld, das
// eine Antwort nicht trägt. Beides ist im Betrieb der Normalfall und nicht die
// Ausnahme.

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, "..", "..");
const WEB_SOURCE_ROOT = resolve(HERE, "..", "src");

/**
 * Zeichnet einen Baum und gibt zurück, was `use-intl` dabei bemängelt hat.
 *
 * ⚠️ Über `console.error` und nicht über `onError` am Anbieter: geprüft werden
 * soll der Weg, den die Anwendung wirklich nimmt — `LanguageProvider` reicht
 * kein `onError` durch, und die Vorgabe der Bibliothek ist genau diese
 * Ausgabe. Ein eigener Anbieter im Test prüfte einen Aufbau, den es im
 * Programm nicht gibt.
 */
async function drawAndCollect(node: React.ReactNode): Promise<{ errors: string[]; text: string; html: string }> {
  const errors: string[] = [];
  const original = console.error;
  console.error = (...args: unknown[]) => {
    errors.push(args.map((entry) => String(entry)).join(" "));
  };
  let mounted;
  try {
    mounted = await renderInDom(<AppLanguageProvider>{node}</AppLanguageProvider>);
  } finally {
    console.error = original;
  }
  const text = mounted.container.textContent ?? "";
  const html = mounted.container.innerHTML;
  await mounted.unmount();
  return { errors: errors.filter((entry) => entry.includes("MISSING_MESSAGE")), text, html };
}

// ── Zusicherung 0: der Erkenner selbst ──────────────────────────────────────
//
// ⚠️ SIE STEHT ZUERST UND NICHT ZULETZT. Ohne sie wären alle Fälle darunter
// grün, sobald `drawAndCollect` nichts mehr auffängt — eine Fassung von
// `use-intl`, die anders meldet, ein Testläufer, der `console.error` selbst
// ersetzt, ein Tippfehler im Filter. „Kein Fehler gefunden" ist eine Aussage
// über den Sucher, solange nicht feststeht, dass er finden KANN.
function Broken() {
  const t = useTranslations();
  // Genau der Aufruf, um den es geht — hier absichtlich.
  return <span>{t(undefined as never)}</span>;
}

test("der Erkenner selbst: ein t(undefined) wird gesehen", async () => {
  const { errors } = await drawAndCollect(<Broken />);
  assert.equal(
    errors.length >= 1,
    true,
    "Ein absichtliches `t(undefined)` blieb unbemerkt. Dann sagt keine der Zusicherungen " +
      "darunter etwas aus — sie sind grün, weil nichts gemessen wird, und nicht, weil " +
      "nichts kaputt ist."
  );
  assert.match(errors[0] ?? "", /MISSING_MESSAGE/);
});

// ── Zusicherung 1: der Punkt am Container ───────────────────────────────────

test("ein Zustand, den diese Fläche nicht kennt, lässt den Punkt sprechen", async () => {
  const { errors, text } = await drawAndCollect(<ContainerStateDot state={"running" as never} />);

  assert.deepEqual(errors, [], "Ein unbekannter Zustand darf `t(…)` nicht mit `undefined` erreichen");
  // Der unsichtbare Text ist die einzige Aussage dieses Punktes. Er muss den
  // rohen Wert nennen — „unbekannt" allein sagte nicht, WAS unbekannt ist.
  assert.match(text, /running/, "Der Text nennt den Wert der Gegenseite nicht");
  assert.notEqual(text.trim(), "", "Der Text für den Screenreader ist verschwunden");
});

test("fehlt das Feld ganz, gilt dasselbe", async () => {
  // Der Fall der Fassungsdifferenz: eine Antwort ohne `state`. Genau so ist
  // der Fehler am 2026-09-07 aufgetreten.
  const { errors, text } = await drawAndCollect(<ContainerStateDot state={undefined as never} />);

  assert.deepEqual(errors, []);
  assert.notEqual(text.trim(), "");
});

test("der Punkt bleibt sichtbar, auch wenn niemand seinen Zustand kennt", async () => {
  // ⚠️ Die Klassentabelle ist derselbe Fehler ohne Fehlermeldung: ein
  // `undefined` fällt in `cn(…)` lautlos heraus, und ein Punkt ohne
  // Hintergrundfarbe ist durchsichtig. Auf keiner Fläche sieht das nach einem
  // Fehler aus — es sieht nach gar nichts aus.
  const { html } = await drawAndCollect(<ContainerStateDot state={"running" as never} />);
  assert.match(html, /\bbg-[a-z-]+\b/, "Der Punkt trägt keine Hintergrundfarbe mehr");
});

test("die drei bekannten Zustände melden nichts", async () => {
  for (const state of ["ok", "warn", "down"] as const) {
    const { errors, text } = await drawAndCollect(<ContainerStateDot state={state} />);
    assert.deepEqual(errors, [], `Zustand ${state}`);
    assert.notEqual(text.trim(), "", `Zustand ${state} ohne Text`);
  }
});

// ── Zusicherung 2: die Marke eines Arms ─────────────────────────────────────

test("ein Status, den diese Fläche nicht kennt, lässt die Marke nicht leer", async () => {
  const { errors, text } = await drawAndCollect(<HostStatusBadge status={"draining" as never} />);

  assert.deepEqual(errors, []);
  assert.match(text, /draining/, "Die Marke nennt den Wert der Gegenseite nicht");
});

// ── Zusicherung 3: die Rolle ────────────────────────────────────────────────

test("eine Rolle, die diese Fläche nicht kennt, lässt die Marke nicht leer", async () => {
  // ⚠️ Der Typ wird ERFÜLLT und nicht umgangen — bis auf das eine Feld, um das
  // es geht. `as SessionUser` über dem ganzen Gebilde hätte hier ein fehlendes
  // `language` verdeckt; gemessen am 2026-09-07 fiel genau das erst `tsc` auf,
  // nachdem der Testlauf unter `tsx` längst grün war.
  const user: SessionUser = {
    id: "user-1",
    name: "Betreiber",
    email: "betreiber@example.test",
    language: "de",
    role: "auditor" as never
  };

  const { errors, text } = await drawAndCollect(<ProfilePanel user={user} />);

  assert.deepEqual(errors, []);
  assert.match(text, /auditor/, "Die Rolle nennt den Wert der Gegenseite nicht");
});

// ── Zusicherung 4: die Sperrklinke ──────────────────────────────────────────
//
// FÄNGT: dass jemand `knownKey(…)` an einer der abgesicherten Stellen wieder
// durch einen unmittelbaren Zugriff ersetzt. Die Fälle oben decken drei
// Stellen ab; abgesichert sind zehn, und die übrigen sieben stehen auf
// Flächen, die einzeln zu zeichnen mehr Vorrichtung als Aussage wäre (die
// Kopfzeile einer Host-Karte, die Kontenliste, die Seitenleiste, vier
// Auswahlfelder der Einstellungen).
//
// ⚠️ MESSWEG, hier wie überall in diesem Repo (`.claude/subagent-profile.md`):
// die Marke vorübergehend auf `>= 999` setzen, die Zahl aus der Meldung dieses
// Falls lesen, das Original mit `git show HEAD:<pfad> > <pfad>` zurückstellen.
// Gemessen am 2026-09-07: 10 (Meldung „nur 10 Aufrufe von knownKey"). Es sind
// sechs Bildschirm-Dateien mit je einem Aufruf und zwei mit je zweien
// (`HostColorPanel` für Ton und Farbeinsatz, `MarksPanel` für Ton und
// Darstellung). Eine Marke wird beim Wachsen des Bestands
// nachgezogen und nur gesenkt, wenn eine Aufrufstelle nachweislich entfallen
// ist — mit dem Grund daneben.
const CALL = /\bknownKey\s*\(/g;

test("die Absicherung steht an mindestens zehn Stellen", () => {
  const listed = execFileSync("git", ["ls-files", "web/src"], { cwd: REPO_ROOT, encoding: "utf8" })
    .split("\n")
    .filter((line) => line.endsWith(".ts") || line.endsWith(".tsx"))
    // Die Datei, die `knownKey` DEFINIERT, ist keine Aufrufstelle.
    .filter((line) => !line.endsWith("i18n/wire-labels.ts"));

  assert.ok(
    listed.length > 0,
    "`git ls-files web/src` liefert nichts — dann zählt dieser Fall Aufrufe in einer leeren " +
      "Menge und ist grün, ohne etwas zu halten. Das ist ein Befund am Wächter."
  );

  let calls = 0;
  for (const relative of listed) {
    const body = readFileSync(join(REPO_ROOT, relative), "utf8");
    calls += [...body.matchAll(CALL)].length;
  }

  assert.ok(
    calls >= 10,
    `nur ${calls} Aufrufe von knownKey unter ${WEB_SOURCE_ROOT} — erwartet werden mindestens 9 ` +
      "(gemessen am 2026-09-07). Entweder ist eine Absicherung entfallen — dann gehört die Zahl " +
      "hier heruntergesetzt und der Grund daneben — oder eine Tabelle wird wieder unmittelbar " +
      "indiziert, und dann steht der Fehler von 2026-09-07 wieder da."
  );
});
