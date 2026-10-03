// The body of the input route (#260): `{ "data": "<base64>" }` to bytes, or
// `null`. It stood in `api/routes/exec-routes.ts`; the service reads it before
// the agent is asked. The comment is unchanged from there and still German.

/**
 * Der base64-Rumpf der Eingabe — oder `null`, wenn er keiner ist.
 *
 * ⚠️ DIE FORM IST ENTSCHIEDEN UND NICHT ERFUNDEN (Leitstand, 2026-09-08):
 * `{ "data": "<base64>" }`, dieselbe Form, die der Agent an seiner Route nimmt.
 * Ein Terminal überträgt beliebige BYTES und keinen Text — Strg-C ist `0x03`,
 * eine halbe UTF-8-Folge beim schnellen Tippen ist gar kein Zeichen —, und ein
 * JSON-String trägt so etwas nur als Escape-Folge, die jede Zwischenschicht
 * anders normalisieren darf. base64 auf dem ganzen Weg ist EINE Kodierung statt
 * zweier. Dass der Hub sie hier dekodiert und `sendInput` sie danach wieder
 * kodiert, ist kein Umweg, sondern die Trennung: jede Schicht spricht die Form
 * ihrer eigenen Gegenseite.
 *
 * ⚠️ EIN UNGÜLTIGER RUMPF WIRD ABGELEHNT UND NICHT ALS LEERE EINGABE
 * DURCHGELASSEN. Eine Eingabe, die ankommt und nichts tut, ist der Fehler, den
 * niemand findet: der Betreiber tippt, es passiert nichts, und keine Zeile
 * irgendwo sagt warum.
 *
 * ⚠️ `Buffer.from(x, "base64")` PRÜFT NICHTS — es überliest, was nicht ins
 * Alphabet gehört, und liefert für `"!!!!"` einen leeren Puffer statt eines
 * Fehlers. Deshalb hier drei Stufen: das Alphabet, die durch vier teilbare
 * Länge und der Rundlauf. Erst der dritte fängt eine Zeichenkette, die zwar aus
 * gültigen Zeichen besteht, aber keine kanonische Kodierung ist.
 */
export function readInputBytes(body: unknown): Uint8Array | null {
  const data = (body as Record<string, unknown> | undefined)?.data;
  if (typeof data !== "string" || data === "") return null;
  if (data.length % 4 !== 0) return null;
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(data)) return null;
  const bytes = Buffer.from(data, "base64");
  if (bytes.length === 0 || bytes.toString("base64") !== data) return null;
  return new Uint8Array(bytes);
}
