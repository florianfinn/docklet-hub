// The two header decisions of a file download (#262), moved out of the file
// route unchanged: the name the browser saves under, and how it is written.

/** Der letzte Abschnitt eines Pfades — der Dateiname für die Kopfzeile. */
export function baseName(path: string): string {
  const parts = path.split("/").filter((part) => part !== "");
  return parts[parts.length - 1] ?? "download";
}

/**
 * Ein Dateiname für `content-disposition` — und nichts, was dort eine eigene
 * Anweisung beginnen könnte.
 *
 * ⚠️ DIESER NAME KOMMT AUS DEM DATEISYSTEM EINES FREMDEN HOSTS und ist damit
 * die unsicherste Zeichenkette dieser Fläche. Ein Anführungszeichen darin
 * zerlegte den `filename`-Parameter, ein Zeilenumbruch begänne eine eigene
 * Kopfzeile (Node wirft dann, und aus dem Download würde eine 500). Deshalb
 * derselbe Aufbau wie bei `contentDisposition` in `features/hosts/host-errors.ts`: ein
 * ASCII-Kern aus wenigen Zeichen, und der vollständige Name kodiert als
 * `filename*` nach RFC 5987.
 */
export function fileDisposition(name: string): string {
  const ascii = name.replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "") || "download";
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(name)}`;
}
