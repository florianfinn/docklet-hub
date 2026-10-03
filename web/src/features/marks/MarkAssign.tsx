import { Tag } from "lucide-react";
import { useState } from "react";
import { Link } from "react-router";
import { useTranslations } from "use-intl";

import { MARK_IDS_MAX, type MarkView } from "contract";

import { cn } from "../../platform/ui/lib/cn";
import { MarkChip } from "../../platform/ui/marks";
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuTrigger
} from "../../platform/ui/shadcn/dropdown-menu";

// Der Griff, mit dem der Betreiber einem Ziel seine Marken gibt (D7b/C2, #62).
//
// ⚠️ ZUGEORDNET WIRD AN ORT UND STELLE und nicht über eine Tabelle in den
// Einstellungen (Entscheidung des Betreibers vom 2026-09-06). Wer dort
// zuordnete, müsste erst Arm, dann Stack, dann Container aus drei
// Auswahllisten zusammensuchen — an der Zeile selbst ist die Frage schon
// beantwortet. Dieses eine Bauteil trägt beide Ziele: den Stack auf seiner
// Seite und den einzelnen Container im Deepdive. Es schreibt selbst NICHT —
// welche der beiden Routen gilt, weiß nur die Aufrufstelle, und sie bekommt
// den fertigen Satz über `onChange`.
//
// ⚠️ ANGEHÄNGT WIRD NUR HIER, ABGEZOGEN HIER UND AN DER CONTAINER-ZEILE ÜBER
// EIN KREUZ AN DER MARKE (`MarkList`, `onRemove`). Bis 2026-09-29 gab es kein
// Kreuz, weil an einer Zeile mit Deckel („+3“) die dritte Marke nicht dasteht.
// Das gilt weiter — deshalb führt die Liste hier IMMER alle Marken des Hubs und
// bleibt der vollständige Weg. Gemessen am Betreiber: das Tag-Symbol wurde
// nicht als Menü erkannt, und eine vorhandene Marke ließ sich für ihn nicht
// entfernen. Das Kreuz ist die zweite, kürzere Stelle für dieselbe Sache und
// schickt denselben Satz.
//
// ⚠️ DAS RADIX-MENÜ AUS DEM HAUSBESTAND, UND DER EIGENBAU IST WEG (Etappe D).
// Bis hierher stand hier ein selbstgebauter Aufklapper aus `useState`, samt
// gerechneter Lage, eigenem Escape-Griff und eigenem Klick-daneben-Griff. Seine
// Begründung lautete, Radix lasse sich unter happy-dom nicht öffnen. Das war
// ein Befund über den PRÜFSTAND und keiner über das Erzeugnis — und er war zu
// weit gefasst: nachgemessen am 2026-09-06 im selben happy-dom öffnet
// `trigger.click()` das Menü tatsächlich nicht (0 Einträge), ein
// `PointerEvent("pointerdown")` auf denselben Auslöser aber sehr wohl
// (2 Einträge), und danach laufen Pfeiltasten, Enter und Escape durch. Der
// Preis der Bequemlichkeit im Prüfstand war ein GEMESSENER Fehler in der
// Oberfläche: der Eigenbau gab den Fokus nach Escape nicht an den Auslöser
// zurück (die Datei enthielt keinen einzigen `.focus()`-Aufruf), und nach dem
// Wählen lag er auf `<body>`, wo der Escape-Griff am Wurzel-`<span>` ihn nicht
// mehr erreichte — der Betreiber kam über die Tastatur nicht mehr aus dem Menü
// heraus. Radix bringt Tastatur, Fokusfalle, Fokusrückgabe,
// `aria-haspopup`/`aria-controls`, den Klick daneben und die Kollision mit den
// Fensterkanten mit. Es gibt sie deshalb hier NICHT ein zweites Mal von Hand:
// zwei Mechaniken für dieselbe Sache sind schlimmer als eine.
//
// ⚠️ DIE LAGE WIRD NICHT MEHR GERECHNET. Der alte Aufklapper stand `fixed` und
// rechnete seine Ecken gegen das Fenster, weil er sonst über die rechte Kante
// lief (gemessen: 92 px bei 375 px Fensterbreite) und weil die Karte eines Arms
// `overflow-hidden` trägt (`containers/HostContainers.tsx`) und ein `absolute`
// positioniertes Kind beschneidet. Beides erledigt Radix von sich aus: der
// Inhalt reist durch ein Portal an `document.body` — also aus jedem `overflow`
// heraus — und der Popper schiebt ihn vor der Fensterkante zurück. Mit dem
// Rechnen fällt auch das Schließen beim Rollen und beim Ändern der
// Fenstergröße weg; Radix hält den Inhalt am Auslöser, statt ihn stehen zu
// lassen.
//
// ⚠️ DAS PORTAL KOSTET DIE MARKEN IHRE FARBE NICHT, und das war das eine
// Argument gegen es, das nicht trägt. `MarkChip` setzt `data-mark`, `data-hue`
// und `data-mark-style` AUF SICH SELBST (`web/src/platform/ui/marks/MarkChip.tsx`), und
// `web/src/platform/theme/palette.css` deklariert `--mark-face`, `--mark-ink` und
// `--mark-line` auf der Selektorliste `:root, [data-hue], [data-host],
// [data-area], [data-mark]` (Z. 77–81) — die Pille bringt ihre Ableitung also
// mit, egal wo im Dokument sie hängt. Die globalen Stellschrauben (`--chroma`,
// das Schema) stehen auf `<html>` und vererben sich auch in ein Portal an
// `document.body`. Nachgesehen am gebauten Bild und nicht nur gelesen: die
// gemessenen Farbwerte stehen im Bericht dieser Etappe.
//
// ⚠️ KEIN `disabled` AUF DEN EINTRÄGEN, während geschrieben wird. Genau das war
// der zweite gemessene Fehler: der Browser nimmt einem gesperrten Element den
// Fokus, und niemand holte ihn zurück. Der Schutz gegen den zweiten Klick steht
// deshalb im Griff selbst (`if (busy) return`) und nicht in einer Sperre, die
// dem Betreiber die Tastatur nimmt. Ein ausgegrauter Eintrag wäre zudem gegen
// „leer ist erlaubt, ausgegraut nicht" (D3).
//
// ⚠️ DER AUSLÖSER STEHT NEBEN DEM KNOPF ODER DEM LINK, NIE DARIN. Nachgemessen
// am Bestand: die Marken der Übersicht stehen in einem `button`
// (`CollapsibleTrigger` in `StackRow.tsx`), die Marken der Stack-Kopfzeile des
// Deepdives in einem `a` (`Link` in `StackSection.tsx`) — die Zeile eines
// CONTAINERS ist dagegen ein schlichtes `div` (`ContainerRow.tsx`), und die
// Überschrift der Stack-Seite ebenfalls. Genau an diesen beiden Stellen hängt
// dieses Bauteil, und `web/tests/marks-assign.test.tsx` prüft am gerenderten
// Baum nach, dass kein Bedienelement in einem anderen steckt.

/**
 * Der Abstand zur Fensterkante, in Pixeln.
 *
 * Er geht jetzt an Radix statt in eine eigene Rechnung: `collisionPadding` ist
 * dieselbe Zahl für dieselbe Sache, nur schiebt sie der Popper und nicht ein
 * `useLayoutEffect`.
 */
const EDGE = 8;

export type MarkAssignProps = {
  /**
   * Die Marken DIESES Ziels, in der Reihenfolge des Betreibers.
   *
   * ⚠️ Sie ist die Grundlage jedes Schreibvorgangs: eine Marke wird an ihr
   * Ende ANGEHÄNGT, und abgezogen wird aus ihr heraus. Der Satz reist
   * vollständig.
   */
  assigned: readonly MarkView[];
  /**
   * Alle Marken des Hubs — die Auswahl. `null` heißt „noch nicht geladen" und
   * ist nicht dasselbe wie „es gibt keine".
   */
  available: readonly MarkView[] | null;
  /** Was der Screenreader am Auslöser hört; nennt das Ziel beim Namen. */
  label: string;
  /** Sichtbarer Text neben dem Zeichen. Fehlt er, steht nur das Zeichen da. */
  triggerText?: string;
  /** Die Kennung für den Testlauf und für das Nachsehen im Browser. */
  testId: string;
  /**
   * Der GANZE Satz in seiner neuen Reihenfolge.
   *
   * Die Zusage entscheidet über „wird gespeichert" und über die Meldung: die
   * Aufrufstelle schreibt, dieses Bauteil zeigt, was dabei herauskommt.
   */
  onChange: (markIds: string[]) => Promise<void>;
  className?: string;
};

/**
 * Die Liste, aus der zugeordnet wird.
 *
 * ⚠️ THE ENTRY BEYOND THE LIMIT IS CAUGHT HERE, NOT BY THE SERVER.
 * `parseMarkIds` rejects more than `MARK_IDS_MAX` entries with a 400
 * (`server/src/features/marks/input.ts`; the number lives in `contract`). A
 * surface that runs into it would show the operator an error for a limit they
 * never saw on screen.
 *
 * ⚠️ ABGEFANGEN HEISST HIER: DIE ÜBRIGEN STEHEN NICHT MEHR DA, statt
 * ausgegraut dazustehen. „Leer ist erlaubt, ausgegraut nicht" ist die Regel
 * aus D3, und ein toter Eintrag beantwortet die Frage „warum tut der nichts"
 * nicht. Stattdessen steht ein Satz da, der die Grenze nennt und sagt, was zu
 * tun ist. Die zugeordneten Marken bleiben natürlich stehen — sonst käme
 * niemand mehr unter die Grenze zurück.
 */
export function MarkAssign({
  assigned,
  available,
  label,
  triggerText,
  testId,
  onChange,
  className
}: MarkAssignProps) {
  const t = useTranslations();
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);

  const ids = assigned.map((mark) => mark.id);
  const full = ids.length >= MARK_IDS_MAX;

  const toggle = (mark: MarkView) => {
    // Der Schutz gegen den zweiten Klick, solange der erste noch unterwegs ist.
    // Er steht hier und nicht als `disabled` am Eintrag — siehe den Kopf dieser
    // Datei.
    if (busy) return;
    // ⚠️ ANHÄNGEN HEISST: DIE ALTE LISTE PLUS DIE NEUE, in dieser Reihenfolge.
    // Nicht „nur die neue" — die Route ERSETZT den Satz, und ein Rumpf mit
    // einer einzigen Kennung zöge alle übrigen Marken des Ziels ab, mit einer
    // 200 als Antwort. Genau dieser Fall steht in `marks-assign.test.tsx`.
    const next = ids.includes(mark.id) ? ids.filter((id) => id !== mark.id) : [...ids, mark.id];
    setBusy(true);
    setFailed(false);
    void onChange(next)
      .catch(() => setFailed(true))
      .finally(() => setBusy(false));
  };

  // Was in der Liste steht: die zugeordneten immer, die übrigen nur, solange
  // noch Platz ist (siehe der Kopf dieser Funktion).
  const offered = (available ?? []).filter((mark) => !full || ids.includes(mark.id));
  const withheld = (available ?? []).length - offered.length;

  return (
    <DropdownMenu>
      {/* ⚠️ Ein schlichtes `button` und kein `Button` aus `ui/shadcn`: dieser
          Auslöser steht in einer Zeile, die schon Punkt, Namen, Marken und
          Statustext trägt, und die kleinste Stufe des Bausteins bringt eine
          Höhe von 32 px mit. Gemessen in C1 an derselben Zeile: was dort nicht
          hineinpasst, bricht sie um.

          ⚠️ `asChild` und kein zusätzlicher Wrapper: der Auslöser IST dieser
          Knopf. `aria-haspopup`, `aria-expanded` und `aria-controls` setzt
          Radix darauf — sie stehen deshalb hier nicht noch einmal von Hand, wo
          sie beim nächsten Umbau auseinanderliefen. Der geöffnete Zustand wird
          aus demselben Grund über `data-state` gezeichnet und nicht über einen
          eigenen `useState`. */}
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          aria-label={label}
          data-testid={testId}
          className={cn(
            "inline-flex shrink-0 items-center gap-1 rounded-md border border-transparent px-1.5 py-0.5",
            "text-[12px] text-subtle-foreground hover:border-border hover:text-foreground",
            "data-[state=open]:border-border data-[state=open]:text-foreground",
            className
          )}
        >
          <Tag aria-hidden="true" className="size-3.5" />
          {triggerText === undefined ? null : <span className="truncate">{triggerText}</span>}
        </button>
      </DropdownMenuTrigger>

      {/* `align="start"` hält die Liste an der linken Kante ihres Auslösers,
          solange sie dort hinpasst; `collisionPadding` schiebt sie davor
          zurück. Die Breite bleibt bei 15 rem und ist auf schmalen Schirmen auf
          die Fensterbreite gedeckelt — die Höhe deckelt der übernommene
          Baustein selbst über
          `--radix-dropdown-menu-content-available-height`. */}
      <DropdownMenuContent
        align="start"
        collisionPadding={EDGE}
        data-testid={`${testId}-panel`}
        className="flex w-[15rem] max-w-[calc(100vw-2rem)] flex-col gap-1 p-2"
      >
        <DropdownMenuLabel className="px-1 py-0 text-[11px] tracking-wide text-subtle-foreground uppercase">
          {t("markAssignTitle")}
        </DropdownMenuLabel>

        {available === null ? <span className="px-1 text-[12px] text-muted-foreground">{t("loading")}</span> : null}

        {/* „Leer ist erlaubt, ausgegraut nicht" (D3): gibt es im ganzen Hub
            noch keine Marke, steht hier der Weg zur ersten und keine leere
            Auswahlliste. Der Verweis führt auf die Fläche, die sie anlegt —
            diese hier legt keine an, sonst gäbe es das Anlegen an zwei
            Stellen. */}
        {available !== null && available.length === 0 ? (
          <span className="flex flex-col gap-1 px-1 py-0.5 text-[12px] text-muted-foreground">
            {t("markAssignEmpty")}
            <Link to="/settings" className="w-fit underline hover:text-foreground">
              {t("markAssignEmptyAction")}
            </Link>
          </span>
        ) : null}

        {offered.map((mark) => {
          const active = ids.includes(mark.id);
          return (
            <DropdownMenuCheckboxItem
              key={mark.id}
              checked={active}
              data-testid={`${testId}-mark-${mark.id}`}
              // ⚠️ `preventDefault` HÄLT DAS MENÜ OFFEN, und das ist der Grund
              // für den Eintrag mit Häkchen statt für einen schlichten. Ein
              // Menü, das nach der ersten Marke zuklappt, verlangte für die
              // zweite einen zweiten Weg dorthin; das Anhängen und das Abziehen
              // stehen aber ausdrücklich in DERSELBEN Liste.
              onSelect={(event) => event.preventDefault()}
              onCheckedChange={() => toggle(mark)}
              className="py-1"
            >
              <MarkChip mark={mark} className="min-w-0" />
            </DropdownMenuCheckboxItem>
          );
        })}

        {withheld > 0 ? (
          <span className="px-1 text-[12px] text-muted-foreground" data-testid={`${testId}-full`}>
            {t("markAssignFull", { max: MARK_IDS_MAX })}
          </span>
        ) : null}

        {/* ⚠️ EINE Meldung und keine Verzweigung nach dem Grund. Gemessen an
            `handleMarkError` (`server/src/features/marks/mark-errors.ts`) und an `parseMarkIds`:
            diese beiden Routen antworten mit 400 „invalid-input" (Dublette, zu
            viele) oder 404 „mark-unknown" / „host-unknown". Die 400 fängt
            dieses Bauteil vorher ab, und die 404 heißt „die Marke oder der Arm
            ist inzwischen weg" — dagegen tut der Betreiber nichts anderes als
            neu zu laden. `name-taken` (409) kann hier gar nicht auftreten:
            diese Routen tragen keinen Namen. Eine Übersetzungsdatei wie
            `mark-errors.ts` wäre damit eine Funktion mit einem Zweig. */}
        {failed ? (
          <span role="alert" className="px-1 text-[12px] text-destructive" data-testid={`${testId}-error`}>
            {t("markAssignFailed")}
          </span>
        ) : null}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
