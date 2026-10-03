import { useTranslations, type Messages } from "use-intl";

import type { ContainerEntry, OverviewContainer } from "contract";

// Die Kategorie „fremdverwaltet" — Container, die ein anderer als der Hub
// anlegt und betreibt (Entscheidung des Betreibers vom 2026-09-06, #20,
// festgehalten in docs/design/concept-and-plan.md §2 „Sichtbarkeit und
// Verwaltbarkeit").
//
// ⚠️ Die Kategorie folgt ALLEIN aus dem, was der Agent meldet
// (`externalManagement` an jedem Container, `server/src/domain/containers/containers.ts`).
// Ein „nur beobachten" als Wahl des Betreibers gibt es nicht — sonst stünden
// zwei Wahrheiten nebeneinander: die des Hauses und die der Einstellung.
//
// ⚠️ DAS ARTBOARD ZEIGT DIESE GRUPPE NICHT. Die Entscheidung ist jünger als
// das Bild (hub-palette.html Z. 563-716 kennt sie nicht). Sie ist damit „was
// das Mockup nicht zeigt" nach AGENTS.md und im Stil der übrigen Gruppen
// gebaut: dieselbe Überschriftenform wie „ohne Stack", dieselben Zeilen wie
// überall. Erfunden ist hier nichts außer dem Hinweis, wer verwaltet.

// Ein fester Text je BEKANNTEM Verwalter — die Sprachdateien kennen ihn und
// können ihn ausformulieren („Unraid legt diese Container aus seinen Vorlagen
// an").
//
// ⚠️ Der Schlüssel wird über den Namen NACHGESCHLAGEN und nicht über eine
// Aufzählung erzwungen: `manager` ist am Server eine Zeichenkette
// (`ExternalManagement = { manager: string }`). Ein Verwalter, den diese Liste
// nicht kennt, darf nicht in einen Standardtext fallen, der seinen Namen
// verschluckt — er bekommt den Satz mit eingesetztem Namen.
const MANAGER_NOTE_KEYS: Record<string, keyof Messages> = {
  unraid: "externalManagedByUnraid"
};

export function isExternallyManaged(container: ContainerEntry): boolean {
  return container.externalManagement !== null;
}

/**
 * Trennt eine Container-Liste in „gehört uns" und „fremdverwaltet".
 *
 * ⚠️ Die Reihenfolge innerhalb beider Hälften bleibt die des Servers. Die
 * fremdverwaltete Hälfte steht auf der Fläche danach — sie ist der Anhang und
 * nicht der Anfang.
 */
export function splitByManagement(containers: OverviewContainer[]): {
  own: OverviewContainer[];
  external: OverviewContainer[];
} {
  return {
    own: containers.filter((container) => !isExternallyManaged(container)),
    external: containers.filter(isExternallyManaged)
  };
}

/**
 * Die fremdverwalteten Container einer Liste, nach Verwalter gebündelt.
 *
 * ⚠️ Nach Verwalter und nicht in einem Topf: stünden Unraid-Vorlagen und ein
 * zweiter Verwalter unter einer Überschrift, nennte der Hinweis einen von
 * beiden — und für die Hälfte der Zeilen stünde dort der falsche Name.
 */
export function groupByManager(containers: OverviewContainer[]): { manager: string; containers: OverviewContainer[] }[] {
  const groups = new Map<string, OverviewContainer[]>();
  for (const container of containers) {
    const manager = container.externalManagement?.manager ?? "";
    if (manager === "") continue;
    const existing = groups.get(manager);
    if (existing === undefined) groups.set(manager, [container]);
    else existing.push(container);
  }
  return [...groups.entries()].map(([manager, entries]) => ({ manager, containers: entries }));
}

/**
 * Der Hinweis, wer verwaltet — ein Satz und keine Marke.
 *
 * ⚠️ Er steht als Satz da, weil er eine Auskunft ist und keine Eigenschaft:
 * eine Marke „unraid" an dreißig Zeilen sagt weniger als ein Satz über der
 * Gruppe, und sie sähe aus wie eine der eigenen Marken aus D7.
 */
export function ExternalManagementNote({ manager }: { manager: string }) {
  const t = useTranslations();
  const known = MANAGER_NOTE_KEYS[manager.toLowerCase()];
  return (
    <p className="px-2.5 pb-1 text-xs text-muted-foreground">
      {known === undefined ? t("externalManagedByOther", { manager }) : t(known)}
    </p>
  );
}
