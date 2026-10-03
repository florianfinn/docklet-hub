import type { Messages } from "use-intl";

import type { ContainerFilter } from "./container-filter";

// ⚠️ Diese Zuordnung hält `web/tests/overview-filters.test.mjs` gegen
// `CONTAINER_FILTERS` und die Sprachdateien — auch auf VERTAUSCHUNG. Ein
// `running: "overviewFilterAll"` wäre für TypeScript, für die Sprachdateien
// und für den Sprachwächter tadellos, und der Chip „läuft“ hieße „alle“.
//
// ⚠️ Sie steht in dieser Datei und nicht an einem der beiden Bildschirme, weil
// die Übersicht UND die Container-Fläche dieselbe Leiste zeichnen und dieselbe
// Zuordnung brauchen, und weil der Wächter sie genau hier sucht — ein Wächter,
// der nichts findet, ist keiner. Eine zweite Zuordnung neben dieser wäre die,
// die beim nächsten Umbau abweicht.
export const FILTER_KEYS: Record<ContainerFilter, keyof Messages> = {
  all: "overviewFilterAll",
  running: "overviewFilterRunning",
  unhealthy: "overviewFilterUnhealthy",
  stopped: "overviewFilterStopped"
};
