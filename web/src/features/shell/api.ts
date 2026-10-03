import { isAbort, readNdjson } from "contract";

import { ApiError, postJson, readErrorDetail } from "../../platform/http/transport";

// Die vier Aufrufe der Shell (Paket B6, Etappe E6, #5) — die Browser-Seite zu
// `server/src/features/shell/routes.ts`.
//
// ⚠️ EINE EIGENE DATEI NEBEN `client.ts` UND `files.ts`. `client.ts` steht bei
// über 900 von 1.000 Zeilen (`source-file-size.test.mjs`), und Paket B5 hat
// aus demselben Grund `files.ts` daneben gelegt.
// `web/tests/api-mirror.test.mjs` liest über `client-files.mjs` JEDE `api.ts`
// unter `web/src/` — diese Datei steht also unter demselben Wächter wie
// die beiden anderen, und ein Pfad, zu dem der Router keine Route mit dieser
// Methode führt, ist rot.
//
// ── DIE VIER PFADE ──────────────────────────────────────────────────────────
//
//   POST …/exec                  der NDJSON-Strom
//   POST …/exec/:session/input   { "data": "<base64>" }
//   POST …/exec/:session/size    { cols, rows }
//   POST …/exec/:session/close   ohne Rumpf
//
// ⚠️ `:session` IST DIE SITZUNGS-ID DES HUBS. Die des Agenten verlässt den
// Server nie (`session-register.ts`, `clientViewOf`); der Browser bekommt die des
// Hubs in der `start`-Zeile und schickt sie in den drei kurzen Routen zurück.
//
// ⚠️ AUCH DIE DREI KURZEN TRAGEN `hostId` UND `containerId` MIT, obwohl die
// Sitzung sie kennt. Der Hub hält die Werte aus dem PFAD gegen den Eintrag im
// Register; nähme er sie aus dem Eintrag, verglich er ihn mit sich selbst. Wer
// hier zwei Segmente einspart, nimmt dem Server seinen Abgleich.
//
// ── THE KINDS IN THE STREAM ARE THE AGENT'S ────────────────────────────────
//
// `start`, `output`, `end`, `error` — the values of `execStreamLineSchema` in
// `contract/src/agent/streams.ts`, English since #278. Same situation as the
// log stream: an unknown `kind` silently falls through, so whoever renames
// one here builds a surface that never shows a line.
//
// The error identifiers in the body of a rejection (`host-unknown`,
// `too-many-sessions`, …) are the hub's own. They come BEFORE the first line,
// with the status code, and not in the stream.

/** Die `start`-Zeile: ab hier steht die Sitzung. */
export type ExecStart = { session: string; containerName: string };

/** Die `end`-Zeile. `null` heißt: der Agent hat abgeriegelt. */
export type ExecEnd = { exitCode: number | null };

/**
 * Die `error`-Zeile. `reason` ist ein Wort des HUBS und bleibt roh; `null`,
 * wenn die Zeile keines trug (#176).
 */
export type ExecFailure = { reason: string | null };

export type ExecStreamOptions = {
  /**
   * ⚠️ PFLICHT und nicht wahlfrei. Ohne Abbruch belegt dieser Strom einen der
   * VIER Sitzungsplätze des Arms, bis der Agent nach 30 Minuten selbst
   * abriegelt — dieselbe Begründung wie beim Log-Strom, nur mit einem Deckel
   * von vier statt acht.
   */
  signal: AbortSignal;
  /** Die Startgröße des Terminals in Zellen. */
  cols: number;
  rows: number;
  /** Der Strom steht — der Hub hat mit `200` geantwortet. */
  onOpen?: () => void;
  onStart?: (start: ExecStart) => void;
  onEnd?: (end: ExecEnd) => void;
  onFailure?: (failure: ExecFailure) => void;
};

/**
 * Öffnet die Shell und ruft je Ausgabe zurück.
 *
 * Fehler VOR der ersten Zeile kommen als `ApiError` heraus; der Rumpf steckt
 * als JSON-Text in `error.message` (`transport.ts`), und die Kennung darin
 * liest `execErrorKey` in `shell-errors.ts`.
 *
 * ⚠️ EIN `POST` MIT RUMPF UND KEIN `GET`. Der Strom braucht die Startgröße;
 * sie als Abfrageteil zu schicken wäre die zweite Form derselben Angabe neben
 * der `size`-Route. Der Rumpf ist `{ cols, rows }` — dieselbe Form, die
 * `readTerminalSize` auf der Serverseite liest.
 */
export async function streamContainerExec(
  hostId: string,
  containerId: string,
  options: ExecStreamOptions,
  onOutput: (text: string) => void
): Promise<void> {
  const path = `/api/hosts/${encodeURIComponent(hostId)}/containers/${encodeURIComponent(containerId)}/exec`;

  let response: Response;
  try {
    response = await fetch(path, {
      method: "POST",
      credentials: "include",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ cols: options.cols, rows: options.rows }),
      signal: options.signal
    });
  } catch (error) {
    // Auch der Abbruch WÄHREND des Verbindens ist keiner: der Reiter war
    // schneller zu, als der Hub antworten konnte.
    if (isAbort(options.signal, error)) return;
    throw error;
  }

  if (!response.ok) throw new ApiError(response.status, await readErrorDetail(response));
  const body = response.body;
  if (!body) throw new ApiError(response.status, `Die Antwort auf „${path}“ trug keinen Rumpf.`);
  // Ab hier ist der Status vergeben. Alles Weitere steht im Strom.
  options.onOpen?.();

  await readNdjson(body, { signal: options.signal }, (record) => {
    if (record.kind === "output") {
      onOutput(typeof record.text === "string" ? record.text : "");
      return;
    }
    if (record.kind === "start") {
      options.onStart?.({
        session: typeof record.session === "string" ? record.session : "",
        containerName: typeof record.containerName === "string" ? record.containerName : ""
      });
      return;
    }
    if (record.kind === "end") {
      // ⚠️ `null` UND EINE ZAHL SIND ZWEI VERSCHIEDENE AUSKÜNFTE. Eine Zahl
      // heißt: der Prozess ist von selbst zu Ende gegangen. `null` heißt: der
      // Agent hat abgeriegelt — und WELCHES seiner beiden Zeitlimits
      // zugeschlagen hat, kann der Hub nicht wissen. Deshalb wird hier nicht
      // auf `0` oder `-1` vereinheitlicht: das erfände eine Auskunft.
      options.onEnd?.({ exitCode: typeof record.exitCode === "number" ? record.exitCode : null });
      return;
    }
    if (record.kind === "error") {
      options.onFailure?.({ reason: typeof record.reason === "string" ? record.reason : null });
    }
  });
}

/**
 * Der Rumpf, mit dem die drei kurzen Routen antworten.
 *
 * ⚠️ Er steht als eigener Typ da, damit `api-mirror.test.mjs` ihn gegen das
 * `response.status(200).json({ ok: true })` des Routers halten kann — der
 * Wächter liest den Typparameter am Aufruf.
 */
export type ExecAcknowledgement = { ok: boolean };

/**
 * Text zu base64 — über die BYTES und nicht über die Zeichen.
 *
 * ⚠️ DAS IST DIE GEFÄHRLICHSTE STELLE DES GANZEN PAKETS, und sie sieht harmlos
 * aus. Ein Terminal überträgt beliebige BYTES und keinen Text: Strg-C ist das
 * Byte 3, ein „ß" sind ZWEI Bytes (C3 9F), und eine halbe UTF-8-Folge beim
 * schnellen Tippen ist gar kein Zeichen. `btoa` allein nimmt eine
 * Zeichenkette, in der jedes Zeichen für EIN Byte steht — wer ihm den rohen
 * String von `onData` gibt, bekommt für jedes Zeichen über U+00FF eine
 * Ausnahme und für alles darunter eine falsche Kodierung.
 *
 * Und der Fehler ist STILL: der Hub antwortet `200`, der Agent nimmt die Bytes
 * an, und im Container steht Zeichensalat — bei einem `ls` fällt es nicht
 * einmal auf. Deshalb steht hier `TextEncoder` davor, und deshalb prüft
 * `web/tests/shell-view.test.tsx` das Ergebnis gegen ein LITERAL.
 *
 * ⚠️ EINE SCHLEIFE UND KEIN `String.fromCharCode(...bytes)`. Die Streuform
 * legt jedes Byte als eigenes Argument auf den Aufrufstapel; bei einer
 * eingefügten Zwischenablage von einigen zehntausend Zeichen ist das ein
 * `RangeError: Maximum call stack size exceeded` — an einer Stelle, an der
 * niemand ihn sucht.
 */
export function base64OfText(text: string): string {
  const bytes = new TextEncoder().encode(text);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

/**
 * Tastenanschläge hinaus.
 *
 * ⚠️ SIE NIMMT DEN ROHEN TEXT UND KODIERT SELBST. Ein Parameter, der schon
 * base64 verlangte, wäre die Einladung, ihn irgendwann ohne Kodierung zu
 * füllen — dieselbe Festlegung wie bei `sendInput` in
 * `server/src/features/shell/agent-client.ts`: was der Typ nicht zulässt, kann kein Aufrufer
 * vergessen.
 */
export function sendContainerExecInput(
  hostId: string,
  containerId: string,
  session: string,
  text: string
): Promise<ExecAcknowledgement> {
  // ⚠️ DER GANZE PFAD STEHT DREIMAL DA, IN EINEM STÜCK UND OHNE VERKETTUNG.
  // Zwei Gründe, beide gemessen. Erstens (#35): `api-mirror.test.mjs` liest
  // die Adresse als Zeichenkette UNMITTELBAR hinter dem Aufruf; ein
  // `base(hostId, containerId)` machte die Funktion für ihn unsichtbar, und er
  // meldete sie als ungeprüft. Zweitens, am 2026-09-08 an genau dieser Datei
  // gemessen: sein Muster nimmt die ERSTE Zeichenkette im Aufruf. Über zwei
  // Zeilen verkettet („…/containers/${…}` + `/exec/…") las er nur die erste
  // Hälfte, fand dafür keine Route und wurde ROT — mit einer Meldung, die wie
  // ein fehlender Endpunkt aussieht. Eine lange Zeile ist der Preis dafür,
  // dass dieser Wächter den Aufruf überhaupt sieht.
  return postJson<ExecAcknowledgement>(
    `/api/hosts/${encodeURIComponent(hostId)}/containers/${encodeURIComponent(containerId)}/exec/${encodeURIComponent(session)}/input`,
    { data: base64OfText(text) }
  );
}

/** Die neue Fenstergröße hinaus. */
export function sendContainerExecSize(
  hostId: string,
  containerId: string,
  session: string,
  size: { cols: number; rows: number }
): Promise<ExecAcknowledgement> {
  return postJson<ExecAcknowledgement>(
    `/api/hosts/${encodeURIComponent(hostId)}/containers/${encodeURIComponent(containerId)}/exec/${encodeURIComponent(session)}/size`,
    size
  );
}

/**
 * Die Sitzung schließen.
 *
 * ⚠️ SIE WIRD BEIM AUSHÄNGEN GERUFEN, UND ZWAR IMMER. Der Hub bindet die
 * Lebensdauer der Sitzung an `response.on("close")` seiner Stromroute, und das
 * greift beim Abbruch des `fetch` — aber darauf darf sich diese Seite nicht
 * verlassen: zwischen Browser und Hub kann ein Zwischenglied stehen, das den
 * Abriss erst spät weitergibt. Eine Sitzung, die niemand schließt, belegt
 * einen von vier Plätzen des ganzen Arms, bis der Agent nach 30 Minuten
 * abriegelt.
 *
 * ⚠️ EIN LEERES OBJEKT ALS RUMPF, obwohl die Route keinen liest. `postJson`
 * ist der Weg des Hauses und setzt `content-type: application/json`; ein
 * `POST` ganz ohne Rumpf ginge an `express.json()` vorbei, und der Unterschied
 * wäre eine zweite Bauart für nichts.
 */
export function closeContainerExec(
  hostId: string,
  containerId: string,
  session: string
): Promise<ExecAcknowledgement> {
  return postJson<ExecAcknowledgement>(
    `/api/hosts/${encodeURIComponent(hostId)}/containers/${encodeURIComponent(containerId)}/exec/${encodeURIComponent(session)}/close`,
    {}
  );
}
