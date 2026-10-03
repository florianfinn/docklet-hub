// Ein ustar-Schreiber für genau den Fall, den dieses Paket hat: wenige kleine
// Textdateien, keine Verzeichnisse, keine Links, keine langen Namen.
//
// Warum selbst geschrieben und nicht `tar` als Abhängigkeit (AGENTS.md,
// „Abhängigkeiten"): das Format ist an dieser Stelle ein Kopf aus festen
// Feldern und eine Auffüllung auf 512 Bytes. Die Bibliothek brächte
// Streams, Verzeichnisbäume, Symlinks und Rechteübernahme vom Dateisystem mit
// — alles Dinge, die hier nicht vorkommen dürfen, weil das Archiv
// ausschließlich aus Zeichenketten im Speicher entsteht.

const BLOCK = 512;
const NAME_LIMIT = 100;

export type TarEntry = {
  name: string;
  content: string;
  /** Oktal, z. B. 0o600 für die beiden Dateien mit Geheimnissen. */
  mode: number;
};

function octal(value: number, width: number): Buffer {
  // ustar-Zahlenfelder: oktal, rechtsbündig mit Nullen, dann ein NUL.
  const text = value.toString(8).padStart(width - 1, "0");
  if (text.length > width - 1) throw new Error(`Wert ${value} passt nicht in ${width} Bytes`);
  return Buffer.from(`${text}\0`, "ascii");
}

function header(entry: TarEntry, size: number, modifiedAt: number): Buffer {
  const block = Buffer.alloc(BLOCK);
  const name = Buffer.from(entry.name, "utf8");
  if (name.length === 0 || name.length > NAME_LIMIT) {
    throw new Error(`Dateiname passt nicht in einen ustar-Kopf: ${entry.name}`);
  }
  name.copy(block, 0);
  octal(entry.mode & 0o7777, 8).copy(block, 100);
  octal(0, 8).copy(block, 108); // uid
  octal(0, 8).copy(block, 116); // gid
  octal(size, 12).copy(block, 124);
  octal(modifiedAt, 12).copy(block, 136);
  block.fill(0x20, 148, 156); // Prüfsumme: beim Rechnen als Leerzeichen
  block.write("0", 156, "ascii"); // typeflag: einfache Datei
  block.write("ustar\0", 257, "ascii");
  block.write("00", 263, "ascii");
  // uname/gname bleiben leer: ein Name wie „node" ist auf dem Zielhost eine
  // andere uid als hier, und tar zieht sonst beim Entpacken als root daran.

  let checksum = 0;
  for (const byte of block) checksum += byte;
  // Sechs Stellen, NUL, Leerzeichen — die Form, die GNU tar und bsdtar lesen.
  Buffer.from(`${checksum.toString(8).padStart(6, "0")}\0 `, "ascii").copy(block, 148);
  return block;
}

function padded(size: number): number {
  return Math.ceil(size / BLOCK) * BLOCK;
}

/**
 * Die Einträge als unkomprimierter ustar-Strom.
 *
 * ⚠️ Zeilenenden: der Inhalt geht so hinein, wie er kommt. Ein `\r` aus einer
 * Vorlage landete unbemerkt in `wg0.conf` und in der `.env` — `wg-quick` und
 * der `.env`-Leser von Compose stolpern darüber, und zwar erst auf dem
 * Zielhost. Deshalb wirft das hier, statt still zu reparieren: ein stiller
 * Ersatz nähme dem Aufrufer die Rückmeldung, dass seine Vorlage kaputt ist.
 */
export function writeTar(entries: readonly TarEntry[], modifiedAt: number): Buffer {
  const blocks: Buffer[] = [];
  const seen = new Set<string>();
  for (const entry of entries) {
    if (seen.has(entry.name)) throw new Error(`Doppelter Eintrag im Archiv: ${entry.name}`);
    seen.add(entry.name);
    if (entry.content.includes("\r")) {
      throw new Error(`${entry.name} enthält ein Wagenrücklaufzeichen — die Vorlage muss LF liefern`);
    }
    const content = Buffer.from(entry.content, "utf8");
    blocks.push(header(entry, content.length, modifiedAt));
    const body = Buffer.alloc(padded(content.length));
    content.copy(body);
    blocks.push(body);
  }
  // Der Abschluss sind zwei leere Blöcke. Fehlen sie, meldet GNU tar beim
  // Entpacken „unexpected end of file" — und zwar nach den Dateien, die es
  // trotzdem schon geschrieben hat.
  blocks.push(Buffer.alloc(BLOCK * 2));
  return Buffer.concat(blocks);
}
