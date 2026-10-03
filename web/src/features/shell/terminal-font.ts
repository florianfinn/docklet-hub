// Die Schrift des Terminals, geladen BEVOR `@xterm` misst.
//
// ⚠️ `@xterm` MISST DIE ZELLE EINMAL, BEIM ÖFFNEN, und setzt danach jedes
// Zeichen in ein Raster dieser Breite. Eine Webschrift lädt der Browser erst,
// wenn ein Knoten sie braucht; IBM Plex Mono (`@fontsource`, `platform/theme/fonts.css`)
// ist deshalb beim ersten Öffnen der Shell in aller Regel noch nicht da. Dann
// misst `@xterm` die Rückfallschrift und zeichnet in deren Raster mit Plex —
// die Zeichen stehen zu weit oder zu eng. `document.fonts.load` holt genau die
// Schnitte, die auf die Angabe passen, und löst auf, sobald sie da sind.
//
// ⚠️ EINE FRIST UND KEIN WARTEN OHNE ENDE. Eine Schrift, die nicht lädt (kein
// Netz, gesperrte Datei), darf die Shell nicht aufhalten: nach der Frist baut
// das Terminal mit dem, was da ist — ein schiefes Raster ist besser als keine
// Shell.
const FONT_WAIT_MS = 1_500;

export async function terminalFontReady(node: HTMLElement, fontSize: number): Promise<void> {
  // happy-dom und ältere Umgebungen kennen `document.fonts` nicht.
  const fonts = (node.ownerDocument as Document & { fonts?: FontFaceSet }).fonts;
  if (fonts === undefined || typeof fonts.load !== "function") return;
  const family = getComputedStyle(node).fontFamily;
  if (family === "") return;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<void>((resolve) => {
    timer = setTimeout(resolve, FONT_WAIT_MS);
  });
  try {
    await Promise.race([fonts.load(`${fontSize}px ${family}`).then(() => undefined), deadline]);
  } catch {
    // Eine Angabe, die der Browser nicht versteht, ist kein Grund, die Shell
    // nicht zu öffnen.
  } finally {
    clearTimeout(timer);
  }
}
