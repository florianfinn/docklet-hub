import { ChevronRight, Eye, EyeOff, SquareArrowOutUpRight } from "lucide-react";
import { useState } from "react";
import { Link, useNavigate } from "react-router";
import { useTranslations } from "use-intl";

import type { StackView } from "contract";

import { cn } from "../../platform/ui/lib/cn";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "../../platform/ui/shadcn/collapsible";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger
} from "../../platform/ui/shadcn/context-menu";
import { stackPath } from "../../platform/routes/stack-path";
import { ContainerList } from "./ContainerList";
import { ContainerStateDot } from "./container-state";
import type { ContainerSlots } from "./slots";

// Ein Stack als aufklappbare Zeile, darunter seine Container eingerückt — die
// Form des Navigators im Artboard
// (docs/design/mockup/container-module.html Z. 183–193).
//
// ⚠️ Der Stack ist die EINHEIT, nicht der Container: „Ein Stack ist die
// Einheit, in der ein Dienst betrieben wird; ein einzelner Container ist
// selten für sich interessant“ (docs/design/hub-color-and-structure.md §5).
// Deshalb steht er zugeklappt da und zeigt seinen zusammengefassten Zustand;
// wer den einzelnen Container sucht, klappt auf.
//
// ⚠️ ZWEI BEDIENELEMENTE IN EINER ZEILE, und das ist kein Versehen: das
// Artboard zeigt die Stack-Zeile als EINEN Knopf mit „›“ am Ende
// (hub-palette.html Z. 592–597) und meint damit zweierlei — aufklappen und
// hineingehen. Ein Element kann nur eines von beidem tun. Ein Verweis IM Knopf
// wäre zudem ungültiges HTML (ein `a` in einem `button`), und ein Klick löste
// beide Wege zugleich aus. Also: die Zeile klappt auf, das „›“ am Ende führt
// auf die Seite des Stacks.
//
// ⚠️ Die Zeile eines Containers steht seit D6b in ContainerRow.tsx und wird
// hier nur noch über ContainerList geholt — sie trägt drei Flächen und gehört
// keiner davon.
//
// ⚠️ DAS KONTEXTMENÜ (Rechtsklick) HÄNGT AN DER GANZEN ZEILE und nicht am
// Knopf: der Betreiber zielt auf den Stack, nicht auf eines der zwei
// Bedienelemente darin. Radix öffnet es auch über die Kontextmenü-Taste und
// Umschalt+F10 auf dem fokussierten Knopf — ein Weg ohne Maus.
//
// ⚠️ `onHiddenChange` ist FREIWILLIG und entscheidet, ob „Ausblenden" im Menü
// steht — dieselbe Bauart wie `assign` an `ContainerList`. Wer ohne
// Adminrolle kommt, bekommt keinen Eintrag, der im 403 endet, und „Stack
// öffnen" bleibt ihm.

export type StackRowProps = {
  hostId: string;
  stack: StackView;
  open: boolean;
  onHiddenChange?: (hidden: boolean) => void;
  slots?: ContainerSlots;
};

export function StackRow({ hostId, stack, open, onHiddenChange, slots }: StackRowProps) {
  const t = useTranslations();
  const navigate = useNavigate();
  // ⚠️ `open` ist der ANFANGSWERT und nicht der Zustand: eine Suche klappt die
  // Treffer auf, danach entscheidet der Betreiber. Läge der Zustand außen,
  // klappte ihm jede Tastatureingabe die Liste wieder zu.
  const [expanded, setExpanded] = useState(open);

  return (
    <Collapsible open={expanded} onOpenChange={setExpanded}>
      <ContextMenu>
        <ContextMenuTrigger asChild>
          <div className="flex items-center rounded-md hover:bg-accent data-[state=open]:bg-accent">
            <CollapsibleTrigger className="flex min-w-0 flex-1 items-center gap-2.5 rounded-md px-2.5 py-1.5 text-left text-[13px]">
              <ChevronRight
                aria-hidden="true"
                className={cn("size-3.5 shrink-0 text-subtle-foreground transition-transform", expanded && "rotate-90")}
              />
              <ContainerStateDot state={stack.state} />
              <span className="truncate font-mono">{stack.project}</span>
              {/* Die eigenen Marken DIESES Stacks (D7b/C1). Sie stehen am Namen
                  und nicht am rechten Rand: sie ordnen den Stack, der Zähler
                  „6/8" sagt etwas über seinen Zustand — zwei verschiedene
                  Aussagen, und die rechte Kante gehört der zweiten.

                  ⚠️ Der Platz kommt aus `app/` (#282). Der Deckel von zwei, den
                  er dort bekommt, ist nicht Geschmack: die Zeile trägt schon
                  Pfeil, Punkt, Namen, Zähler und den Verweis am Ende. */}
              {slots?.stackMarks?.(stack)}
              {/* Die Zahl der laufenden Container neben der Farbe — die zweite
                  Hälfte der Aussage aus §5. „6/8“ und nicht „6“: ohne den Nenner
                  wäre nicht zu sehen, ob zwei fehlen oder keiner. Der ganze Satz
                  steht daneben für den Screenreader; als sichtbarer Text stünde er
                  in einer Liste von dreißig Zeilen dreißigmal.

                  ⚠️ `stack.total` und nicht `stack.containers.length`: die Liste
                  darunter ist gefiltert, die Aussage über den Stack ist es nicht. */}
              <span className="ml-auto shrink-0 font-mono text-[11px] text-subtle-foreground" aria-hidden="true">
                {stack.running}/{stack.total}
              </span>
              <span className="sr-only">{t("stackRunningOf", { running: stack.running, total: stack.total })}</span>
            </CollapsibleTrigger>
            <Link
              to={stackPath(hostId, stack.project)}
              aria-label={t("stackOpen", { project: stack.project })}
              className="shrink-0 rounded-md px-2 py-1.5 text-subtle-foreground hover:text-foreground"
            >
              <ChevronRight aria-hidden="true" className="size-4" />
            </Link>
          </div>
        </ContextMenuTrigger>
        <ContextMenuContent className="min-w-44">
          <ContextMenuItem onSelect={() => void navigate(stackPath(hostId, stack.project))}>
            <SquareArrowOutUpRight aria-hidden="true" />
            {t("stackMenuOpen")}
          </ContextMenuItem>
          {onHiddenChange ? (
            <>
              <ContextMenuSeparator />
              <ContextMenuItem data-testid="stack-menu-hidden" onSelect={() => onHiddenChange(!stack.hidden)}>
                {stack.hidden ? <Eye aria-hidden="true" /> : <EyeOff aria-hidden="true" />}
                {t(stack.hidden ? "stackMenuShow" : "stackMenuHide")}
              </ContextMenuItem>
            </>
          ) : null}
        </ContextMenuContent>
      </ContextMenu>
      {/* ⚠️ DIE EINRÜCKUNG IST EINE STELLSCHRAUBE UND KEIN FESTER WERT (D0 §4,
          verdrahtet in D7b/C1). Bis hierher stand hier `pl-5` — Tailwinds feste
          Stufe von 20 px —, während `--stack-indent` samt seinen zwei
          Umschaltern in `web/src/platform/theme/tokens.css` stand und niemand sie las.

          ⚠️ `data-indent` UND `pl-stack-indent` STEHEN AUF DEMSELBEN ELEMENT,
          und das ist der ganze Punkt: eine CSS-Variable löst dort auf, wo sie
          DEKLARIERT ist (docs/design/hub-color-and-structure.md §8).
          `[data-indent="flat"] { --stack-indent: 0 }` deklariert sie an diesem
          Element und schlägt damit die Deklaration auf `:root`, die sich sonst
          hierher vererbte. Stünde das Attribut auf einem Kind der Klasse, läse
          die Klasse weiter den Wert des Hauses — gültiges HTML, gültiges CSS,
          und die Stellschraube ohne Wirkung.

          ⚠️ `pl-stack-indent` und nicht `pl-[var(--stack-indent)]`: die
          Hilfsklasse entsteht aus `--spacing-stack-indent` im
          `@theme inline`-Block (tokens.css). Ohne `inline` legte Tailwind eine
          Zwischenvariable auf `:root` an, und die löste dort mit dem
          `--stack-indent` des Hauses auf — derselbe Fehler eine Ebene höher. */}
      <CollapsibleContent data-indent={stack.indent} className="pl-stack-indent">
        <ContainerList containers={stack.containers} hostId={hostId} slots={slots} />
      </CollapsibleContent>
    </Collapsible>
  );
}
