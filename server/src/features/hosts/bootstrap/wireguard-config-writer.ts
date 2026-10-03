// Der atomare Schreiber für die wg0.conf im geteilten Volume.
//
// Warum das nicht `writeFile` ist: auf der anderen Seite desselben Volumes
// sitzt ein Sidecar, der die Datei nachlädt, sobald sie sich ändert. Ein
// `writeFile` kürzt die Datei zuerst auf null und füllt sie dann — und genau
// in diesem Fenster kann der Sidecar sie lesen. Was er dann sieht, ist eine
// gültige Datei mit weniger Peers, und `wg syncconf` nimmt jeden Arm aus dem
// Tunnel, der darin fehlt. Niemand hat diese Arme angefasst, in keinem Log
// steht ein Fehler, und wieder da sind sie erst beim nächsten Schreiben.
//
// Deshalb: vollständig in eine Nebendatei schreiben, auf die Platte zwingen,
// dann an Ort und Stelle umbenennen. `rename` innerhalb desselben
// Dateisystems ist unteilbar — ein Leser sieht entweder die alte Datei oder
// die neue, nie etwas dazwischen.

import { open, rename, unlink } from "node:fs/promises";
import { dirname, resolve } from "node:path";

// Nur der Hub liest diese Datei je zurück, und der Sidecar liest sie als root.
// 0600 ist trotzdem richtig: in ihr steht der private Schlüssel der Hub-Seite
// des Tunnels — wer ihn hat, ist der Hub.
const FILE_MODE = 0o600;

// Schreibvorgänge auf dieselbe Datei werden IN DIESEM PROZESS gereiht.
//
// ⚠️ Ohne diese Reihung ist die Nebendatei die Schwachstelle, die der
// `rename` gerade beseitigen sollte: zwei gleichzeitige Aufrufe öffnen
// dieselbe `<pfad>.tmp`, kürzen sie beide auf null und schreiben ineinander.
// Umbenannt wird danach ein Mischmasch aus zwei Ständen — und der ist unter
// Umständen syntaktisch gültig.
//
// Was diese Reihung NICHT abdeckt: zwei Hub-PROZESSE auf demselben Volume.
// Der Stack fährt genau einen Hub; eine zweite Instanz bräuchte eine Sperre
// im Dateisystem. Wer den Hub je waagerecht skaliert, fängt hier an.
const pending = new Map<string, Promise<void>>();

async function writeAndReplace(target: string, temporary: string, content: string): Promise<void> {
  const handle = await open(temporary, "w", FILE_MODE);
  try {
    await handle.writeFile(content, "utf8");
    // `chmod` zusätzlich zum Modus beim Öffnen: die `umask` des Prozesses
    // kürzt den Modus beim Anlegen, und eine bestehende Nebendatei aus einem
    // abgebrochenen Lauf behält ohnehin ihren alten Modus.
    await handle.chmod(FILE_MODE);
    // Ohne `fsync` liegt der Inhalt im Seitencache. Ein Stromausfall nach dem
    // `rename` hinterließe dann einen Verzeichniseintrag mit dem neuen Namen
    // und einer leeren Datei — der Tunnel wäre nach dem Neustart leer.
    await handle.sync();
  } catch (error) {
    await handle.close();
    await unlink(temporary).catch(() => undefined);
    throw error;
  }
  await handle.close();
  await rename(temporary, target);

  // Auch das Verzeichnis fsyncen, sonst ist der `rename` selbst nicht
  // dauerhaft. Best effort: Windows lässt ein Verzeichnis nicht zum Lesen
  // öffnen, und dort ist die Zusage ohnehin eine andere. Ein Scheitern hier
  // darf den Schreibvorgang nicht scheitern lassen — die Datei steht bereits.
  try {
    const directory = await open(dirname(target), "r");
    try {
      await directory.sync();
    } finally {
      await directory.close();
    }
  } catch {
    // Absichtlich still: siehe oben.
  }
}

/**
 * Schreibt `content` unteilbar nach `path`.
 *
 * Idempotent: derselbe Inhalt zweimal geschrieben ergibt dieselbe Datei. Der
 * Aufruf ist wiederholbar — bricht er ab, bleibt die vorherige Fassung
 * unversehrt stehen, und eine liegengebliebene `<pfad>.tmp` wird beim nächsten
 * Lauf überschrieben. Der Sidecar liest sie nie; er kennt nur `wg0.conf`.
 */
export async function writeWireGuardConfig(path: string, content: string): Promise<void> {
  const target = resolve(path);
  const temporary = `${target}.tmp`;

  const previous = pending.get(target) ?? Promise.resolve();
  // `catch` auf der Vorgängerin: ein gescheiterter Schreibvorgang darf den
  // nächsten nicht mitreißen. Sein Fehler ist bei seinem eigenen Aufrufer
  // bereits angekommen.
  const next = previous.catch(() => undefined).then(() => writeAndReplace(target, temporary, content));
  pending.set(target, next);

  try {
    await next;
  } finally {
    // Nur aufräumen, wenn seitdem niemand angehängt hat — sonst risse dieser
    // Eintrag die Reihung der noch laufenden Aufrufe auf.
    if (pending.get(target) === next) pending.delete(target);
  }
}
