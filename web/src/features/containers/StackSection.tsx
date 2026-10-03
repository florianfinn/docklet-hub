import { ChevronRight } from "lucide-react";
import { Link } from "react-router";
import { useTranslations } from "use-intl";

import type { StackView } from "contract";

import { stackPath } from "../../platform/routes/stack-path";
import { ContainerList } from "./ContainerList";
import { ContainerStateDot } from "./container-state";
import type { ContainerSlots } from "./slots";

// Ein Stack im Deepdive: die Kopfzeile als Verweis, darunter seine Container
// eingerückt (Artboard hub-palette.html Z. 585–605 — die Stack-Zeile und der
// `div.nest` darunter).
//
// ⚠️ Hier wird NICHT aufgeklappt. Das ist der Unterschied zur Übersicht und
// der ganze Zweck dieser Fläche: „Container ist der Deepdive: jeder Container
// einzeln, nach Host geordnet, die Container eines Stacks eingerückt unter
// ihm“ (docs/design/hub-color-and-structure.md §5). Eine Fläche, auf der man
// erst dreißigmal klicken muss, um jeden Container zu sehen, ist die
// Übersicht — die gibt es schon.
//
// ⚠️ Die ganze Zeile ist der Verweis und nicht nur das „›“. In der Übersicht
// teilt sich die Zeile zwischen Aufklappen und Hineingehen; hier gibt es
// nichts aufzuklappen, und ein Ziel, das nur an einem Zeichen am Rand hängt,
// ist schwerer zu treffen als eine Zeile.

// ⚠️ DIE KOPFZEILE DIESES STACKS BEKOMMT KEINEN GRIFF, seine Container schon.
// Sie ist ein `Link` über die ganze Zeile, und ein Bedienelement darin wäre
// verschachtelte Bedienung. Die Marken des Stacks vergibt seine SEITE — genau
// dorthin führt dieser Link.
export function StackSection({
  hostId,
  stack,
  slots
}: {
  hostId: string;
  stack: StackView;
  slots?: ContainerSlots;
}) {
  const t = useTranslations();

  return (
    <div>
      <Link
        to={stackPath(hostId, stack.project)}
        className="flex items-center gap-2.5 rounded-md px-2.5 py-1.5 text-[13px] hover:bg-accent"
      >
        <ContainerStateDot state={stack.state} />
        <span className="truncate font-mono">{stack.project}</span>
        {/* Derselbe Platz wie in der Übersicht, aus `app/` hereingereicht:
            die Kopfzeile eines Stacks ist auch hier eine Zeile, und was der
            Betreiber vergeben hat, steht ungekürzt auf der Seite des Stacks. */}
        {slots?.stackMarks?.(stack)}
        {/* „Stack · 8 Container“ wie im Artboard. `stack.total` und nicht die
            Länge der Liste darunter: die ist gefiltert, die Aussage über den
            Stack ist es nicht. */}
        <span className="ml-auto shrink-0 text-xs text-subtle-foreground">
          {t("stackContainersCount", { count: stack.total })}
        </span>
        <ChevronRight aria-hidden="true" className="size-4 shrink-0 text-subtle-foreground" />
      </Link>
      {/* Die Einrückung je Stack (D0 §4), hier wie in der Übersicht: das
          Attribut und die Klasse, die `--stack-indent` liest, stehen auf
          DEMSELBEN Element — eine CSS-Variable löst dort auf, wo sie
          deklariert ist (docs/design/hub-color-and-structure.md §8). Die
          ausführliche Begründung steht in `StackRow.tsx`
          an der gleichen Stelle. */}
      <div data-indent={stack.indent} className="pl-stack-indent">
        <ContainerList containers={stack.containers} hostId={hostId} slots={slots} />
      </div>
    </div>
  );
}
