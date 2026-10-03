import type { KeyboardEvent as ReactKeyboardEvent } from "react";
import { useEffect, useId, useRef } from "react";
import { useTranslations } from "use-intl";

import { CodeLine } from "./YamlCode";
import { indentEdit, outdentEdit, type IndentEdit } from "./compose-indent";
import { highlightLines } from "./yaml-highlight";

// Das Textfeld, in dem eine Compose-Datei bearbeitet wird.
//
// ── DIE BAUART, UND WARUM GERADE DIESE ────────────────────────────────────
//
// Ein DURCHSICHTIGES `textarea` liegt genau über einem eingefärbten `pre`. Der
// Mensch tippt in das Textfeld, sieht aber die Farben darunter; sein Cursor
// steht sichtbar da, weil `caret-color` gesetzt bleibt.
//
// ⚠️ WARUM NICHT `contenteditable` (CodeJar und Verwandte). Der Inhalt eines
// `contenteditable` ist DOM, und der Browser fasst ihn an: er setzt beim Tippen
// geschützte Leerzeichen, macht aus einem Zeilenumbruch je nach Fassung ein
// `<br>` oder ein `<div>`, und beim Einfügen aus einer anderen Quelle bringt er
// Auszeichnung mit. Was hier bearbeitet wird, geht als DATEI an `compose up` —
// und in YAML ist ein geschütztes Leerzeichen kein Leerzeichen, sondern ein
// anderes Zeichen. Ein Textfeld hat als Inhalt eine Zeichenkette, und die geht
// zeichengenau hinaus.
//
// Dazu kommt, was ein Textfeld ohne Zutun mitbringt und ein `contenteditable`
// nachbauen müsste: Rückgängig und Wiederholen des Browsers, die Eingabehilfen
// für Sprachen mit Vorschlagsleiste, das Einfügen als reiner Text, die
// Rechtschreibprüfung abschaltbar, und — nicht zuletzt — ein `value`, das
// React kontrollieren kann.
//
// ⚠️ DIE DREI SCHICHTEN MÜSSEN ZEICHENGENAU ÜBEREINSTIMMEN. Schriftart,
// Schriftgrad, Zeilenhöhe, Innenabstand und Umbruchverhalten stehen deshalb an
// EINER Stelle (`LAYER`) und werden von beiden Schichten benutzt. Eine
// Abweichung von einem halben Pixel verschiebt den Cursor gegenüber dem
// gefärbten Text, und zwar mit jeder Zeile weiter.
//
// ⚠️ `whitespace-pre` UND NICHT `pre-wrap`, in beiden Schichten. Ein Umbruch
// wäre nicht das Problem — ein UNTERSCHIEDLICHER Umbruch wäre es: das Textfeld
// und die Anzeige darunter müssten an derselben Stelle umbrechen, und das
// hängt an Details, die kein Test hier nachstellt. Lange Zeilen rollen
// waagerecht, und beide Schichten rollen gemeinsam.
//
// ── TAB RÜCKT EIN, UND DER WEG HINAUS BLEIBT OFFEN (#135) ─────────────────
//
// YAML ist einrückungsabhängig, und ein Textfeld gibt die Tabulatortaste
// gewöhnlich an den Fokuswechsel weiter: einrücken ging hier nur über die
// Leertaste. Tab und Shift+Tab setzen deshalb Einrückung (`compose-indent.ts`
// rechnet, was sich dabei ändert).
//
// ⚠️ EIN FELD, DAS TAB SCHLUCKT, IST EINE FALLE FÜR DIE TASTATURBEDIENUNG —
// wer ohne Zeiger arbeitet, kommt aus ihm nicht mehr heraus. Zwei Wege bleiben
// darum offen, und beide sind Absicht:
//
//   * ESCAPE, DANN TAB. Escape entwaffnet das Feld für genau einen
//     Tastendruck; das folgende Tab geht an den Browser und setzt den Fokus
//     weiter. Jede andere Taste stellt die Einrückung wieder her — sonst
//     verlöre der Betreiber sie nach jedem Escape still.
//   * SHIFT+TAB AUF EINER NICHT EINGERÜCKTEN ZEILE. Dort gibt es nichts
//     wegzunehmen, und die Taste tut, was sie überall tut: sie geht rückwärts
//     aus dem Feld.
//
// ⚠️ DIE ÄNDERUNG GEHT ÜBER `insertText` UND NICHT ÜBER EINE ZUWEISUNG AN
// `value`. Der Kopf dieser Datei zählt das Rückgängig des Browsers zu dem,
// wofür hier ein Textfeld steht und kein `contenteditable`. Eine Zuweisung
// verlöre genau das: der Stapel des Browsers kennt nur, was durch seine
// eigenen Bearbeitungsbefehle ging. Der Rückweg über `setRangeText` steht
// daneben für den Fall, dass der Befehl nicht ausgeführt wird — er ändert
// denselben Bereich, nur ohne Eintrag im Stapel.

/**
 * Die Schriftmasse beider Schichten.
 *
 * ⚠️ EINE Konstante und nicht zweimal dieselben Klassen. Zwei Abschriften sind
 * zwei Wahrheiten: wer die eine auf 13 Pixel stellt, stellt die andere nicht
 * um, und der Cursor läuft aus dem Text heraus — sichtbar erst ab Zeile
 * zwanzig, also nicht beim Ausprobieren.
 */
const LAYER = "font-mono text-[12.5px] leading-[1.55] px-3 py-3";

export type ComposeEditorProps = {
  value: string;
  onChange: (value: string) => void;
  /** Ob das Feld schreibbar ist. */
  disabled?: boolean;
};

export function ComposeEditor({ value, onChange, disabled = false }: ComposeEditorProps) {
  const t = useTranslations();
  const areaRef = useRef<HTMLTextAreaElement>(null);
  const paintRef = useRef<HTMLPreElement>(null);
  const gutterRef = useRef<HTMLDivElement>(null);
  const hintId = useId();

  // Ob das nächste Tab aus dem Feld führt (siehe „Escape, dann Tab" im Kopf).
  const exitArmed = useRef(false);
  // Wo die Auswahl nach der nächsten Wertänderung stehen soll.
  const nextSelection = useRef<{ start: number; end: number } | null>(null);

  const lines = highlightLines(value);

  // ⚠️ DIE SCHICHTEN ROLLEN GEMEINSAM, und das muss von Hand geschehen: nur das
  // Textfeld bekommt die Rollereignisse, die anderen beiden liegen darunter
  // und werden vom Zeiger nie berührt. Ohne diese Kopplung stünde der gefärbte
  // Text still, während der Cursor nach rechts wandert — die Fläche sähe
  // schlicht kaputt aus.
  const syncScroll = (): void => {
    const area = areaRef.current;
    if (!area) return;
    if (paintRef.current) {
      paintRef.current.scrollTop = area.scrollTop;
      paintRef.current.scrollLeft = area.scrollLeft;
    }
    // Die Nummernspalte folgt NUR senkrecht: sie soll beim waagerechten Rollen
    // stehen bleiben, sonst verschwindet sie aus dem Bild.
    if (gutterRef.current) gutterRef.current.scrollTop = area.scrollTop;
  };

  // Nach einer Änderung von außen (Neuladen, Verwerfen) stimmt die Rollhöhe
  // nicht mehr. Ohne diesen Abgleich stünden die Nummern versetzt, bis jemand
  // das nächste Mal rollt.
  //
  // Hier steht auch die zweite Hälfte der Einrückung: React zeichnet das Feld
  // mit dem neuen Wert neu, und eine Auswahl, die das Bauteil vor dem Zeichnen
  // gesetzt hat, kann dabei verloren gehen. Sie wird deshalb nach dem Zeichnen
  // noch einmal gesetzt — nach einem Tab auf zehn markierten Zeilen stünde der
  // Cursor sonst am Ende des Blocks statt auf ihm.
  useEffect(() => {
    syncScroll();
    const place = nextSelection.current;
    nextSelection.current = null;
    if (place && areaRef.current) areaRef.current.setSelectionRange(place.start, place.end);
  }, [value]);

  /**
   * Setzt eine Ersetzung ein und merkt sich die Auswahl danach.
   *
   * ⚠️ ZUERST DEN BEREICH MARKIEREN, DANN EINFÜGEN. `insertText` arbeitet auf
   * der Auswahl und kennt keine Positionsangabe; ohne die Markierung landete
   * die Einrückung an der Schreibstelle statt am Zeilenanfang.
   */
  const applyEdit = (area: HTMLTextAreaElement, edit: IndentEdit): void => {
    area.setSelectionRange(edit.from, edit.to);
    let inserted: boolean;
    try {
      inserted = document.execCommand("insertText", false, edit.text);
    } catch {
      // Kein `execCommand` in dieser Welt — unter happy-dom ist das der
      // Regelfall (`compose-editor.test.tsx`).
      inserted = false;
    }
    if (!inserted) {
      area.setRangeText(edit.text, edit.from, edit.to, "end");
      // `setRangeText` löst kein `input`-Ereignis aus: ohne diesen Aufruf
      // stünde die Änderung im Feld und nirgends sonst — der Entwurf des
      // Reiters wüsste nichts von ihr, und der nächste Tastendruck
      // überschriebe sie mit dem alten Stand.
      onChange(area.value);
    }
    area.setSelectionRange(edit.start, edit.end);
    nextSelection.current = { start: edit.start, end: edit.end };
  };

  const onKeyDown = (event: ReactKeyboardEvent<HTMLTextAreaElement>): void => {
    if (event.key === "Escape") {
      exitArmed.current = true;
      return;
    }
    if (event.key !== "Tab") {
      exitArmed.current = false;
      return;
    }
    if (exitArmed.current) {
      exitArmed.current = false;
      return;
    }

    const area = event.currentTarget;
    const caret = { value: area.value, start: area.selectionStart, end: area.selectionEnd };
    const edit = event.shiftKey ? outdentEdit(caret) : indentEdit(caret);
    // `null` heißt: nichts auszurücken. Die Taste bleibt dann der Fokuswechsel.
    if (edit === null) return;

    event.preventDefault();
    applyEdit(area, edit);
  };

  return (
    <div className="relative flex overflow-hidden">
      <div
        ref={gutterRef}
        aria-hidden="true"
        className={`${LAYER} shrink-0 select-none overflow-hidden border-r border-border bg-card text-right text-subtle-foreground`}
      >
        {lines.map((_, index) => (
          <div key={index}>{index + 1}</div>
        ))}
      </div>

      <div className="relative flex-1">
        {/* Die gefärbte Schicht. `aria-hidden`, weil das Textfeld darüber
            denselben Text bereits trägt — eine Vorlesehilfe läse ihn sonst
            zweimal. */}
        <pre
          ref={paintRef}
          aria-hidden="true"
          className={`${LAYER} pointer-events-none absolute inset-0 overflow-hidden whitespace-pre`}
        >
          {lines.map((pieces, index) => (
            <div key={index}>
              <CodeLine pieces={pieces} />
            </div>
          ))}
        </pre>

        {/* ⚠️ `text-transparent` UND `caret-foreground`: der Text des Feldes ist
            unsichtbar, sein Cursor nicht. Ohne das zweite tippte der Betreiber
            blind.

            ⚠️ `resize-none`: ein gezogener Rahmen änderte die Höhe des Feldes,
            nicht die der gefärbten Schicht darunter.

            ⚠️ `spellCheck={false}`: eine Rechtschreibprüfung unterkringelte
            jeden Image-Namen. */}
        <textarea
          ref={areaRef}
          value={value}
          onChange={(event) => onChange(event.target.value)}
          onScroll={syncScroll}
          disabled={disabled}
          spellCheck={false}
          autoCapitalize="off"
          autoCorrect="off"
          aria-label={t("composeEditLabel")}
          aria-describedby={hintId}
          onKeyDown={onKeyDown}
          data-testid="compose-editor"
          className={`${LAYER} relative h-full w-full resize-none overflow-auto whitespace-pre bg-transparent text-transparent caret-foreground outline-none`}
        />

        {/* Der Weg aus dem Feld als Beschreibung des Feldes. Sichtbar wäre er
            eine Zeile unter dem Editor, die jeder liest, der sie nicht
            braucht; wer ohne Zeiger arbeitet, bekommt sie beim Betreten des
            Feldes vorgelesen und genau dann, wenn sie zählt.

            ⚠️ DERSELBE SCHLÜSSEL STEHT EIN ZWEITES MAL IN `ComposeView` (#157),
            als Tooltip an einem Symbol in der Kopfkarte — für den Zeiger, der
            hier nichts zu sehen bekäme. Zwei AUFTRITTE desselben Textes, nicht
            zwei Fassungen: wer den Satz ändert, ändert `composeEditKeyboardHint`
            und damit beide. */}
        <p id={hintId} className="sr-only">
          {t("composeEditKeyboardHint")}
        </p>
      </div>
    </div>
  );
}
