// Der gemeinsame Transport der Web-API: die vier Wege, auf denen jedes `api.ts`
// unter `web/src/` den Hub anspricht, und der Fehler, den sie werfen.
//
// ⚠️ WARUM ES DIESE DATEI GIBT (Paket B5, Etappe E5a, #5). Bis hierher standen
// `request`, `requestNoContent`, `postJson` und `putJson` in `client.ts` und
// waren dort NICHT exportiert (gemessen am 2026-09-07 auf `c47a33a`:
// `grep -n "^export.*request" web/src/api/client.ts` liefert nichts). Eine
// zweite Datei daneben — `files.ts` — müsste sie also abschreiben, und zwei
// Abschriften derselben Rechnung sind zwei Wahrheiten: wer die eine berichtigt,
// berichtigt die andere nicht, und jede bleibt für sich grün. Genau diesen
// Befund hat dieses Repo schon zweimal beseitigt, bei `stripComments` und bei
// `router-routes.mjs`. Die Definitionen sind deshalb HIERHER gewandert; die
// Aufrufstellen sind geblieben, wo sie waren.
//
// ⚠️ `ApiError` ZIEHT MIT, und das ist keine Geschmacksfrage, sondern die
// einzige Anordnung ohne Modulkreis: `request` WIRFT den Fehler, braucht ihn
// also als WERT und nicht als Typ. Bliebe die Klasse in `client.ts`, importierte
// diese Datei aus `client.ts` und `client.ts` aus dieser — ein Kreis, den ein
// `import type` nicht auflöst, weil ein `throw new` beim Bauen bestehen bleibt.
// Damit die bestehenden Aufrufer nichts merken, reicht `client.ts` die Klasse
// weiter (`export { ApiError }`): `web/src/App.tsx`, `features/hosts/host-errors.ts`,
// `features/marks/mark-errors.ts` und `features/logs/log-errors.ts` holen
// sie unverändert von dort.
//
// Die Sitzung reist im Cookie, das better-auth setzt. `credentials: "include"`
// steht deshalb an jeder Anfrage: ohne es schickt der Browser das Cookie bei
// einem Aufruf über eine andere Adresse als die des Dokuments nicht mit, und
// der Fehler sähe aus wie eine abgelaufene Anmeldung.

// ⚠️ DER MELDER EINER ABGELAUFENEN SITZUNG HÄNGT AM KONSTRUKTOR VON
// `ApiError` UND NICHT AN `request` (#127), und das ist die einzige Anordnung,
// die niemand vergessen kann. `request` und `requestNoContent` sind nicht die
// einzigen Stellen, an denen ein `ApiError` entsteht: `client.ts` wirft ihn
// vor dem Log-Strom, `features/shell/api.ts` vor der Shell, `compose.ts` vor dem Anwenden,
// und `files.ts` dreimal aus dem `XHR` des Uploads, der gar kein `fetch` ist.
// Gemessen am 2026-09-09 auf `00b6c22`:
// `grep -rn "new ApiError" web/src | wc -l` zählt zwölf Stellen, davon zwei in
// dieser Datei. Ein Melder in `request` sähe zwei davon; die anderen zehn
// müssten ihn selbst rufen, und die dreizehnte nächste Woche auch. Am
// Konstruktor gilt er für jede — eine Stelle, die ihn umgeht, gibt es nicht.
//
// ⚠️ WER DIE MELDUNG BEWERTET, IST NICHT DIESE DATEI. Der Transport sagt nur,
// DASS ein 401 kam; ob das eine abgelaufene Sitzung ist oder die erwartete
// Antwort „niemand angemeldet" beim Start, weiß allein `web/src/App.tsx` —
// dort steht der Zustand, der beides unterscheidet. Deshalb steht hier kein
// `if`, das den Start ausnimmt: eine Bedingung über einen Zustand, den diese
// Datei nicht kennt, wäre geraten.

import { reportUnauthorized } from "./session-expiry";

export class ApiError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    if (status === 401) reportUnauthorized();
  }
}

/**
 * Der Fehlercode aus dem Rumpf einer Antwort, oder `null`.
 *
 * ⚠️ `ApiError.message` TRÄGT DEN RUMPF ALS JSON-TEXT — `request` legt ihn dort
 * mit `JSON.stringify` ab (`readErrorDetail` unten). Der Server schickt
 * `{ error, message }` (`failWith` in `server/src/platform/http/route-responses.ts`), und
 * das `error` ist der maschinenlesbare Teil. Gelesen wird deshalb ER und nicht
 * der Satz daneben: der Satz ist deutsche Prosa des Servers und ändert sich,
 * ohne dass eine Bedeutung sich änderte.
 *
 * Sie stand bis #188 zweimal wortgleich, in `files/file-errors.ts` und in
 * `compose/compose-errors.ts`; das Protokoll brauchte sie als dritte Fläche,
 * und eine dritte Abschrift wäre die, die beim nächsten Mal abweicht.
 */
export function errorCode(error: unknown): string | null {
  if (!(error instanceof ApiError)) return null;
  try {
    const parsed = JSON.parse(error.message) as { error?: unknown };
    return typeof parsed.error === "string" ? parsed.error : null;
  } catch {
    return null;
  }
}

/**
 * Hat die HERKUNFTSPRÜFUNG DES HUBS abgewiesen — und nicht der Arm?
 *
 * ⚠️ DERSELBE STATUS, ZWEI ABSENDER, UND DER UNTERSCHIED IST DIE DIAGNOSE.
 * `403 forbidden-origin` kommt aus `server/src/platform/http/request-origin-guard.ts`,
 * bevor irgendein Handler die Anfrage sieht; `403 agent-forbidden` ist die
 * Allowlist des Arms. Gemessen am 2026-09-29 (#186): über reines HTTP stand
 * auf Protokoll und Dateien jedes Arms „Der Arm hat den Zugriff abgelehnt",
 * während die Anfrage den Arm nie erreicht hatte — der Satz schickte die
 * Suche in die Allowlist statt in den Browser.
 *
 * Der Wert ist eine Kennung des Hubs und deshalb englisch (AGENTS.md,
 * Sprache).
 */
export function isOriginRefused(error: unknown): boolean {
  return error instanceof ApiError && error.status === 403 && errorCode(error) === "forbidden-origin";
}

// Der Rumpf einer Fehlerantwort trägt bei better-auth eine Meldung. Sie wird
// durchgereicht, aber an den meisten Stellen nicht angezeigt: die Oberfläche
// sagt „E-Mail oder Passwort stimmen nicht" und nicht, welches von beidem. An
// der Host-Verwaltung liest eine Aufrufstelle `error.message` gezielt aus
// (die Meldung des fehlenden Endpoints, §4) — deshalb bleibt der Rumpf hier
// erhalten und wird nicht verworfen.
export async function readErrorDetail(response: Response): Promise<string> {
  try {
    return JSON.stringify(await response.json());
  } catch {
    return response.statusText;
  }
}

export async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const response = await fetch(path, { credentials: "include", ...init });
  if (!response.ok) {
    throw new ApiError(response.status, await readErrorDetail(response));
  }
  return (await response.json()) as T;
}

/**
 * A response that arrived with status 2xx but does not match its schema.
 *
 * Not an `ApiError`: the hub answered, and answered successfully — what is
 * wrong is the shape. Telling the two apart keeps `errorCode` and the 401
 * reporter out of it; neither has anything to say about a missing field.
 */
export class ResponseShapeError extends Error {
  readonly path: string;

  constructor(path: string, issues: readonly ShapeIssue[]) {
    const where = issues.map((issue) => `${issue.path.map(String).join(".") || "(root)"}: ${issue.message}`);
    super(`${path}: the response does not match the contract — ${where.join("; ")}`);
    this.name = "ResponseShapeError";
    this.path = path;
  }
}

type ShapeIssue = { readonly path: readonly PropertyKey[]; readonly message: string };

// The part of a zod schema this file uses, written out so that `web` does not
// need `zod` as a dependency of its own: the schemas come from `contract`.
type ResponseSchema<T> = {
  safeParse(input: unknown):
    | { success: true; data: T }
    | { success: false; error: { issues: readonly ShapeIssue[] } };
};

/**
 * Checks a response body against its schema from `contract` (#247).
 *
 * `request<T>` casts blindly; this is the step that makes the cast true or
 * throws. Unknown extra fields are dropped by the schema, not reported — hub
 * and bundle may briefly run different versions.
 *
 * ⚠️ The error is logged HERE and not left to the caller. The screens catch
 * every failure alike and show one generic sentence (`setFailed(true)`); the
 * path and field this error names would otherwise reach nobody. One place
 * logs for every caller, including the next one.
 */
export function parseResponse<T>(path: string, schema: ResponseSchema<T>, body: unknown): T {
  const result = schema.safeParse(body);
  if (result.success) return result.data;
  const error = new ResponseShapeError(path, result.error.issues);
  console.error(error);
  throw error;
}

// Für Antworten ohne Rumpf (`204`): `response.json()` schlüge an leerer
// Zeichenkette fehl und sähe wie ein Serverfehler aus, der keiner ist.
export async function requestNoContent(path: string, init: RequestInit = {}): Promise<void> {
  const response = await fetch(path, { credentials: "include", ...init });
  if (!response.ok) {
    throw new ApiError(response.status, await readErrorDetail(response));
  }
}

export function postJson<T>(path: string, body: unknown): Promise<T> {
  return request<T>(path, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body)
  });
}

// Dasselbe mit `PUT`, für die Aufrufe, bei denen zweimal dasselbe Absenden
// denselben Zustand ergibt.
export function putJson<T>(path: string, body: unknown): Promise<T> {
  return request<T>(path, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body)
  });
}
