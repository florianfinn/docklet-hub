import type { ContainerOverviewEntry, ContainerStatsSample } from "../../domain/containers/index.js";
import type { HostInfo } from "../../domain/hosts/index.js";
import type { HostLoad, LoadPoint } from "contract";

// Die Last eines Arms DURCH SEINE CONTAINER (#214,
// docs/design/management-aids.md §4.2).
//
// ⚠️ DAS IST NICHT DIE LAST DES HOSTS. Summiert wird, was der Agent sampelt:
// die Container seiner Allowlist (`registry.allowedIds()`). Prozesse außerhalb
// von Docker fehlen, und ebenso jeder Container, der nicht in der Allowlist
// steht. Die fremdverwalteten zählen seit #124 mit — ab Agent v0.31.0, der sie
// als `externallyManaged` in der Allowlist führt; auf einem älteren Arm fehlen
// sie weiter. Die Oberfläche beschriftet die Zahl deshalb mit „durch
// Container".
//
// ⚠️ KEIN EIGENER PUFFER. Der Verlauf ergibt sich aus den Zeitstempeln der
// Container-Messpunkte, die der Agent ohnehin mit jeder Antwort schickt
// (60 Stück, 10-s-Takt). Der Hub hält nichts fest.
//
// Diese Datei ruft nichts auf und kennt keine Uhr — dieselbe Bauart wie
// `overview.ts`, damit die Rechnung ohne Agenten prüfbar ist.
//
// ── WARUM DER VERLAUF NICHT MIT IN DIE ÜBERSICHT GEHT (#213) ────────────────
//
// Gemessen am 2026-09-30 mit einem Messpunkt in der Form des Agenten
// (`sampledAt` als ISO-Zeitpunkt, drei Zahlen mit voller Genauigkeit):
//
//   node -e 'JSON.stringify(<60 solche Messpunkte>).length'
//     → 7.635 Bytes je Container, 127 je Messpunkt
//
// Ein ganzer Eintrag der Übersicht OHNE Verlauf misst 488 Bytes (derselbe
// Weg, ein Eintrag mit Compose-Angabe, Marken leer). Mit Verlauf wird jede
// Zeile also rund sechzehnmal so groß, und der Hub komprimiert seine
// Antworten nicht. Die Übersicht trägt deshalb nur den letzten Wert; das
// Detail holt den Verlauf über seine eigene Route, und die Host-Karte bekommt
// ihn hier bereits zusammengefasst — 60 Punkte je Arm statt 60 je Container.

/** Der Takt des Agenten zwischen zwei Messwellen. */
export const SAMPLE_INTERVAL_MS = 10_000;

/** So viele Wellen hält der Agent vor — zehn Minuten. */
export const SAMPLE_CAPACITY = 60;

// Point and load as they travel live in the contract
// (`contract/src/api/containers.ts`, #248).
export type { HostLoad, LoadPoint };

// Normalize summed Docker CPU percentages by core count and cap outliers at 100 %.
function normalizeCpu(sum: number | null, cores: number | null): number | null {
  if (sum === null || cores === null) return null;
  return Math.min(100, sum / cores);
}

function normalizeMemory(sum: number | null, total: number | null): number | null {
  if (sum === null || total === null) return null;
  return (sum / total) * 100;
}

/** Summe der Werte, die es gibt; `null`, wenn es keinen gibt. */
function sumOf(values: (number | null)[]): number | null {
  let sum: number | null = null;
  for (const value of values) {
    if (value !== null) sum = (sum ?? 0) + value;
  }
  return sum;
}

/** Eine Messwelle des Agenten: je Container höchstens ein Messpunkt. */
type Wave = { startAt: number; lastAt: number; samples: Map<string, ContainerStatsSample> };

/**
 * Ab welchem Abstand zum vorigen Messpunkt eine neue Welle beginnt — eine
 * halbe Taktlänge.
 */
const WAVE_GAP_MS = SAMPLE_INTERVAL_MS / 2;

/**
 * Ordnet die Messpunkte aller Container ihren Wellen zu, älteste zuerst.
 *
 * ⚠️ DIE WELLEN WERDEN AN DER ZEITLINIE ERKANNT UND NICHT AN EINEM RASTER.
 * Die Messpunkte einer Welle stammen nicht aus demselben Augenblick: der
 * Agent fragt je Welle bis zu sechs Container gleichzeitig ab und stempelt
 * jeden erst nach seiner Antwort. Jedes feste Raster — die volle Uhrzeit wie
 * der jüngste Messpunkt — hat eine Grenze, über die eine Welle streuen kann,
 * und zerfällt dann in zwei Teilsummen. Hier beginnt eine neue Welle erst,
 * wenn zwischen zwei aufeinanderfolgenden Stempeln eine halbe Taktlänge
 * liegt — ODER wenn ein Container in der laufenden Welle schon einen Punkt
 * hat. Die zweite Bedingung hält auch eine Welle auseinander, die so lange
 * streut, dass die Lücke zur nächsten kleiner wird als eine halbe Taktlänge:
 * zwei Punkte desselben Containers stammen nie aus derselben Welle, und
 * beide zu summieren zählte ihn doppelt.
 *
 * ⚠️ EINE NOCH LAUFENDE JÜNGSTE WELLE FÄLLT HERAUS. Liest der Hub die Liste,
 * während der Agent gerade misst, trägt die jüngste Welle erst einen Teil der
 * Container, und ihre Summe fiele unter die wirkliche Last. Erkannt wird das
 * daran, dass ein Container der vorletzten Welle in der jüngsten fehlt — ein
 * gestoppter Container wird weiter gemessen (mit `null`), ein entfernter
 * verliert beim Agenten seinen ganzen Puffer (`retain`). Ein NEUER Container,
 * der nur in der jüngsten Welle steht, macht sie nicht unvollständig.
 */
function wavesOf(containers: readonly ContainerOverviewEntry[]): Wave[] {
  const stamped: { id: string; at: number; sample: ContainerStatsSample }[] = [];
  for (const container of containers) {
    for (const sample of container.stats?.samples ?? []) {
      const at = Date.parse(sample.sampledAt);
      if (!Number.isNaN(at)) stamped.push({ id: container.id, at, sample });
    }
  }
  stamped.sort((left, right) => left.at - right.at);

  const waves: Wave[] = [];
  for (const entry of stamped) {
    const current = waves.at(-1);
    if (current === undefined || entry.at - current.lastAt > WAVE_GAP_MS || current.samples.has(entry.id)) {
      waves.push({ startAt: entry.at, lastAt: entry.at, samples: new Map([[entry.id, entry.sample]]) });
      continue;
    }
    current.samples.set(entry.id, entry.sample);
    current.lastAt = entry.at;
  }

  const newest = waves.at(-1);
  const previous = waves.at(-2);
  if (newest !== undefined && previous !== undefined) {
    const inProgress = [...previous.samples.keys()].some((id) => !newest.samples.has(id));
    if (inProgress) waves.pop();
  }
  return waves;
}

/**
 * Der Verlauf der Last durch Container, älteste Welle zuerst, höchstens
 * zehn Minuten.
 *
 * ⚠️ EINE AUSGELASSENE WELLE IST EINE LÜCKE. Der Agent lässt eine Welle aus,
 * wenn die vorige noch läuft; liegen zwei Wellen mehr als anderthalb Takte
 * auseinander, steht für jeden fehlenden Takt ein Punkt mit `null`. Ohne ihn
 * verbände die Linie zwei Wellen, zwischen denen nichts gemessen wurde.
 */
export function loadSeries(containers: readonly ContainerOverviewEntry[], info: HostInfo | null): LoadPoint[] {
  const series: LoadPoint[] = [];
  let before: number | null = null;
  for (const wave of wavesOf(containers)) {
    if (before !== null) {
      const missing = Math.round((wave.startAt - before) / SAMPLE_INTERVAL_MS) - 1;
      for (let step = 1; step <= missing; step += 1) {
        series.push({
          sampledAt: new Date(before + step * SAMPLE_INTERVAL_MS).toISOString(),
          cpuPercent: null,
          memPercent: null
        });
      }
    }
    const samples = [...wave.samples.values()];
    series.push({
      sampledAt: new Date(wave.startAt).toISOString(),
      cpuPercent: normalizeCpu(sumOf(samples.map((sample) => sample.cpuPercent)), info?.cpuCores ?? null),
      memPercent: normalizeMemory(sumOf(samples.map((sample) => sample.memUsageBytes)), info?.memTotalBytes ?? null)
    });
    before = wave.startAt;
  }
  return series.slice(-SAMPLE_CAPACITY);
}

/**
 * Die Last eines Arms durch seine Container.
 *
 * ⚠️ DIE ZAHL IST DIE SUMME DER LETZTEN WERTE DER LAUFENDEN CONTAINER — genau
 * der Werte, die ihre Details zeigen (Abnahme von #214: „die Zahl stimmt mit
 * der Summe der Container-Details überein"). Sie ist deshalb nicht der letzte
 * Punkt des Verlaufs: fehlt einem Container in der jüngsten Welle sein Wert,
 * zeigt sein Detail trotzdem den vorigen, und die Zahl folgt dem Detail.
 * Ein gestoppter Container zählt nicht mit; sein Detail zeigt auch keinen
 * Wert.
 *
 * `null`, wenn der Arm über seine Ausstattung nichts gesagt hat — ohne Kerne
 * und Arbeitsspeicher gibt es keinen Nenner.
 */
export function hostLoad(containers: readonly ContainerOverviewEntry[], info: HostInfo | null): HostLoad | null {
  if (info === null) return null;
  const running = containers.filter((container) => container.running && container.stats !== null);
  const memUsageBytes = sumOf(running.map((container) => container.stats?.memUsageBytes ?? null));
  return {
    cpuPercent: normalizeCpu(sumOf(running.map((container) => container.stats?.cpuPercent ?? null)), info.cpuCores),
    memPercent: normalizeMemory(memUsageBytes, info.memTotalBytes),
    memUsageBytes,
    cpuCores: info.cpuCores,
    memTotalBytes: info.memTotalBytes,
    series: loadSeries(containers, info)
  };
}
