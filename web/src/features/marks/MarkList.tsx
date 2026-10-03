import { X } from "lucide-react";
import { useTranslations } from "use-intl";

import type { MarkView } from "contract";

import { cn } from "../../platform/ui/lib/cn";
import { MarkChip } from "../../platform/ui/marks";

// Die eigenen Marken EINES Ziels, wie sie an einer Zeile oder an einer
// Überschrift stehen (D7b/C1, #62).
//
// ⚠️ SIE SIND NICHT DIE SYSTEMMARKEN. „Update", „neu", „zu alt" vergibt der
// Hub aus der Antwort des Agenten, sie sind gefüllt und legen eine Handlung
// nahe; die Marken hier vergibt der Betreiber, sie laufen auf halber Sättigung
// und ordnen nur (docs/design/hub-color-and-structure.md §3). Der Unterschied
// steckt im Bauteil `MarkChip` und nicht in dieser Liste.
//
// ⚠️ WARUM EIN EIGENES BAUTEIL UND NICHT DREIMAL DIESELBEN VIER ZEILEN. Die
// Marken stehen an vier Stellen: an der Container-Zeile (`ContainerRow`, die
// allein drei Flächen trägt), an der Stack-Zeile der Übersicht (`StackRow`),
// am Stack-Kopf des Deepdives (`StackSection`) und auf der Seite eines Stacks
// (`StackScreen`). Der Deckel ist die Regel, die dabei auseinanderliefe: er
// gilt an den drei Zeilen und ausdrücklich nicht auf der Seite.
//
// ⚠️ HIER STEHT KEIN `data-hue`. Es steht in `MarkChip`, zusammen mit
// `data-mark` und `data-mark-style` auf DEMSELBEN Element wie die Klassen, die
// die Variablen lesen — eine CSS-Variable löst dort auf, wo sie deklariert ist
// (docs/design/hub-color-and-structure.md §8). Nebenbei hält das den Wächter
// `web/tests/host-palette.test.mjs` (Prüfung 2) scharf: der verlangt für jedes
// `data-hue` unter `web/src/app/screens/`, dass sein Wert über `hostDisplay(…)`
// kommt — das ist der Ausdruck für die Farbe eines ARMS, und eine Marke holt
// ihren Ton anders.

export type MarkListProps = {
  /**
   * Die Marken des Ziels, in der Reihenfolge des Betreibers.
   *
   * ⚠️ Sie wird NICHT neu sortiert — auch nicht nach Namen. Der Betreiber hat
   * sie so vergeben, und eine Sortierung wäre eine zweite Ordnung neben seiner.
   */
  marks: readonly MarkView[];
  /**
   * Wie viele Marken höchstens einzeln stehen; der Rest wird gezählt.
   * `undefined` heißt „alle" und ist der Fall der Stack-Seite.
   */
  limit?: number;
  /**
   * Gesetzt, trägt jede Marke ein Kreuz, das sie abzieht (nur Admin, nur im
   * Deepdive). Die Aufrufstelle schreibt, schickt den Rest der Liste, sperrt
   * gegen den zweiten Klick und meldet einen Fehler — hier steht nichts davon.
   */
  onRemove?: (mark: MarkView) => void;
  className?: string;
};

/**
 * Die Marken eines Ziels, mit Deckel.
 *
 * ⚠️ EIN CONTAINER IN EINEM STACK BEKOMMT HIER SEINE EIGENEN MARKEN UND NICHT
 * DIE SEINES STACKS. Das ist Absicht: §3 vergibt eine Marke „an einen Stack
 * ODER an einen einzelnen Container". Ein Container, der erbte, machte die
 * Zuordnung am Stack unsichtbar — an jeder Zeile stünde dieselbe Marke, und
 * niemand sähe mehr, ob sie am Stack hängt oder an dieser einen Zeile. Die
 * Aufrufstelle reicht deshalb `container.marks` durch und nicht `stack.marks`;
 * `web/tests/marks-display.test.tsx` prüft genau diesen Fall.
 */
export function MarkList({ marks, limit, onRemove, className }: MarkListProps) {
  const t = useTranslations();
  // Nichts vergeben, nichts gezeichnet — und ausdrücklich auch kein leeres
  // `<span>`: das Elternelement arbeitet mit `gap`, und ein leeres Kind risse
  // eine Lücke in eine Zeile, an der niemand eine Marke vergeben hat.
  if (marks.length === 0) return null;

  const shown = limit === undefined ? marks : marks.slice(0, limit);
  const hidden = marks.slice(shown.length);

  // ⚠️ Die Breite EINER Marke hängt an derselben Frage wie ihre Anzahl:
  // „steht das hier in einer Zeile". `MarkChip` schneidet seinen Namen selbst
  // ab (`truncate` im Inneren), aber nur bis zu einer Breite, die ihm jemand
  // gibt — ohne Deckel wüchse eine Marke namens „Datenbanken der Buchhaltung"
  // in der Zeile über den halben Platz. Auf der Seite eines Stacks ist Platz,
  // und ein abgeschnittener Name wäre dort ein Fehler und keine Rücksicht.
  //
  // ⚠️ `min-w-0` UND `max-w-[9rem]`, und das erste ist AM BILD GEMESSEN und
  // nicht mitgeschrieben. Ein Flex-Element hat von sich aus `min-width: auto`
  // und schrumpft deshalb nicht unter seine Mindestbreite — `max-width` ändert
  // daran nichts. Gemessen am 2026-09-06 bei 375 px Fensterbreite: die Liste
  // schrumpfte auf 65 px, die Marke blieb bei 144 px und stand mit ihrer
  // rechten Kante bei 341 px, also 79 px über der Kante ihres Feldes und quer
  // über dem Zähler „2/2". Mit `min-width: 0` an derselben Marke: 65 px und
  // bündig. Die ganze Prüfkette war dabei grün — das ist genau die Klasse
  // Fehler, die nur beim Ansehen auffällt.
  const chipClassName =
    limit === undefined ? undefined : "min-w-0 max-w-[9rem]";

  return (
    // ⚠️ `span` und nicht `div`: diese Liste steht in der Übersicht in einem
    // `button` (dem Aufklapper) und im Deepdive in einem `a`. Ein `div` darin
    // ist ungültiges HTML.
    //
    // ⚠️ `min-w-0` und KEIN `shrink-0`. Die Zeile ist schon voll — Punkt,
    // Name, Zähler, Pfeil —, und der Name daneben trägt `truncate`. Dürfte
    // dieser Block nicht schrumpfen, schöbe eine lange Marke den Namen aus der
    // Zeile; so schrumpfen beide, und der Name bleibt lesbar.
    <span className={cn("flex min-w-0 items-center gap-1", className)}>
      {shown.map((mark) => (
        // ⚠️ Der Schlüssel ist die Kennung der Marke und nicht der Index: die
        // Liste ändert sich, sobald C2 das Zuordnen baut, und ein Index als
        // Schlüssel hängte die Farbe des einen Eintrags an die Stelle des
        // anderen.
        <MarkChip key={mark.id} mark={mark} className={chipClassName}>
          {onRemove === undefined ? null : (
            <button
              type="button"
              aria-label={t("markRemove", { name: mark.name })}
              title={t("markRemove", { name: mark.name })}
              data-testid={`mark-remove-${mark.id}`}
              onClick={() => void onRemove(mark)}
              className="-mr-1 inline-flex shrink-0 rounded-full p-0.5 opacity-70 hover:opacity-100"
            >
              <X aria-hidden="true" className="size-3" />
            </button>
          )}
        </MarkChip>
      ))}
      {hidden.length > 0 ? (
        <span
          className="shrink-0 font-mono text-[11px] text-subtle-foreground"
          title={t("markMoreNames", {
            count: hidden.length,
            names: hidden.map((mark) => mark.name).join(", "),
          })}
        >
          <span aria-hidden="true">
            {t("markMoreCount", { count: hidden.length })}
          </span>
          {/* „+2" wird als „plus zwei" vorgelesen und sagt nichts. Der Satz
              mit den Namen reist unsichtbar mit — derselbe Aufbau wie bei
              „6/8" und `stackRunningOf`. */}
          <span className="sr-only">
            {t("markMoreNames", {
              count: hidden.length,
              names: hidden.map((mark) => mark.name).join(", "),
            })}
          </span>
        </span>
      ) : null}
    </span>
  );
}

/**
 * Der Deckel einer ZEILE: zwei Marken, danach der Zähler.
 *
 * Entscheidung des Betreibers vom 2026-09-06. Die Zeile trägt schon Punkt,
 * Namen, Zähler und Pfeil; die Seite eines Stacks trägt alle Marken, weil dort
 * Platz ist und wer sie öffnet, den Stack sehen will. Als Konstante und nicht
 * dreimal als Zahl im JSX: sonst stünde die Regel an drei Stellen und wiche
 * beim nächsten Umbau an einer davon ab.
 */
export const ROW_MARK_LIMIT = 2;
