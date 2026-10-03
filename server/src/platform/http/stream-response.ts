// Die Mechanik einer durchgereichten NDJSON-Antwort — eine Fassung für alle.
//
// ⚠️ WARUM ES DIESE DATEI GIBT. Bis zum Compose-Strom (#35) stand sie nur in
// `routes/container-routes.ts`, für den Log-Strom. Der Anwende-Strom braucht
// dieselbe Mechanik, und was hier steht, ist nicht Verwaltung, sondern eine
// Reihe von Entscheidungen, die man in einer zweiten Abschrift nicht
// wiedererkennt: welche Kopfzeilen ein Strom durch einen Proxy bringen, wann
// der Status vergeben ist, und dass ein Strom ohne einen einzigen Umschlag
// trotzdem seine Kopfzeilen bekommt.
//
// Vor allem aber: ab welchem Zeitpunkt ein Fehler KEIN Statuscode mehr sein
// darf. Wer das in einer Kopie um eine Zeile verschiebt, schickt einem
// Browser, der schon `200` und die halbe Antwort hat, hinterher eine `500` —
// und die kommt nie an.

import type { Response } from "express";

const STREAM_HEADERS: Record<string, string> = {
  "content-type": "application/x-ndjson; charset=utf-8",
  // Ein Strom in einem Zwischenspeicher ist keiner mehr; `no-transform` hält
  // zusätzlich einen Proxy davon ab, ihn unterwegs umzupacken.
  "cache-control": "no-store, no-transform",
  // Für nginx: ohne diesen Kopf puffert er die Antwort und liefert sie am
  // Stück aus — die Zeilen wären dann alle gleichzeitig da.
  "x-accel-buffering": "no"
};

/**
 * Der Zustand „der Ausgabepuffer nimmt noch" — eine einzige Zusage für alle
 * Zeilen, die durchgehen. Ein neues `Promise.resolve()` je Zeile legte bei
 * einem gesprächigen Container ein Objekt je Logzeile an.
 */
const WRITABLE: Promise<void> = Promise.resolve();

/**
 * Der Schreiber einer NDJSON-Antwort.
 *
 * `begin` ist IDEMPOTENT und darf jederzeit gerufen werden; `started` sagt, ob
 * der Status schon vergeben ist.
 */
export type NdjsonWriter = {
  begin: () => void;
  /**
   * Schreibt eine Zeile. Der Rückgabewert IST der Gegendruck: er steht schon
   * fest, solange der Ausgabepuffer nimmt, und löst sich sonst erst mit dem
   * `drain` der Antwort.
   *
   * ⚠️ WER IHN NICHT ABWARTET, VERLIERT NICHTS AUSSER DEM BREMSEN. Die Zeile
   * ist auch dann in der richtigen Reihenfolge draußen — `response.write`
   * reiht sie ein, ob der Puffer voll ist oder nicht. Abgewartet wird deshalb
   * dort, wo viele Zeilen hintereinander kommen (Logzeile, Shell-Ausgabe,
   * Anwende-Schritt), und nicht bei der einen Abschlusszeile vor `end()`.
   */
  write: (event: unknown) => Promise<void>;
  /** Ob schon Kopfzeilen hinaus sind — daran hängt die Fehlerbehandlung. */
  readonly started: () => boolean;
  /** Das Ende. Setzt notfalls noch die Kopfzeilen. */
  end: () => void;
};

/**
 * Warten, bis der Ausgabepuffer wieder nimmt.
 *
 * ⚠️ `close` ZÄHLT WIE `drain`, und das ist der Teil, den man vergisst. Eine
 * abgerissene Verbindung sendet kein `drain` mehr; wer nur darauf hört,
 * lässt den Aufrufer für immer stehen — mitsamt dem Strom zum Arm, der dann
 * einen der Plätze hält, bis der Arm es selbst merkt. Nach `close`
 * läuft der Aufrufer weiter und findet den geschlossenen Strom auf seinem
 * eigenen Weg (`response.writableEnded`, sein Abbruchsignal).
 *
 * Shared by the NDJSON writer below and by the byte relay of the files
 * (`platform/streams/agent-bytes-relay.ts`, #262): one decision about
 * back-pressure, written once.
 */
export function waitUntilWritable(response: Response): Promise<void> {
  return new Promise<void>((resolve) => {
    if (response.destroyed) {
      resolve();
      return;
    }
    const proceed = (): void => {
      response.off("drain", proceed);
      response.off("close", proceed);
      resolve();
    };
    response.once("drain", proceed);
    response.once("close", proceed);
  });
}

export function ndjsonWriter(response: Response): NdjsonWriter {
  let started = false;
  const begin = (): void => {
    if (started) return;
    response.status(200);
    for (const [name, value] of Object.entries(STREAM_HEADERS)) response.setHeader(name, value);
    response.flushHeaders();
    started = true;
  };

  return {
    begin,
    write: (event: unknown): Promise<void> => {
      begin();
      // ⚠️ DER RÜCKGABEWERT VON `response.write` IST DIE GANZE SACHE. Er ist
      // `false`, sobald der Ausgabepuffer voll ist. Wer ihn übergeht, liest
      // den Arm so schnell wie möglich und stapelt die Zeilen im Speicher des
      // Hubs — also genau das, was eine Durchreichung vermeiden soll, nur
      // unsichtbar. Dieselbe Entscheidung wie in `relayAgentBytes`
      // (`platform/streams/agent-bytes-relay.ts`), dort für die rohen Blöcke einer Datei.
      if (response.write(`${JSON.stringify(event)}\n`)) return WRITABLE;
      return waitUntilWritable(response);
    },
    started: () => started,
    /**
     * ⚠️ Auch der Fall „der Strom endete, bevor irgendetwas kam" bekommt hier
     * seine Kopfzeilen. Ohne das antwortete der Hub mit einem leeren `200` ohne
     * `content-type`, und ein Aufrufer, der NDJSON erwartet, stünde vor etwas,
     * das er nicht einordnen kann.
     */
    end: (): void => {
      if (response.writableEnded) return;
      begin();
      response.end();
    }
  };
}
