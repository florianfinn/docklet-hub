import assert from "node:assert/strict";
import http from "node:http";
import type { AddressInfo } from "node:net";
import test from "node:test";
import { MAX_STREAM_BACKLOG_BYTES, sendLine } from "./ndjson-line.js";

// Wächter über den Rückstau einer NDJSON-Antwort.
//
// Der Fall, um den es geht, steht im Kopf von ndjson-line.ts: ein Ausschnitt
// der Vergangenheit kommt in EINEM Schwall, und bis v0.29.0 zerstörte schon
// die High-Water-Mark von Node (16 KiB) die Antwort. Geprüft wird an einem
// echten Server und einem echten Socket — ein nachgebautes `write` bewiese
// nichts über den Puffer, auf den es ankommt.

type Served = { url: string; close: () => Promise<void> };

async function serve(handler: (response: http.ServerResponse) => void): Promise<Served> {
  const server = http.createServer((_request, response) => {
    response.writeHead(200, { "content-type": "application/x-ndjson; charset=utf-8" });
    handler(response);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}/`,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      })
  };
}

/** Eine Zeile, so lang wie eine Fehlerzeile von AdGuard Home im gemessenen Fall. */
const LONG_TEXT = "x".repeat(480);

test("ein Schwall von 2000 langen Zeilen kommt vollständig an", async () => {
  let refused = 0;
  const served = await serve((response) => {
    // Synchron und am Stück — genau wie die Engine einen Ausschnitt liefert.
    for (let index = 0; index < 2000; index += 1) {
      if (!sendLine(response, { kind: "line", index, text: LONG_TEXT })) refused += 1;
    }
    response.end();
  });
  try {
    const text = await (await fetch(served.url)).text();
    const lines = text.split("\n").filter((line) => line !== "");
    assert.equal(refused, 0, "sendLine hat eine Zeile abgewiesen");
    assert.equal(lines.length, 2000);
    assert.equal(JSON.parse(lines[1999]).index, 1999);
  } finally {
    await served.close();
  }
});

test("der Schwall liegt über der High-Water-Mark — sonst prüfte der Fall oben nichts", () => {
  const bytes = 2000 * JSON.stringify({ kind: "line", index: 1999, text: LONG_TEXT }).length;
  assert.ok(bytes > 16 * 1024 * 10, `nur ${bytes} Bytes`);
  assert.ok(bytes < MAX_STREAM_BACKLOG_BYTES, `${bytes} Bytes reißen den Deckel selbst`);
});

test("ein Rückstau über dem Deckel zerstört die Antwort und meldet false", async () => {
  let result: { refusedAt: number; destroyed: boolean } | null = null;
  const served = await serve((response) => {
    // Kleiner Deckel, damit der Fall nicht Megabytes schreiben muss. Der Leser
    // liest gar nicht: der Rumpf unten wird nie angefasst.
    for (let index = 0; index < 1000; index += 1) {
      if (!sendLine(response, { kind: "line", index, text: LONG_TEXT }, 64 * 1024)) {
        result = { refusedAt: index, destroyed: response.destroyed };
        return;
      }
    }
    result = { refusedAt: -1, destroyed: response.destroyed };
  });
  try {
    // Der Leser bekommt je nach Zeitpunkt einen Abbruch oder gar keine
    // Kopfzeilen — beides ist hier richtig. Gewartet wird auf das Ende des
    // Sockets, nicht auf eine Antwort.
    await new Promise<void>((resolve) => {
      const request = http.get(served.url, (response) => response.on("close", () => resolve()));
      request.on("error", () => resolve());
    });
    assert.ok(result !== null, "der Handler lief nicht");
    const { refusedAt, destroyed } = result as { refusedAt: number; destroyed: boolean };
    assert.ok(refusedAt > 0, "der Deckel griff nie");
    assert.equal(destroyed, true);
  } finally {
    await served.close();
  }
});

test("eine geschlossene Antwort nimmt keine Zeile mehr", async () => {
  let after: boolean | null = null;
  const served = await serve((response) => {
    response.end();
    after = sendLine(response, { kind: "line" });
  });
  try {
    await (await fetch(served.url)).text();
    assert.equal(after, false);
  } finally {
    await served.close();
  }
});
