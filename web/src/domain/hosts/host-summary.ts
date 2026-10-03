import type { ContainerEntry, HostLoad } from "contract";

// Die Zähler, die im Kopf einer Host-Karte stehen: „3 Stacks · 21 Container ·
// 18 laufen" (docs/design/mockup/hub-palette.html Z. 476–492).
//
// Warum als eigene Datei und nicht in der Karte: sie rechnet und rendert
// nicht, und nur so lässt sie sich prüfen, ohne einen Browser zu starten.

export type HostSummary = {
  // Verschiedene Compose-Projekte. Container ohne Compose-Angabe zählen NICHT
  // als eigener Stack — im Artboard stehen sie als „ohne Stack" daneben.
  stacks: number;
  containers: number;
  running: number;
};

export const EMPTY_SUMMARY: HostSummary = { stacks: 0, containers: 0, running: 0 };

// Was die Karte über ihre Zähler weiß.
//
// ⚠️ DREI Zustände und nicht `HostSummary | null`. Die Unterscheidung ist der
// Inhalt dieses Typs: „noch nicht geladen" und „der Agent antwortet nicht"
// sehen in einer Zahl gleich aus, bedeuten aber das Gegenteil voneinander.
// Wer beides als `null` führt, zeigt beim Laden eine Störung an — oder
// schlimmer, bei einer Störung ein ewiges Laden.
export type HostCounters =
  | { state: "loading" }
  // `load`: die Last durch Container (#214), fertig gerechnet vom Server;
  // `null`, solange der Hub die Ausstattung des Arms nicht kennt.
  | { state: "ready"; summary: HostSummary; load: HostLoad | null }
  | { state: "unavailable" };

export function summarize(containers: ContainerEntry[]): HostSummary {
  const projects = new Set<string>();
  let running = 0;
  for (const container of containers) {
    if (container.compose !== null) projects.add(container.compose.project);
    if (container.running) running += 1;
  }
  return { stacks: projects.size, containers: containers.length, running };
}

// Die Summe über alle Hosts für den Kopf des Bildschirms („34 verwaltet · 31
// laufen").
//
// ⚠️ Die Stacks werden hier ADDIERT und nicht erneut über alle Hosts
// zusammengefasst: zwei Hosts können ein Compose-Projekt gleichen Namens
// führen, und das sind zwei Stacks, nicht einer. Ein Stack gehört laut D0 §6
// zum Paar aus Host-Kennung und Compose-Projekt — der Name allein ist keine
// Kennung.
export function total(summaries: HostSummary[]): HostSummary {
  return summaries.reduce(
    (sum, summary) => ({
      stacks: sum.stacks + summary.stacks,
      containers: sum.containers + summary.containers,
      running: sum.running + summary.running
    }),
    EMPTY_SUMMARY
  );
}
