import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { writeWireGuardConfig } from "./wireguard-config-writer.js";

// Der Dateimodus ist eine POSIX-Eigenschaft. NTFS kennt keine Rechtebits in
// dieser Form; Node meldet dort 0666 bzw. 0444, egal was übergeben wurde. Der
// Fall wird deshalb auf Windows übersprungen statt auf einen Wert
// heruntergesetzt, der nichts mehr aussagt — die Zusage gilt im Container, und
// der ist Linux.
const POSIX_ONLY =
  process.platform === "win32" ? "Dateimodus ist eine POSIX-Eigenschaft; NTFS meldet 0666 statt 0600" : false;

async function withDirectory(body: (directory: string) => Promise<void>): Promise<void> {
  const directory = await mkdtemp(join(tmpdir(), "wg-config-"));
  try {
    await body(directory);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

test("der Inhalt steht danach vollständig in der Datei", async () => {
  await withDirectory(async (directory) => {
    const path = join(directory, "wg0.conf");
    await writeWireGuardConfig(path, "[Interface]\nListenPort = 51821\n");
    assert.equal(await readFile(path, "utf8"), "[Interface]\nListenPort = 51821\n");
  });
});

test("die Nebendatei bleibt nicht liegen", { concurrency: false }, async () => {
  // Eine `.tmp`-Leiche im geteilten Volume ist mehr als Unordnung: sie enthält
  // den privaten Schlüssel des Hubs und wird von keinem Aufräumer je angefasst.
  await withDirectory(async (directory) => {
    const path = join(directory, "wg0.conf");
    await writeWireGuardConfig(path, "erster Stand\n");
    assert.deepEqual((await readdir(directory)).sort(), ["wg0.conf"]);
  });
});

test("der Dateimodus ist 0600", { skip: POSIX_ONLY }, async () => {
  // In der Datei steht der private Schlüssel der Hub-Seite des Tunnels.
  await withDirectory(async (directory) => {
    const path = join(directory, "wg0.conf");
    await writeWireGuardConfig(path, "geheim\n");
    assert.equal((await stat(path)).mode & 0o777, 0o600);
  });
});

test("ein zweiter Lauf ersetzt den Stand vollständig", async () => {
  // Kein Anhängen, kein Rest der längeren Vorgängerin: die Datei ist nach dem
  // Schreiben genau der neue Stand.
  await withDirectory(async (directory) => {
    const path = join(directory, "wg0.conf");
    await writeWireGuardConfig(path, "eine sehr viel laengere erste Fassung\n");
    await writeWireGuardConfig(path, "kurz\n");
    assert.equal(await readFile(path, "utf8"), "kurz\n");
  });
});

test("derselbe Inhalt zweimal geschrieben ergibt dieselbe Datei", async () => {
  await withDirectory(async (directory) => {
    const path = join(directory, "wg0.conf");
    await writeWireGuardConfig(path, "gleich\n");
    await writeWireGuardConfig(path, "gleich\n");
    assert.equal(await readFile(path, "utf8"), "gleich\n");
    assert.deepEqual((await readdir(directory)).sort(), ["wg0.conf"]);
  });
});

test("eine liegengebliebene Nebendatei blockiert den nächsten Lauf nicht", async () => {
  // Nach einem harten Abbruch zwischen Schreiben und Umbenennen liegt eine
  // `.tmp` da. Der nächste Lauf muss sie überschreiben und nicht an ihr
  // scheitern — sonst wäre der Hub nach einem einzigen Abbruch dauerhaft
  // unfähig, die Peer-Liste zu ändern.
  await withDirectory(async (directory) => {
    const path = join(directory, "wg0.conf");
    await writeFile(`${path}.tmp`, "Rest eines abgebrochenen Laufs\n");
    await writeWireGuardConfig(path, "neu\n");
    assert.equal(await readFile(path, "utf8"), "neu\n");
    assert.deepEqual((await readdir(directory)).sort(), ["wg0.conf"]);
  });
});

test("die alte Fassung bleibt stehen, wenn das Schreiben scheitert", async () => {
  // Der Pfad zeigt in ein Verzeichnis, das es nicht gibt. Was zählt, ist nicht
  // die Fehlermeldung, sondern dass die vorherige Datei unversehrt ist: der
  // Tunnel läuft mit dem alten Stand weiter, statt leer dazustehen.
  await withDirectory(async (directory) => {
    const path = join(directory, "wg0.conf");
    await writeWireGuardConfig(path, "bestand\n");
    await assert.rejects(() => writeWireGuardConfig(join(directory, "fehlt", "wg0.conf"), "egal\n"));
    assert.equal(await readFile(path, "utf8"), "bestand\n");
  });
});

test("zwei gleichzeitige Schreibvorgänge ergeben keinen Mischmasch", async () => {
  // Der stille Fall: beide öffnen dieselbe `.tmp`, kürzen sie und schreiben
  // ineinander. Umbenannt würde danach eine Datei, die aus beiden Ständen
  // besteht — unter Umständen syntaktisch gültig und damit vom Sidecar
  // klaglos übernommen.
  //
  // Zugesagt ist: die Datei ist am Ende GENAU einer der beiden Stände.
  await withDirectory(async (directory) => {
    const path = join(directory, "wg0.conf");
    const first = `${"A".repeat(200_000)}\n`;
    const second = `${"B".repeat(200_000)}\n`;
    await Promise.all([writeWireGuardConfig(path, first), writeWireGuardConfig(path, second)]);
    const written = await readFile(path, "utf8");
    assert.ok(written === first || written === second, "Die Datei ist keiner der beiden geschriebenen Stände");
    assert.deepEqual((await readdir(directory)).sort(), ["wg0.conf"]);
  });
});

test("der letzte Aufruf gewinnt", async () => {
  // Die Reihung darf die Reihenfolge nicht umdrehen: „Arm entfernt" nach „Arm
  // angelegt" muss auch am Ende „Arm entfernt" heißen.
  await withDirectory(async (directory) => {
    const path = join(directory, "wg0.conf");
    const runs = ["eins\n", "zwei\n", "drei\n"].map((content) => writeWireGuardConfig(path, content));
    await Promise.all(runs);
    assert.equal(await readFile(path, "utf8"), "drei\n");
  });
});
