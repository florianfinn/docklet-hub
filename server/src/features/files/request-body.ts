import type { Request } from "express";

// What the file routes read from the HTTP request and the services must not
// see: the kind of the body and its bytes (#262).

/**
 * Whether the caller announced a JSON body.
 *
 * ⚠️ CASE-INSENSITIVE, and that is measured: `express.json` (`type-is`) reads
 * `Application/JSON` as JSON and consumes the body, so a check that compared
 * the literal `application/json` would let it through to a stream that is
 * already empty. The header NAME arrives lower case from Node, its value does
 * not.
 */
export function isJsonBody(request: Pick<Request, "headers">): boolean {
  const contentType = request.headers["content-type"];
  return String(contentType ?? "").toLowerCase().includes("application/json");
}

/**
 * Den Rumpf der Anfrage als Bytes — oder `null`, wenn er den Deckel reißt.
 *
 * ⚠️ Gezählt wird WÄHREND des Lesens und nicht am Ende. Ein `content-length`
 * zu glauben wäre eine Angabe des Aufrufers; erst zu sammeln und dann zu
 * messen hiesse, den Speicher schon belegt zu haben, dessen Grenze man prüft.
 *
 * ⚠️ Zurück kommt ein `Buffer` und keine nackte `Uint8Array`. Ein `Buffer` IST
 * eine `Uint8Array` und geht damit unverändert an `uploadFile`; der Texteditor
 * braucht darüber hinaus `toString("utf8")` und den Rückvergleich, und beides
 * hängt am `Buffer`. Eine Umwandlung an der Aufrufstelle wäre eine zweite
 * Kopie derselben Bytes.
 *
 * An empty body is an empty `Buffer` and no failure: an upload of zero bytes
 * is an empty file, and saving an empty text is an empty text. What must never
 * become an empty file is a body that was meant as something else; that is
 * `isJsonBody`, checked before this function runs.
 *
 * ⚠️ ÜBER DER GRENZE WIRD DIE VERBINDUNG NICHT GEKAPPT, und das ist gemessen
 * (2026-09-07, der Fall „ein Text über MAX_TEXT_BYTES …"): ein `destroy()`
 * hier zerstört den Socket, BEVOR der Handler seine `413` schreiben kann — der
 * Aufrufer sieht dann `fetch failed`, also einen Verbindungsabbruch statt
 * einer Fehlerkennung, und im Browser sähe das aus wie ein Netzproblem.
 * Dasselbe gilt für ein blosses `return` aus einem `for await (… of request)`:
 * der Async-Iterator eines `Readable` zerstört den Strom beim Verlassen der
 * Schleife von selbst. Deshalb `iterator({ destroyOnReturn: false })` und
 * danach `resume()` — der Rest der Anfrage wird gelesen und verworfen, damit
 * die Antwort noch hinausgeht.
 *
 * Der Preis, ehrlich genannt: der Rest reist noch über die Leitung, obwohl er
 * nirgends landet. Gegen den Speicher schützt diese Funktion trotzdem — sie
 * legt ab der Grenze kein Byte mehr ab —, und die Alternative wäre eine
 * Ablehnung, die der Aufrufer nicht lesen kann.
 */
export async function readBytes(request: Request, limit: number): Promise<Buffer | null> {
  const parts: Buffer[] = [];
  let total = 0;
  for await (const chunk of request.iterator({ destroyOnReturn: false })) {
    const part = chunk as Buffer;
    total += part.length;
    if (total > limit) {
      request.resume();
      return null;
    }
    parts.push(part);
  }
  return Buffer.concat(parts);
}
