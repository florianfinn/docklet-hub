import type { Messages } from "use-intl";

import { WEBFTP_ENTRY_KINDS, type WebftpEntryKind } from "contract";
import { entryChangedAt, type WebftpEntry } from "./api";
import type { Language } from "../../platform/i18n";

// Wie ein Eintrag der Dateiliste lesbar wird — Art, Größe, Änderungszeit.
//
// Keine Komponente, sondern reine Rechnung: die Hooks der Bibliothek stehen
// nicht hier, `t` und die Sprache kommen von den Aufrufern herein (dieselbe
// Bauart wie `features/hosts/host-errors.ts`). So lässt sich jede dieser
// Umrechnungen ohne DOM prüfen.

/**
 * Die vier gemessenen Arten der Gegenseite, jede auf einen eigenen Text.
 *
 * ⚠️ THE VALUES COME FROM THE CONTRACT AND DO NOT STAND HERE AS LITERALS. They
 * are the agent's values (`WEBFTP_ENTRY_KINDS` in `contract`, English since
 * #278) and are mirrored, not translated. Written out as four strings they
 * would be a second truth.
 *
 * ⚠️ DER TYP IST DER WÄCHTER. `Record<WebftpEntryKind, …>` macht eine fünfte
 * Art der Gegenseite zu einem Übersetzungsfehler statt zu einer leeren Zelle
 * — solange die Vertragsdatei sie kennt. Kennt sie sie nicht, greift der
 * Rückfall in `entryKindLabel`.
 *
 * ⚠️ DIE SCHLÜSSEL STEHEN IN ANFÜHRUNGSZEICHEN, und das ist kein Umweg um die
 * Regel `local/english-identifiers`, sondern ihre richtige Anwendung: ein
 * unquotierter Schlüssel wäre ein BEZEICHNER dieses Repos und müsste englisch
 * sein. Diese vier sind aber DATEN der Gegenseite — Werte, die der Agent
 * schickt — und Daten werden nicht übersetzt. Als Zeichenkette steht genau
 * das da.
 */
const KIND_LABEL: Record<WebftpEntryKind, keyof Messages> = {
  "file": "fileKindFile",
  "directory": "fileKindDirectory",
  "symlink": "fileKindSymlink",
  "other": "fileKindOther"
};

/** Ob dieser Wert eine der vier bekannten Arten ist. */
function isKnownKind(kind: string): kind is WebftpEntryKind {
  return (WEBFTP_ENTRY_KINDS as readonly string[]).includes(kind);
}

/**
 * Ob dieser Eintrag ein Verzeichnis ist — die einzige Art, in die man hineingeht.
 *
 * ⚠️ EIN `symlink` IST KEIN VERZEICHNIS, auch wenn er auf eines zeigt. Der
 * Agent löst Symlinks ausdrücklich NICHT auf; die Fläche weiß also gar nicht,
 * was am anderen Ende liegt, und ein Verweis, der als Verzeichnis dasteht,
 * verspricht ein Hineingehen, das der Agent verweigert. Genauso wenig ist er
 * eine Datei: ein Download davon wäre der Inhalt, den es hier nicht gibt.
 */
export function isDirectory(entry: WebftpEntry): boolean {
  return entry.kind === "directory";
}

/** Ob dieser Eintrag heruntergeladen werden kann — nur eine echte Datei. */
export function isDownloadable(entry: WebftpEntry): boolean {
  return entry.kind === "file";
}

/**
 * Der Textschlüssel für die Art, oder `null` für eine unbekannte.
 *
 * `null` heißt: der Aufrufer zeigt den Wert des Agenten ROH. Dieselbe
 * Entscheidung wie beim Statustext von Docker in der Container-Übersicht — ein
 * unbekannter Wert der Gegenseite ist kein Text dieser Oberfläche, und ein
 * Rückfall auf „Anderes" wäre eine Behauptung über etwas, das wir nicht kennen.
 */
export function entryKindLabel(entry: WebftpEntry): keyof Messages | null {
  return isKnownKind(entry.kind) ? KIND_LABEL[entry.kind] : null;
}

/**
 * Die Änderungszeit eines Eintrags als lesbare Zeit.
 *
 * ⚠️ DIE UMRECHNUNG VON SEKUNDEN AUF MILLISEKUNDEN STEHT NICHT HIER, sondern in
 * `entryChangedAt` (`web/src/features/files/api.ts`) — an genau einer Stelle im ganzen
 * Web. `changedAt` kommt in SEKUNDEN, und `new Date(<Sekunden>)` wirft nicht,
 * sondern liefert einen Zeitpunkt kurz nach 1970.
 *
 * Absolut und nicht relativ, wie `formatSignInTime`: eine Angabe „vor 6
 * Stunden" ist eine Minute später falsch, ohne dass sich etwas bewegt hätte.
 * Die Sprache kommt aus dem Konto und nicht aus `navigator.language` — sonst
 * stünde das Datum in einer anderen Ordnung als die Oberfläche daneben.
 */
export function formatEntryTime(entry: WebftpEntry, language: Language): string {
  const date = entryChangedAt(entry);
  // Ein unbrauchbarer Wert wird nicht verschluckt: `Intl.DateTimeFormat.format`
  // wirft bei `Invalid Date` einen RangeError, und der risse die Fläche mit.
  if (Number.isNaN(date.getTime())) return String(entry.changedAt);
  return new Intl.DateTimeFormat(language, { dateStyle: "medium", timeStyle: "short" }).format(date);
}
