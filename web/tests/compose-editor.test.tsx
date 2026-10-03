// ⚠️ Die Reihenfolge der Importe ist BEDEUTUNG: der DOM muss stehen, bevor
// React geladen wird (siehe `dom-harness.tsx`).
import { renderInDom } from "./dom-harness.js";

import React from "react";

import assert from "node:assert/strict";
import test from "node:test";

import { AppLanguageProvider } from "../src/app/i18n/AppLanguageProvider.js";
import { ComposeEditor } from "../src/features/compose/ComposeEditor.js";

// WAS DIESE DATEI PRÜFT UND WARUM GERADE DAS
//
// Was Tab am TEXT tut, steht als reine Rechnung in `compose-indent.test.mjs`.
// Hier steht die andere Hälfte von #135, und sie ist die, die man beim Bauen
// verliert:
//
//   1. DIE TASTE MUSS ANKOMMEN. Ein Feld ohne `onKeyDown` sieht im Bild genau
//      so aus wie eines mit — der Unterschied zeigt sich erst an der Datei,
//      die später hinausgeht.
//   2. DER WEG AUS DEM FELD MUSS BLEIBEN. Ein Feld, das Tab in jedem Fall
//      schluckt, sperrt jeden ein, der ohne Zeiger arbeitet. Die beiden
//      Ausgänge — Escape gefolgt von Tab, und Shift+Tab auf einer nicht
//      eingerückten Zeile — sind kein Beiwerk, sondern die Bedingung, unter
//      der die Einrückung überhaupt eingebaut werden durfte.
//   3. DER ENTWURF MUSS ES ERFAHREN. Die Änderung entsteht am DOM-Knoten und
//      nicht über React. Bleibt `onChange` dabei stumm, steht die Einrückung
//      im Feld und nirgends sonst, und der nächste Tastendruck überschreibt
//      sie mit dem alten Stand.
//
// ⚠️ GEPRÜFT WIRD DER RÜCKWEG ÜBER `setRangeText`, NICHT DER REGELWEG ÜBER
// `insertText`. `document.execCommand` gibt es unter happy-dom nicht (gemessen
// am 2026-09-09: `typeof document.execCommand` ist `undefined`), das Bauteil
// fängt das und weicht aus. Beide Wege ändern denselben Bereich; was der
// Regelweg zusätzlich kann — der Eintrag im Rückgängig-Stapel des Browsers —
// ist hier nicht prüfbar und steht als Lücke da, statt als Behauptung.

const YAML = "services:\nweb:\n  image: nginx";

/**
 * Das Feld mit einem Entwurf dahinter — so, wie `ComposeView` es hält.
 *
 * ⚠️ EIN ZUSTAND UND KEINE FESTE ZEICHENKETTE. Das Feld ist kontrolliert: ohne
 * einen Wert, der zurückkommt, stünde nach jedem Tastendruck wieder der
 * Anfangstext da, und jeder Fall hier wäre grün, ohne etwas zu belegen.
 */
function Harness({ start, onValue }: { start: string; onValue: (value: string) => void }) {
  const [value, setValue] = React.useState(start);
  return (
    <ComposeEditor
      value={value}
      onChange={(next) => {
        setValue(next);
        onValue(next);
      }}
    />
  );
}

type Field = {
  area: HTMLTextAreaElement;
  changes: string[];
  unmount: () => Promise<void>;
};

async function mount(start = YAML): Promise<Field> {
  const changes: string[] = [];
  const { container, unmount } = await renderInDom(
    <AppLanguageProvider>
      <Harness start={start} onValue={(value) => changes.push(value)} />
    </AppLanguageProvider>
  );
  const area = container.querySelector("[data-testid='compose-editor']");
  assert.ok(area instanceof HTMLTextAreaElement, "das Textfeld des Editors steht da");
  return { area, changes, unmount };
}

/**
 * Drückt eine Taste im Feld und sagt, ob das Feld sie verbraucht hat.
 *
 * `defaultPrevented === false` heißt: der Browser macht mit ihr weiter — bei
 * Tab also den Fokuswechsel. Genau daran hängt der Weg aus dem Feld.
 */
async function press(
  area: HTMLTextAreaElement,
  key: string,
  options: { shift?: boolean; at?: [number, number] } = {}
): Promise<boolean> {
  if (options.at) area.setSelectionRange(options.at[0], options.at[1]);
  const event = new KeyboardEvent("keydown", {
    key,
    shiftKey: options.shift ?? false,
    bubbles: true,
    cancelable: true
  });
  await React.act(async () => {
    area.dispatchEvent(event);
  });
  return event.defaultPrevented;
}

test("Tab rückt im Feld ein, statt es zu verlassen", async () => {
  const { area, changes, unmount } = await mount();
  // Der Cursor steht am Anfang der zweiten Zeile („web:").
  const consumed = await press(area, "Tab", { at: [10, 10] });

  assert.ok(consumed, "das Feld reicht Tab an den Fokuswechsel weiter — einrücken geht nur über die Leertaste");
  assert.equal(area.value, "services:\n  web:\n  image: nginx");
  assert.deepEqual(changes, ["services:\n  web:\n  image: nginx"], "der Entwurf des Reiters erfährt von der Einrückung nichts");
  assert.equal(area.selectionStart, 12, "der Cursor steht nicht hinter der Einrückung");
  await unmount();
});

test("Shift+Tab nimmt die Einrückung wieder weg", async () => {
  const { area, unmount } = await mount();
  // In der dritten Zeile, die zwei Leerzeichen trägt.
  const consumed = await press(area, "Tab", { shift: true, at: [20, 20] });

  assert.ok(consumed, "Shift+Tab bleibt der Fokuswechsel, obwohl es etwas auszurücken gibt");
  assert.equal(area.value, "services:\nweb:\nimage: nginx");
  await unmount();
});

// ── Die beiden Ausgänge ─────────────────────────────────────────────────────

test("Escape und danach Tab führen aus dem Feld heraus", async () => {
  const { area, changes, unmount } = await mount();
  await press(area, "Escape", { at: [10, 10] });
  const consumed = await press(area, "Tab");

  assert.ok(
    !consumed,
    "das Feld schluckt Tab auch nach Escape — wer ohne Zeiger arbeitet, kommt aus dem Editor nicht mehr heraus"
  );
  assert.equal(area.value, YAML, "der Weg hinaus hat trotzdem eingerückt");
  assert.deepEqual(changes, [], "der Weg hinaus hat den Entwurf angefasst");
  await unmount();
});

test("nach einer anderen Taste rückt Tab wieder ein", async () => {
  const { area, unmount } = await mount();
  await press(area, "Escape", { at: [10, 10] });
  // Irgendeine Taste dazwischen — hier ein Pfeil, weil er nichts schreibt.
  await press(area, "ArrowDown");
  const consumed = await press(area, "Tab", { at: [10, 10] });

  assert.ok(consumed, "das Feld bleibt nach dem Escape dauerhaft entwaffnet — die Einrückung wäre still verloren");
  assert.equal(area.value, "services:\n  web:\n  image: nginx");
  await unmount();
});

test("Shift+Tab auf einer nicht eingerückten Zeile geht rückwärts aus dem Feld", async () => {
  const { area, unmount } = await mount();
  const consumed = await press(area, "Tab", { shift: true, at: [10, 10] });

  assert.ok(!consumed, "das Feld schluckt Shift+Tab auch dort, wo es nichts zu tun gibt");
  assert.equal(area.value, YAML);
  await unmount();
});

// ── Der Hinweis ─────────────────────────────────────────────────────────────

test("das Feld nennt den Weg hinaus, wo eine Vorlesehilfe ihn findet", async () => {
  const { area, unmount } = await mount();
  const hintId = area.getAttribute("aria-describedby");
  assert.ok(hintId, "das Feld verweist auf keine Beschreibung");

  const hint = document.getElementById(hintId);
  assert.ok(hint !== null, "die Beschreibung, auf die das Feld verweist, steht nicht im Dokument");
  assert.match(hint.textContent ?? "", /Escape/, "der Hinweis nennt den Weg aus dem Feld nicht");
  await unmount();
});
