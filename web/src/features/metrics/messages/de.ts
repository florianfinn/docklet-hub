// German texts of the feature `metrics` (#283): CPU and RAM per container in
// the detail and in the row (#213), the load by containers on the host card
// (#214). German is the source of the message type; `en.ts` closes with
// `satisfies typeof deMetrics`.
//
// Put together with the texts of every other surface in
// `web/src/app/i18n/messages.ts`; `platform/` may not import a feature.

export const deMetrics = {
  metricsTitle: "Auslastung",
  metricsHistory: "letzte 10 Minuten",
  metricsCpu: "CPU",
  // ⚠️ Die CPU folgt `docker stats`: 100 % sind EIN Kern. 250 % auf einem
  // Vierkerner ist ein gültiger Wert und kein Fehler — die Beschriftung sagt
  // das, damit er nicht wie einer aussieht.
  metricsCpuHint: "wie docker stats — 100 % je Kern",
  metricsMemory: "RAM",
  // „312 MB von 2 GB“ — der Nenner ist das Limit des Containers, sonst fehlt er.
  metricsMemoryOf: "{used} von {total}",
  // `null` heißt beim Agenten „gerade nicht ermittelbar“ und nicht null Prozent.
  metricsUnavailable: "nicht ermittelbar",
  metricsStopped: "Der Container läuft nicht — es gibt keinen Verlauf.",
  metricsFailed: "Die Messwerte ließen sich nicht laden.",
  metricsCpuChart: "Verlauf der CPU in den letzten 10 Minuten",
  metricsMemoryChart: "Verlauf des RAM in den letzten 10 Minuten",
  // Die Kurzform in der Container-Zeile: „CPU 12 %“, daneben der RAM.
  metricsRowCpu: "CPU {value}",

  // ⚠️ „DURCH CONTAINER“ UND NICHT „HOST“ (docs/design/management-aids.md
  // §4.2): summiert wird, was der Agent sampelt. Prozesse außerhalb von Docker
  // fehlen, und ebenso jeder Container außerhalb seiner Allowlist.
  hostLoadTitle: "Last durch Container",
  hostLoadCpu: "CPU durch Container",
  hostLoadMemory: "RAM durch Container",
  hostLoadHint: "Summe der Container, die der Agent misst — nicht die Last des ganzen Hosts.",
  hostLoadCpuChart: "Verlauf der CPU durch Container in den letzten 10 Minuten",
  hostLoadMemoryChart: "Verlauf des RAM durch Container in den letzten 10 Minuten"
};
