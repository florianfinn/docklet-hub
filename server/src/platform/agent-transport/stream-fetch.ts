import { request as httpRequest, type IncomingMessage } from "node:http";
import { request as httpsRequest } from "node:https";
import { Readable } from "node:stream";

// Ein `fetch` für die LANGLEBIGEN Ströme zum Agenten — Log, Shell, Anwenden.
//
// ⚠️ DAS EINGEBAUTE `fetch` HAT EINE FRIST AUF DEN RUMPF, UND SIE IST NICHT
// ABZUSCHALTEN. Node führt `fetch` über undici, und undici bricht einen Rumpf
// ab, in dem 300 Sekunden lang kein Byte kommt (`bodyTimeout`, Fehler
// `UND_ERR_BODY_TIMEOUT`). Gemessen am 2026-09-29 aus dem Hub-Container gegen
// den lokalen Agenten, Log-Strom von AdGuard Home: `status 200`, der
// Ausschnitt, dann nach 300,8 s `TypeError: terminated`, Ursache
// `UND_ERR_BODY_TIMEOUT`. Die Log-Route schrieb daraufhin `agent-stream-broken`
// in den Strom, und die Oberfläche meldete „mitten im Log abgerissen" — bei
// einem Container, der schlicht fünf Minuten nichts gesagt hatte. Dieselbe
// Frist trifft eine Shell, in der fünf Minuten niemand tippt.
//
// Abschalten ließe sie sich nur über einen eigenen `dispatcher` (`new Agent({
// bodyTimeout: 0 })`), und dessen Klasse liefert Node nicht aus — dafür
// bräuchte es `undici` als Abhängigkeit, in einer Fassung, die zu der in Node
// eingebauten passen muss. `node:http` hat keine solche Frist (ein Socket ohne
// `setTimeout` wartet beliebig lange), und die dreißig Zeilen hier sind
// weniger als eine Abhängigkeit (AGENTS.md, „Abhängigkeiten").
//
// ⚠️ NUR FÜR STRÖME. `agentRequest` und `agentDownload` bleiben beim
// eingebauten `fetch`: sie haben ein Ende, und für sie ist eine Frist auf
// einen stehenden Rumpf eher Schutz als Störung.
//
// Die Form ist die von `fetch`, damit `fetchImpl` in den Tests weiter jedes
// `fetch` annimmt und die Aufrufer nichts merken. Unterstützt wird genau, was
// `openStream` und `watchStreamRejection` hineinreichen: Methode, Kopfzeilen
// als Objekt, ein Rumpf als Zeichenkette und ein `signal`.
export const streamFetch = ((input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) =>
  new Promise<Response>((resolve, reject) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    const send = url.protocol === "https:" ? httpsRequest : httpRequest;
    const outgoing = send(
      url,
      {
        method: init?.method ?? "GET",
        headers: Object.fromEntries(new Headers(init?.headers)),
        // Ein Abbruch vor der Antwort wirft hier einen `AbortError`, danach
        // zerstört er den Rumpf — beides sieht der Aufrufer genau wie beim
        // eingebauten `fetch`.
        signal: init?.signal ?? undefined
      },
      (incoming) => resolve(toResponse(incoming))
    );
    outgoing.on("error", reject);
    if (typeof init?.body === "string") outgoing.end(init.body);
    else outgoing.end();
  })) as typeof fetch;

function toResponse(incoming: IncomingMessage): Response {
  const headers = new Headers();
  for (const [name, value] of Object.entries(incoming.headers)) {
    if (value === undefined) continue;
    for (const single of Array.isArray(value) ? value : [value]) headers.append(name, single);
  }
  const status = incoming.statusCode ?? 502;
  // Ein Rumpf bei 204/304 lässt den Konstruktor von `Response` werfen.
  const body =
    status === 204 || status === 304 ? null : (Readable.toWeb(incoming) as unknown as ReadableStream<Uint8Array>);
  if (body === null) incoming.resume();
  return new Response(body, { status, statusText: incoming.statusMessage, headers });
}
