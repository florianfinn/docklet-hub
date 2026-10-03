// Die Adresse der Detailseite EINES Containers — samt Reiter (#5, Etappe H3).
//
// ⚠️ DIE ADRESSE HÄNGT AM NAMEN UND NICHT AN DER KENNUNG, und das ist die
// wichtigste Entscheidung dieser Datei. Eine Container-Kennung ist die des
// Docker-Objekts; sie wechselt bei jedem Neuerstellen, also bei jedem
// `compose up` mit geänderter Vorlage und bei jedem `docker run` nach einem
// Abbild-Wechsel. Ein Lesezeichen auf eine Kennung wäre danach tot, obwohl der
// Container unter demselben Namen weiterläuft. Der NAME überlebt — Docker
// vergibt ihn nur einmal je Arm, und Compose baut ihn aus Projekt, Dienst und
// Nummer immer gleich zusammen.
//
// ⚠️ Die ANFRAGE hängt trotzdem an der Kennung: der Agent führt seine Allowlist
// über Kennungen (`server/src/domain/containers/containers.ts`), ein Name träfe sie nicht.
// Die Seite löst den Namen deshalb über `fetchOverview()` in die Kennung auf
// und reicht die an `LogView` weiter. Zwei Schlüssel für zwei Fragen, und die
// Auflösung dazwischen steht an genau einer Stelle.
//
// ⚠️ Ein Container-Name darf alles enthalten, was Docker erlaubt, und geht
// deshalb KODIERT in die Adresse — dieselbe Überlegung wie beim Compose-Projekt
// in `web/src/platform/routes/stack-path.ts`: ohne `encodeURIComponent` machte
// ein „/" aus einem Namen zwei Pfadabschnitte und die Route träfe nicht mehr;
// ein „#" schnitte den Rest der Adresse ab.
//
// ⚠️ Dekodiert wird hier NICHT, und das ist gemessen und kein Vertrauen:
// react-router 8.3.1 dekodiert die Parameter selbst (`decodePath`, die
// Fundstelle steht in stack-path.ts). Ein zweites `decodeURIComponent` in der
// Fläche machte aus einem Namen „a%2Fb" ein „a/b" — also lautlos einen
// ANDEREN Container, und zwar einen, den es womöglich gibt.

/**
 * Der Reiter, den die Adresse trägt.
 *
 * ⚠️ Der Reiter steht IN DER ADRESSE und nicht in einem Zustand der Seite
 * (Entscheidung des Betreibers vom 2026-09-07). Ein Lesezeichen und ein
 * Neuladen landen damit wieder dort, wo der Mensch war — bei einer Fehlersuche
 * ist genau das der Normalfall: man lädt neu, weil man dem Bild nicht traut,
 * und will danach wieder auf das Protokoll schauen und nicht auf die Stammdaten.
 *
 * ⚠️ „shell" ist seit Paket B6, Etappe E6 dabei (#5) und steht HINTER „files".
 * Die Reihenfolge ist die der Häufigkeit, mit der jemand hinschaut, und sie
 * steigt zugleich mit der Schwere des Zugriffs: sehen, lesen, an die Dateien,
 * und ganz zuletzt eine Shell — der schreibendste Zugriff, den dieser Hub
 * kennt.
 *
 * ⚠️ „files" ist seit Paket B5, Etappe E5a dabei (#5). Der Reiter trägt NUR den
 * Ort — der Pfad INNERHALB der gewählten Freigabe steht im Abfrageteil
 * (`?path=…`, siehe `files/file-paths.ts`) und nicht in einem weiteren Segment:
 * ein Pfad in der Freigabe enthält selbst Schrägstriche, und als Segment wäre
 * die Adresse des Reiters ein Präfix der Adresse eines Unterverzeichnisses —
 * `aria-current="page"` müsste dann anders bestimmt werden als bei den anderen
 * Reitern.
 */
export type ContainerTab = "overview" | "logs" | "files" | "shell";

/**
 * Die Adresse dieses Containers, wahlweise mit Reiter.
 *
 * ⚠️ EINE Funktion mit Reiter-Angabe und nicht zwei Funktionen, und der Grund
 * steht an der Reiterleiste: die zeichnet ihre Einträge aus einer Liste von
 * `ContainerTab` und braucht dafür einen Bauer, den sie mit dem Reiter als WERT
 * aufrufen kann. Zwei Funktionen zwängen sie in eine Verzweigung je Eintrag —
 * und ein dritter Reiter (Compose, Umgebung, Verlauf stehen im Artboard) wäre
 * dann eine dritte Funktion UND ein dritter Zweig. Dazu kommt: die Kodierung
 * stünde zweimal da, und die zweite Stelle ist die, die beim nächsten Umbau
 * vergessen wird.
 *
 * Der Vorgabewert ist „overview": wer einen Container öffnet, will ihn sehen
 * und nicht sein Protokoll. Damit bleibt der Aufruf aus der Container-Zeile
 * zweistellig und nennt keinen Reiter, den er gar nicht meint.
 */
export function containerPath(hostId: string, name: string, tab: ContainerTab = "overview"): string {
  const base = `/container/${encodeURIComponent(hostId)}/${encodeURIComponent(name)}`;
  return tab === "overview" ? base : `${base}/${tab}`;
}
