import net from "node:net";
import type { Server } from "node:net";
import type { AddressInfo } from "node:net";

// Ein freier Port für einen Zuhörer im Prüfstand — einer, den `fetch` auch
// anspricht.
//
// ⚠️ `listen(0)` KANN EINEN PORT LIEFERN, DEN `fetch` VERWEIGERT. Das
// eingebaute `fetch` (undici) sperrt nach der Fetch-Spezifikation eine feste
// Liste von Ports („port blocking") und wirft dort `TypeError: fetch failed`
// mit der Ursache `bad port`, ohne eine Verbindung zu versuchen. `node:http`
// kennt diese Sperre nicht. Der dynamische Portbereich unter Windows beginnt
// auf diesem Rechner bei 1024 (`netsh int ipv4 show dynamicport tcp`,
// gemessen am 2026-09-30; die Windows-Vorgabe wäre 49152) — damit liegen alle
// 19 gesperrten Ports über 1024 im Bereich, aus dem `listen(0)` zieht.
//
// Gemessen am 2026-09-30 in 24 `pnpm run test` im Server-Workspace, je drei
// parallel: zwei Läufe rot mit vier Fällen — drei mit `bad port` in der
// Ursache, der vierte `502 !== 404` mit `fetch failed` am ersten Aufruf des
// Hubs (`openContainer`). Danach mit diesem Helfer 30 von 30 grün, kein
// `bad port`. Traf es einen nachgestellten
// Arm, ging schon der erste Aufruf des Hubs an ihn mit `bad port` fehl, der
// `AgentError` trug keinen Status und die Route antwortete `502
// agent-unreachable` — so in `compose-routes.test.ts` (`502 !== 403`) und im
// Prüfstand der Shell („die Shell ging nicht auf", `502 !== 200`). Traf es
// den Hub selbst, warf das `fetch` des Tests. Gegenprobe: derselbe Fall aus
// `compose-routes.test.ts` mit dem Arm fest auf Port 6000 endet jedes Mal mit
// `502 !== 403`.
//
// ⚠️ DER HUB SELBST IST DAVON NICHT BETROFFEN, solange ein Arm nicht auf
// einem dieser Ports lauscht: er spricht einen eingetragenen Port an und
// keinen zufälligen.

/**
 * Die Ports ab 1024, die das `fetch` von Node verweigert.
 *
 * Nicht aus der Spezifikation abgeschrieben, sondern am laufenden Node
 * ermittelt: ein `fetch` gegen jeden Port von 1024 bis 65535, gezählt, wo die
 * Ursache `bad port` hieß — gemessen am 2026-09-30 unter Node v24.18.0, genau
 * diese 19, und sie decken sich mit der Liste der Fetch-Spezifikation
 * (https://fetch.spec.whatwg.org/#port-blocking). Unter 1024 vergibt
 * `listen(0)` nichts.
 *
 * ⚠️ NUR EINE RICHTUNG IST DAUERHAFT GEPRÜFT. Dass jeder Port hier gesperrt
 * ist, prüft `port-test-support.test.ts` bei jedem Lauf. Dass Node keinen
 * weiteren sperrt, prüft keiner: der Scan über alle Ports dauert 28 s. Kommt
 * einer hinzu, wird dieser Wackler wieder sichtbar — mit `bad port` in der
 * Ursache.
 */
export const FETCH_BLOCKED_PORTS: ReadonlySet<number> = new Set([
  1719, 1720, 1723, 2049, 3659, 4045, 4190, 5060, 5061, 6000, 6566, 6665, 6666, 6667, 6668, 6669, 6679, 6697, 10080
]);

/**
 * Lauscht auf einem freien Port, den `fetch` anspricht, und gibt ihn zurück.
 *
 * Zieht `listen(0)` einen gesperrten Port, schließt der Zuhörer und zieht neu.
 * `host` ist `127.0.0.1` und nicht der Vorgabewert von `listen`: diese
 * Umgebung hat kein IPv6. Der Satz stand bis hierher an jeder der 26 Stellen,
 * die jetzt diesen Helfer rufen.
 * `isBlocked` ist nur für den eigenen Test offen: dort erzwingt er den zweiten
 * Zug, den `listen(0)` von sich aus fast nie liefert.
 */
export async function listenOnFetchablePort(
  server: Server,
  host = "127.0.0.1",
  isBlocked: (port: number) => boolean = (port) => FETCH_BLOCKED_PORTS.has(port)
): Promise<number> {
  for (;;) {
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, host, () => {
        server.off("error", reject);
        resolve();
      });
    });
    const port = (server.address() as AddressInfo).port;
    if (!isBlocked(port)) return port;
    await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  }
}

/**
 * Why IPv6 loopback is unusable here, or `false` when it works.
 *
 * Meant as the `skip` option of a test that has to bind `::` or reach `::1`.
 * Cloud containers ship without IPv6, and binding there fails with
 * `EAFNOSUPPORT` (or `EADDRNOTAVAIL` when the family exists but `::1` is not
 * configured) — tracked in #286. Only those two codes count as "no IPv6"; any
 * other bind error is thrown, so a broken machine still fails loudly instead
 * of skipping. The reason string lands in the test output as `# SKIP`, so a
 * run without IPv6 says what it left out.
 */
export async function ipv6LoopbackUnavailable(): Promise<string | false> {
  const probe = net.createServer();
  try {
    await new Promise<void>((resolve, reject) => {
      probe.once("error", reject);
      probe.listen(0, "::1", () => {
        probe.off("error", reject);
        resolve();
      });
    });
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "EAFNOSUPPORT" || code === "EADDRNOTAVAIL") {
      return `no IPv6 loopback on this machine (${code} binding ::1); see #286`;
    }
    throw error;
  }
  await new Promise<void>((resolve, reject) => probe.close((error) => (error ? reject(error) : resolve())));
  return false;
}
