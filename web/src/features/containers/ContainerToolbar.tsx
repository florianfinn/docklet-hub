import { Search } from "lucide-react";
import { useTranslations, type Messages } from "use-intl";

import { cn } from "../../platform/ui/lib/cn";
import { Input } from "../../platform/ui/shadcn/input";
import { CONTAINER_FILTERS, type ContainerFilter, type FilterCounts } from "./container-filter";

// Die Leiste über der Liste: ein Suchfeld und die Chips des Artboards
// (hub-palette.html Z. 569–575).
//
// ⚠️ Sie trägt beide Flächen — die Übersicht und den Deepdive. Ein zweiter
// Satz Chips für die zweite Fläche wäre ein zweiter Filterbegriff, und beim
// ersten Umbau zeigten die beiden Flächen verschiedene Kategorien desselben
// Hauses.
//
// ⚠️ Die Zuordnung Kennung → Beschriftung kommt VON AUSSEN und steht nicht
// hier. Der Wächter web/tests/overview-filters.test.mjs liest sie aus
// `web/src/app/screens/OverviewScreen.tsx` — er hält sie dort gegen
// `CONTAINER_FILTERS` und gegen beide Sprachdateien, auch auf Vertauschung.
// Zöge sie hierher, prüfte niemand mehr, ob der Chip „läuft“ auch „läuft“
// heißt.
//
// ⚠️ Der fünfte Chip des Artboards („Update 3“) fehlt, und zwar mit Absicht:
// die Begründung steht in container-filter.ts. Weder Agent noch Hub melden
// bisher, ob für ein Image eine neuere Fassung bereitliegt.

type ContainerToolbarProps = {
  filter: ContainerFilter;
  onFilterChange: (filter: ContainerFilter) => void;
  labelKeys: Record<ContainerFilter, keyof Messages>;
  counts: FilterCounts;
  query: string;
  onQueryChange: (query: string) => void;
};

export function ContainerToolbar({
  filter,
  onFilterChange,
  labelKeys,
  counts,
  query,
  onQueryChange
}: ContainerToolbarProps) {
  const t = useTranslations();

  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
      <div className="relative max-w-md min-w-[220px] flex-1">
        <Search
          aria-hidden="true"
          className="pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-subtle-foreground"
        />
        <Input
          type="search"
          className="h-8 pl-8 text-[13px]"
          placeholder={t("overviewSearchPlaceholder")}
          value={query}
          onChange={(event) => onQueryChange(event.target.value)}
        />
      </div>
      {/* Die Chips des Artboards. Als Knöpfe und nicht als Marken: sie tun
          etwas, und was etwas tut, muss auch mit der Tastatur erreichbar
          sein. */}
      <div className="flex flex-wrap gap-1.5">
        {CONTAINER_FILTERS.map((entry) => (
          <button
            key={entry}
            type="button"
            aria-pressed={filter === entry}
            onClick={() => onFilterChange(entry)}
            className={cn(
              "rounded-full border px-2.5 py-1 text-xs transition-colors",
              filter === entry
                ? "border-accent-line bg-accent text-accent-foreground"
                : "border-border text-muted-foreground hover:text-foreground"
            )}
          >
            {t(labelKeys[entry])} {counts[entry]}
          </button>
        ))}
      </div>
    </div>
  );
}
