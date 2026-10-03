// Ein Befehl, den der Betreiber auf einem ANDEREN Rechner eintippt.
//
// ⚠️ Warum das eine eigene Fläche ist und kein `<code>` im Fließtext. Bis
// hierher standen die Befehle in den Hinweisen unter den Feldern so:
//
//     … Abzulesen dort mit: stat -c %g /var/run/docker.sock
//
// Gemessen am 2026-09-06 am Anlege-Dialog: der Befehl unterschied sich vom
// Satz davor nur durch die Schriftart, brach mitten im Wort um und ging in
// der Zeile unter. Der Betreiber muss ihn aber nicht LESEN, sondern
// abschreiben oder kopieren — und zwar Zeichen für Zeichen, auf einem Rechner,
// auf dem dieser Hub nicht läuft. Ein Zeichen daneben, und die Antwort ist
// entweder ein Fehler oder, schlimmer, eine falsche Zahl.
//
// Deshalb: eigene Zeile, eigene Fläche, eigener Rahmen — und `select-all`,
// damit ein Klick den ganzen Befehl markiert statt eines Wortes daraus.
//
// ⚠️ `overflow-x-auto` und `max-w-full` sind kein Beiwerk. Ohne sie schiebt
// ein langer Befehl den Dialog auf, statt in seiner eigenen Zeile zu rollen —
// auf einem schmalen Fenster reißt damit die ganze Maske aus.
export function CommandLine({ children }: { children: string }) {
  return (
    <code className="mt-1.5 block max-w-full select-all overflow-x-auto rounded-md border border-border bg-muted px-2 py-1.5 font-mono text-[12px] whitespace-pre text-foreground">
      {children}
    </code>
  );
}
