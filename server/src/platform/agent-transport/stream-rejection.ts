import { AgentError } from "./protocol.js";
import { streamFetch } from "./stream-fetch.js";

// Der Fehlerrumpf einer ABGELEHNTEN Stromanfrage — für die zwei Ströme, die
// ihn brauchen.
//
// ── WARUM DAS NICHT IN `protocol.ts` STEHT ──────────────────────────────────
//
// `agentRequest` liest den Fehlerrumpf und legt ihn in `AgentError.detail`;
// `openStream` tut das ABSICHTLICH nicht — bei einem Strom gehört der Rumpf
// dem Aufrufer, und ein dort verbrauchter Rumpf wäre für ihn für immer weg
// (die Begründung steht in `protocol.ts`). Für den Log-Strom ist das richtig:
// er lehnt mit Status ab, und mehr braucht niemand.
//
// Der Rumpf einer ABGELEHNTEN Antwort gehört dagegen niemandem: es gibt in
// diesem Fall keinen Strom, den er wegnehmen könnte. Deshalb wird `fetch` für
// die Dauer des Aufbaus umschlossen, die Antwort festgehalten — und der Rumpf
// NUR gelesen, wenn der Aufbau geworfen hat und die Antwort nicht `ok` ist.
//
// ── WARUM ES JETZT EINE EIGENE DATEI IST ────────────────────────────────────
//
// Die Vorrichtung stand bis #129 als `openExecStream` in `exec.ts`, mit dem
// Satz daneben: „für einen Fall, den genau eine Route hat". Dieser Satz ist
// seit #129 falsch — der Anwende-Strom der Compose-Fläche braucht dasselbe,
// und zwar für eine Entscheidung und nicht nur für eine Meldung: der Hub fällt
// bei einer `404` auf den synchronen Weg zurück und muss dafür „Route
// unbekannt" von einer benannten Ablehnung des Arms unterscheiden. Zwei
// Abschriften derselben zwanzig Zeilen wären zwei Wahrheiten darüber, wann ein
// Fehlerrumpf gelesen wird.
//
// ⚠️ EIN SIEBTER WEG ZUM AGENTEN IST DAS NICHT. Beide Aufrufer rufen
// weiterhin `agentStreamPost` und laufen damit durch dieselben Kopfzeilen und
// dieselbe Fehlerübersetzung; diese Datei reicht nur ein umschlossenes `fetch`
// hinein und liest hinterher, was ohnehin verfiele.

/** Was ein Aufrufer für die Dauer des Aufbaus braucht. */
export type StreamRejectionWatch = {
  /** Statt `options.fetchImpl` weiterreichen — sonst passiert nichts. */
  fetchImpl: typeof fetch;
  /**
   * Der Fehler des Aufbaus, um den ausgewerteten Rumpf ergänzt.
   *
   * Alles, was kein `AgentError` ist, kommt unverändert zurück: ein Abbruch
   * des Aufrufers ist kein Befund der Gegenseite und darf nicht zu einem
   * werden.
   */
  withDetail: (error: unknown) => Promise<unknown>;
};

export function watchStreamRejection(fetchImpl?: typeof fetch): StreamRejectionWatch {
  // Dieselbe Vorgabe wie in `openStream` — das eingebaute `fetch` reißt einen
  // stillen Rumpf nach 300 s ab (`stream-fetch.ts`).
  const base = fetchImpl ?? streamFetch;
  const seen: { response: Response | null } = { response: null };

  const watching = (async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
    const response = await base(input, init);
    seen.response = response;
    return response;
  }) as typeof fetch;

  return {
    fetchImpl: watching,
    withDetail: async (error: unknown) => {
      if (!(error instanceof AgentError)) return error;
      const response = seen.response;
      if (response === null || response.ok) return error;
      // `catch(() => null)`: ein Vermittler, der mit `502` und einer HTML-Seite
      // antwortet, soll denselben Fehler ergeben wie vorher — kein zweiter
      // Fehler beim Lesen des ersten.
      const detail = await response.json().catch(() => null);
      return new AgentError(error.message, error.status, { detail });
    }
  };
}

/**
 * Der Fehlerschlüssel aus dem Rumpf einer Ablehnung — oder `null`.
 *
 * ⚠️ ER WIRD GEGEN NICHTS GEPRÜFT. Was hier zurückkommt, ist der Wert der
 * GEGENSEITE, wortgleich und ungefiltert; die Entscheidung, was er bedeutet,
 * trifft der Aufrufer. Eine Prüfung gegen eine Liste bekannter Schlüssel wäre
 * die zweite Wahrheit neben `contract/src/agent/` — und ein
 * Schlüssel, den der Agent morgen ergänzt, käme hier gar nicht mehr an.
 *
 * ⚠️ `detail` IST NUR GEFÜLLT, wo der Aufrufer ihn hat füllen lassen:
 * `agentRequest` tut es für jeden JSON-Weg, ein Strom nur über
 * `watchStreamRejection`. Ohne beides ist die Antwort `null`, und das ist ein
 * Ergebnis und kein Fehler.
 */
export function agentFailureReason(error: unknown): string | null {
  if (!(error instanceof AgentError)) return null;
  const detail = error.detail;
  if (typeof detail !== "object" || detail === null || Array.isArray(detail)) return null;
  const reason = (detail as Record<string, unknown>).error;
  return typeof reason === "string" && reason.length > 0 ? reason : null;
}
