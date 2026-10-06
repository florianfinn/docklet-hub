import { EXEC_SESSION_REJECTION_KEY } from "contract";

import type { AgentError } from "../../platform/agent-transport/protocol.js";

// How the refusals of the agent become answers of the hub (#260). They stood
// in `api/routes/exec-routes.ts` as functions that wrote the response; here
// they return what to write, `{ status, error, message }`, so that the tables
// are checked without Express and the route is the one place that answers.
// The comments of the tables are unchanged from there and still German.

/** What the route writes: status, the hub's code and the sentence for the person. */
export type Rejection = { status: number; error: string; message: string };

/**
 * Der Schlüssel einer Ablehnung, ohne den angehängten Text.
 *
 * ⚠️ EINER DER ZEHN SCHLÜSSEL TRÄGT EINEN TEXT HINTER EINEM DOPPELPUNKT —
 * `self-management-locked: <directory>`. Wer ihn mit `===` vergleicht,
 * trifft ihn NIE: die Gleichheit scheitert am
 * Zusatz, der Zweig läuft ins `default`, und der Betreiber bekommt eine
 * pauschale Ablehnung statt der Auskunft, welches Verzeichnis gesperrt ist.
 *
 * Der Zusatz selbst geht dabei nicht verloren — er steht weiter im rohen Wert,
 * und wer ihn anzeigen will, nimmt den. Diese Funktion beantwortet nur die
 * Frage „welcher Schlüssel ist es".
 */
export function execRejectionKey(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const key = raw.split(":", 1)[0]?.trim() ?? "";
  return key === "" ? null : key;
}

/**
 * Die Übersetzung der zehn Ablehnungen des Agenten an der Stromroute.
 *
 * Die Reihenfolge ist die Prüfreihenfolge des Agenten (`exec-protokoll.md` §1);
 * sie steht hier nur der Lesbarkeit halber, entschieden wird über den
 * SCHLÜSSEL und nicht über den Status. Ein `409` heißt an dieser Fläche zwei
 * verschiedene Dinge (`container-not-started` und `no-shell`), ein `404` und
 * ein `403` ebenso — eine Abbildung nach dem Status träfe für die
 * erste Aufrufstelle zu und für die späteren nicht.
 *
 * ⚠️ EIN SCHLÜSSEL TRÄGT EINEN ANGEHÄNGTEN TEXT hinter einem Doppelpunkt
 * (`self-management-locked: <directory>`). Wer ihn mit `===` verglich, träfe
 * ihn nie. Deshalb steht hier der reine Schlüssel und
 * davor `execRejectionKey` — die Funktion weiter oben, die genau dafür
 * gebaut ist. Der Zusatz geht nicht verloren: `appendRaw` hängt den rohen Wert
 * an den Satz, damit der Betreiber erfährt, WELCHES Verzeichnis gesperrt ist.
 */
const AGENT_START_REJECTIONS: ReadonlyMap<
  string,
  { status: number; error: string; message: string; appendRaw?: true }
> = new Map([
  // A wrong secret is a fault of the HUB's set-up, not of the request.
  [
    "unauthorized",
    {
      status: 502,
      error: "agent-unreachable",
      message: "Hub und Arm tragen verschiedene Geheimnisse. Das ist ein Fehler der Einrichtung des Hubs."
    }
  ],
  [
    // ⚠️ EINE EIGENE KENNUNG UND KEIN SAMMELFALL. Der Betreiber hat den
    // Kill-Switch des Arms umgelegt; das ist kein Ausfall, sondern eine
    // Einstellung, und die Oberfläche muss das sagen können.
    "agent-read-only",
    {
      status: 503,
      error: "agent-read-only",
      message: "Dieser Arm steht auf „nur lesen“. Eine Shell öffnet er nicht, solange der Kill-Switch liegt."
    }
  ],
  [
    "not-allowlisted",
    {
      status: 403,
      error: "agent-forbidden",
      message: "Diesen Container führt der Arm nicht in seiner Allowlist."
    }
  ],
  [
    // ⚠️ THE THIRTEENTH REFUSAL, from agent v0.30.0 on (#234): the container is
    // in the observer class of the allowlist (`observeOnly`). The agent lets it
    // be read and refuses everything that acts — a shell included — with
    // `403 observe-only`. An own code and no `agent-forbidden`: the remedy is
    // not "the allowlist lacks the container" but "the operator released it for
    // looking only", and the surface has to be able to say that.
    "observe-only",
    {
      status: 403,
      error: "container-observe-only",
      message: "Dieser Container ist nur zum Beobachten freigegeben. Eine Shell öffnet der Arm dort nicht."
    }
  ],
  [
    "container-gone",
    {
      status: 404,
      error: "container-unknown",
      message: "Diesen Container führt dieser Arm nicht mehr."
    }
  ],
  [
    "self-management-locked",
    {
      status: 403,
      error: "agent-forbidden",
      message: "Der Arm sperrt dieses Verzeichnis gegen Selbstverwaltung.",
      appendRaw: true
    }
  ],
  [
    "container-not-started",
    {
      status: 409,
      error: "container-not-running",
      message: "Dieser Container läuft nicht. Eine Shell braucht einen laufenden Prozess."
    }
  ],
  [
    // ⚠️ NICHT DIESELBE KENNUNG WIE `own-session-limit`, obwohl beide `429`
    // sind. Hier ist der Deckel des ARMS erreicht (vier Sitzungen), dort der
    // eigene (zwei). Die Abhilfe ist verschieden — bei der einen wartet man,
    // bis ein anderer Mensch eine Shell schließt, bei der anderen schließt man
    // seine eigene —, und eine gemeinsame Kennung machte aus zwei Ratschlägen
    // einen falschen.
    "too-many-sessions",
    {
      status: 429,
      error: "too-many-sessions",
      message: "Dieser Arm führt bereits so viele Shells, wie er zulässt. Eine geschlossene gibt einen Platz frei."
    }
  ],
  [
    "no-shell",
    {
      status: 409,
      error: "no-shell",
      message: "In diesem Image gibt es weder „bash“ noch „sh“. Ohne Shell lässt sich kein Terminal öffnen."
    }
  ],
  [
    "exec-start-failed",
    {
      status: 502,
      error: "agent-unreachable",
      message: "Der Arm konnte die Shell nicht anlegen."
    }
  ]
]);

/**
 * Der Ablehnungsschlüssel aus dem Fehlerrumpf des Agenten — oder `null`.
 *
 * ⚠️ Der Rumpf steht nur deshalb in `AgentError.detail`, weil `openExecStream`
 * in `agent-client.ts` ihn eigens nachholt. Bei jedem anderen Strom dieses Hubs
 * ist `detail` leer, und dann fällt die Übersetzung unten auf ihren
 * Sammelfall — das ist richtig und nicht der Verlust einer Auskunft, die es
 * gäbe.
 */
function rejectionKeyOf(error: AgentError): string | null {
  const detail = error.detail;
  if (typeof detail !== "object" || detail === null) return null;
  return execRejectionKey((detail as Record<string, unknown>).error);
}

/**
 * Die Fehlerübersetzung an der Grenze — VOR der ersten Stromzeile.
 *
 * Alle zehn Ablehnungen des Agenten fallen dort hin (`exec-protokoll.md` §1),
 * und deshalb darf und muss diese Funktion einen echten Statuscode setzen. Ab
 * der ersten Zeile geht das nicht mehr; dort steht die `error`-Zeile.
 */
export function describeStartRejection(error: AgentError): Rejection {
  const key = rejectionKeyOf(error);
  const known = key === null ? undefined : AGENT_START_REJECTIONS.get(key);
  if (!known) {
    // Ein Schlüssel, den diese Tabelle nicht führt, ist aus Sicht des Browsers
    // dasselbe wie ein stummer Arm: der Hub konnte ihn nicht bedienen. Der
    // vage Satz und nicht ein falscher — dieselbe Haltung wie bei den
    // `409`-Fällen der Datei-Fläche.
    return { status: 502, error: "agent-unreachable", message: error.message };
  }
  const raw = (error.detail as Record<string, unknown> | null)?.error;
  const message = known.appendRaw && typeof raw === "string" ? `${known.message} (${raw})` : known.message;
  return { status: known.status, error: known.error, message };
}

/**
 * Die Übersetzung an den DREI KURZEN Routen.
 *
 * ⚠️ EINE ANDERE TABELLE ALS AN DER STROMROUTE, und das ist kein Versehen. Der
 * Agent kennt dort andere Ablehnungen (`exec-protokoll.md` §3):
 * `input-too-large` (413) nur an `input`, `agent-read-only` (503) an `input`
 * und `size`, und `session-unknown` (404) überall. Eine gemeinsame Tabelle
 * müsste für jede Route entscheiden, welche Hälfte gilt — und wäre beim ersten
 * Sonderfall falsch.
 *
 * ⚠️ Das Wort steht in dieser Zeile ganz in Backticks, und das ist Absicht:
 * der Umlaut-Wächter kennt für diese Datei eine benannte Ausnahme, prüft die
 * Lage aber JE ZEILE. Ein über zwei Zeilen gebrochenes Backtick-Paar ergibt
 * dort keine Spanne, und die Ausnahme greift dann nicht — gemessen am
 * 2026-09-08 an genau dieser Stelle.
 *
 * ⚠️ `session-unknown` DES AGENTEN WIRD ZU `session-unknown` DES HUBS, und
 * damit zu derselben Antwort, die das Register selbst gibt. Das ist die
 * Auskunftssperre: unbekannt, fremd und noch nicht gekoppelt sind beim Agenten
 * bewusst nicht unterscheidbar, damit sich fremde Ids nicht über die
 * Fehlermeldung bestätigen lassen. Der Hub darf daraus keine zwei Meldungen
 * machen — auch nicht dadurch, dass die eine Hälfte aus dem Register kommt und
 * die andere vom Arm.
 */
export function describeSessionRejection(error: AgentError): Rejection {
  const key = rejectionKeyOf(error);
  if (key === "input-too-large" || error.status === 413) {
    // ⚠️ DIE GRENZE GILT AUF DER BASE64-ZEICHENKETTE und nicht auf den Bytes
    // darin — rund ein Drittel weniger Nutzlast, als die Zahl aussagt. Der Hub
    // setzt sie NICHT selbst durch: sie ist eine Zahl der Gegenseite, und eine
    // zweite Schranke hier würde still falsch, sobald der Agent seine ändert.
    // Er reicht die Ablehnung übersetzt weiter.
    return {
      status: 413,
      error: "input-too-large",
      message: "Diese Eingabe ist dem Arm zu groß. Er nimmt je Anfrage 64 KiB base64 an, also rund 48 KiB rohe Bytes."
    };
  }
  if (key === "agent-read-only" || error.status === 503) {
    return {
      status: 503,
      error: "agent-read-only",
      message: "Dieser Arm steht auf „nur lesen“. Er hat die Sitzung dabei beendet — „schließen“ geht weiter, tippen nicht."
    };
  }
  if (key === "observe-only") {
    // A registry sync can downgrade an open shell to the observer class
    // (#234): the agent ends the session and answers `403 observe-only` at
    // `input` and `size`; `close` keeps working.
    return {
      status: 403,
      error: "container-observe-only",
      message:
        "Dieser Container ist inzwischen nur zum Beobachten freigegeben. Der Arm hat die Shell dabei beendet — " +
        "„schließen“ geht weiter, tippen nicht."
    };
  }
  if (key === EXEC_SESSION_REJECTION_KEY || error.status === 404) {
    return { status: 404, error: "session-unknown", message: SESSION_UNKNOWN_MESSAGE };
  }
  return { status: 502, error: "agent-unreachable", message: error.message };
}

/**
 * Die EINE Antwort auf vier Lagen — unbekannt, fremd, falscher Arm, noch nicht
 * gekoppelt.
 *
 * ⚠️ KEIN SCHLAMPEREI-SAMMELBECKEN, sondern gespiegelt vom Agenten
 * (`exec-protokoll.md` §3). `ExecSessionRegister.check` liefert dafür genau
 * einen Grund, und zwar wörtlich dasselbe Objekt für alle vier Zweige. Eine
 * zweite Meldung hier hübe die Sperre wieder auf: über unterschiedliche
 * Antworten ließen sich gültige Sitzungs-Ids bestätigen.
 */
export const SESSION_UNKNOWN_MESSAGE =
  "Diese Shell-Sitzung gibt es nicht (mehr) — oder sie gehört zu einem anderen Menschen, " +
  "einem anderen Arm oder einem anderen Container.";
