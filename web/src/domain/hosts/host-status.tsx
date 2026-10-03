import { useTranslations, type Messages } from "use-intl";

import type { HostStatus } from "contract";
import { Badge } from "../../platform/ui/shadcn/badge";
import { knownClass, knownKey } from "../../platform/i18n/wire-labels";
import { cn } from "../../platform/ui/lib/cn";
import { Tooltip, TooltipContent, TooltipTrigger } from "../../platform/ui/shadcn/tooltip";

// Die vier erhobenen Zustände aus §3 der Doku, in den zwei Formen des
// Artboards: als Punkt am Namen und als Marke daneben
// (docs/design/mockup/hub-palette.html Z. 486 und 496).
//
// ⚠️ `outdated` bekommt bewusst die Ausfallfarbe wie ein Fehler — nicht
// dasselbe Grau wie `offline`. Ein Betreiber muss auf einen Blick
// unterscheiden können, ob ein Agent zu alt ist (er muss aktualisiert werden)
// oder ob er nur gerade nicht erreichbar ist (er kommt vielleicht von selbst
// wieder). Dieselbe Farbe für beide verwischt genau die Unterscheidung, die
// die Anzeige leisten soll.
//
// ⚠️ Die Farben kommen aus `--state-ok/warn/down` und NICHT aus der Palette
// des Hosts. D0 §2 sperrt die drei Zustandstöne gegen jede Umschaltung: sie
// tragen Bedeutung, keinen Geschmack, und stehen deshalb fest in
// web/src/platform/theme/tokens.css. Ein Zustand, der die Farbe seines Hosts annähme,
// wäre auf dem einen Arm rot und auf dem nächsten grün.
const STATUS_DOT: Record<HostStatus, string> = {
  pending: "bg-state-warn",
  online: "bg-state-ok",
  offline: "bg-muted-foreground",
  outdated: "bg-state-down"
};

// Die Marke: getönte Fläche, Kante und Text im selben Ton. `offline` bleibt
// als einziger ohne Farbe — nichts ist kaputt, es ist nur gerade still.
const STATUS_BADGE: Record<HostStatus, string> = {
  pending: "border-state-warn/40 bg-state-warn/10 text-state-warn",
  online: "border-state-ok/40 bg-state-ok/10 text-state-ok",
  offline: "border-border bg-muted text-muted-foreground",
  outdated: "border-state-down/40 bg-state-down/10 text-state-down"
};

// Hält nur die Schlüssel — aufgelöst wird erst in der Komponente, wo der Hook
// der Bibliothek zur Verfügung steht.
const STATUS_KEYS: Record<HostStatus, keyof Messages> = {
  pending: "hostStatusPending",
  online: "hostStatusOnline",
  offline: "hostStatusOffline",
  outdated: "hostStatusOutdated"
};

// Der Punkt vor dem Namen. Er trägt KEINEN Text und ist deshalb für den
// Screenreader nicht da: die Marke daneben sagt dasselbe in Worten, und zwei
// Ansagen für einen Zustand sind eine zu viel.
export function HostStatusDot({ status, className }: { status: HostStatus; className?: string }) {
  return (
    <span
      aria-hidden="true"
      className={cn(
        "inline-block size-[7px] shrink-0 rounded-full",
        knownClass(STATUS_DOT, status, "bg-muted-foreground"),
        className
      )}
    />
  );
}

export function HostStatusBadge({ status }: { status: HostStatus }) {
  const t = useTranslations();
  // ⚠️ Nachgeschlagen und nicht indiziert — derselbe Grund wie am Punkt des
  // Containers, siehe `i18n/wire-labels.ts`. `status` kommt aus der Antwort
  // des Servers; ein Zustand, den eine neuere Fassung dort einführt, ließ die
  // Marke bis hierher LEER, weil `t(undefined)` von `use-intl` abgefangen wird.
  const key = knownKey(STATUS_KEYS, status);
  const badge = (
    <Badge variant="outline" className={cn("gap-1.5 font-normal", knownClass(STATUS_BADGE, status, "border-border bg-muted text-muted-foreground"))}>
      <HostStatusDot status={status} />
      {key === null ? t("hostStatusUnknown", { status }) : t(key)}
    </Badge>
  );

  // Nur `outdated` trägt eine Erklärung, und sie steht im Tooltip statt als
  // Satz neben der Marke: der Zustand ist selten, der Satz lang, und in einer
  // Kartenkopfzeile stünde er quer. Wer ihn braucht, findet ihn an der Marke.
  //
  // ⚠️ Der Tooltip hängt am `TooltipProvider` an der Wurzel von `AppShell`.
  // Ohne ihn öffnete er nicht — und zwar still.
  if (status !== "outdated") return badge;

  return (
    <Tooltip>
      <TooltipTrigger asChild>{badge}</TooltipTrigger>
      <TooltipContent className="max-w-[320px]">{t("hostStatusOutdatedHint")}</TooltipContent>
    </Tooltip>
  );
}
