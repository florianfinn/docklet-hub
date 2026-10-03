// Die Auflösungshaken, mit denen `terminal-surface.ts` überhaupt unter
// `node --test` geladen werden kann — Paket B6, Etappe E8 (#5).
//
// ⚠️ DER DATEINAME TRÄGT KEIN `.test.` — dieselbe Falle wie bei `dom-harness`.
//
// WARUM ES SIE BRAUCHT, gemessen und nicht vermutet. Die geprüfte Datei trägt
// in Zeile 4 ein `import "@xterm/xterm/css/xterm.css"`. Das ist ein
// Vite-Import; `node --import tsx` kennt ihn nicht:
//
//     TypeError [ERR_UNKNOWN_FILE_EXTENSION]: Unknown file extension ".css"
//       for …/@xterm/xterm/css/xterm.css
//
// Gemessen am 2026-09-08. GENAU DAS ist der Grund, warum die Datei bis heute
// von keinem Fall berührt war: sie ließ sich im Testlauf nicht laden, und der
// Reiter daneben bekam deshalb einen eingespeisten Lader statt eines Tests.
//
// ⚠️ DAS ERZEUGNIS WIRD DAFÜR NICHT UMGEBAUT. Die Reihenfolge, die dieses Repo
// dafür festgelegt hat (Entscheidung des Betreibers, 2026-09-06), lautet:
// anders prüfen, die Geste echt nachstellen, die reine Logik prüfen, die Lücke
// benennen — nie das Erzeugnis der Prüfung anpassen. Also wird hier der LADER
// angepasst: `node:module` kennt seit v20 registrierbare Haken, und der Testlauf
// registriert sie zur Laufzeit. Die Datei unter Prüfung bleibt Zeichen für
// Zeichen dieselbe, die Vite bündelt.
//
// WAS DIE HAKEN TUN, und mehr tun sie nicht:
//
//   * `@xterm/xterm/css/xterm.css` (und jedes andere `.css`) wird ein leeres
//     Modul. Ein Stylesheet hat auf die Optionen, die diese Datei setzt,
//     keinen Einfluss — es färbt den Rahmen, den es unter happy-dom ohnehin
//     nicht gibt.
//   * `@xterm/xterm` und `@xterm/addon-fit` werden auf `xterm-double.mjs`
//     umgebogen. Der Test bekommt damit zu sehen, WELCHE Optionen die Datei
//     wirklich setzt — die einzige Frage, die ohne echten Browser überhaupt
//     zu beantworten ist.
//
// ⚠️ SIE GELTEN NUR IM PROZESS, DER SIE REGISTRIERT. `node --test` fährt jede
// Testdatei in einem eigenen Prozess; ein anderer Wächter bekommt von diesen
// Haken nichts mit. Und sie greifen erst ab dem Aufruf von `register(…)` —
// wer die ECHTE Bibliothek sehen will, importiert sie davor (der letzte Fall
// in `terminal-surface.test.mjs` tut genau das).

const STUB = "xterm-stub:";
const SWAPPED = new Set(["@xterm/xterm", "@xterm/addon-fit"]);

/** @type {string | null} */
let doubleUrl = null;

/** @param {{ doubleUrl: string }} data */
export function initialize(data) {
  doubleUrl = data.doubleUrl;
}

export async function resolve(specifier, context, next) {
  if (SWAPPED.has(specifier)) {
    return { url: `${STUB}${specifier}`, shortCircuit: true, format: "module" };
  }
  if (specifier.endsWith(".css")) {
    return { url: `${STUB}css`, shortCircuit: true, format: "module" };
  }
  return next(specifier, context);
}

export async function load(url, context, next) {
  if (!url.startsWith(STUB)) return next(url, context);
  if (url === `${STUB}css`) {
    return { format: "module", source: "export default undefined;\n", shortCircuit: true };
  }
  if (doubleUrl === null) {
    throw new Error("xterm-stub-loader: register(…) ohne { data: { doubleUrl } } aufgerufen");
  }
  // Das Doppel wird nur DURCHGEREICHT und nicht hier hingeschrieben: eine
  // Attrappe, die als Zeichenkette in einem Lader steht, liest niemand mehr.
  const name = url.slice(STUB.length) === "@xterm/xterm" ? "Terminal" : "FitAddon";
  return {
    format: "module",
    source: `export { ${name} } from ${JSON.stringify(doubleUrl)};\n`,
    shortCircuit: true
  };
}
