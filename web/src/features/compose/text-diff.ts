// Der Zeilenvergleich zweier Textstände — Eigenbau, nach Myers.
//
// ⚠️ WARUM EIGENBAU UND NICHT `diff` AUS NPM. Die Entscheidung fiel im
// Vorlauf dieses Pakets und ist keine Ideologie: was hier gebraucht wird, ist
// EIN Vergleich über Zeilen. Das Paket bringt zwölf weitere mit (Zeichen,
// Wörter, JSON, CSS, Patch-Erzeugung, Patch-Anwendung), von denen keiner
// gerufen wird, und es entscheidet Fälle — Zeilenenden, Leerraum, Deckel —,
// die diese Fläche selbst entscheiden muss. Ein Vergleich, dessen Verhalten
// bei einem Leerzeichen am Zeilenende man nachschlagen muss, ist an genau der
// Stelle unbrauchbar, an der ein Betreiber ihn braucht.
//
// ⚠️ MYERS UND NICHT DIE NAIVE LCS-TABELLE. Die Tabelle ist O(n·m) in ZEIT UND
// SPEICHER: zwei Dateien mit je 2.000 Zeilen wären vier Millionen Zellen, und
// das rechnet der Browser bei jedem Tastendruck. Myers kostet O((n+m)·D), wobei
// D die Zahl der UNTERSCHIEDE ist — beim Bearbeiten einer Compose-Datei sind
// das ein paar Zeilen, und der Vergleich ist damit praktisch linear. Der
// schlechte Fall (alles anders) ist trotzdem gedeckelt, siehe unten.
//
// ⚠️ ZEILENENDEN WERDEN NICHT NORMALISIERT. Ein `\r\n` ist eine ANDERE Zeile
// als `\n`, und das ist Absicht: die Datei geht zeichengenau so hinaus, wie
// sie hier steht, und der Agent bildet ihren Hash über genau diese Bytes. Ein
// Vergleich, der den Unterschied wegputzt, zeigte „keine Änderung" für eine
// Bearbeitung, die den Hash ändert — und der Betreiber wendete an, ohne zu
// wissen, was.

/** Was mit einer Zeile geschehen ist. */
export type DiffKind = "equal" | "remove" | "add";

/**
 * Eine Zeile im Vergleich.
 *
 * ⚠️ BEIDE NUMMERN, und je nach Art ist eine davon `null`. Eine entfernte
 * Zeile hat keine Nummer im neuen Stand und eine hinzugefügte keine im alten;
 * eine gemeinsame Nummerierung wäre für den zweispaltigen Blick falsch und für
 * den einspaltigen irreführend.
 */
export type DiffLine = {
  kind: DiffKind;
  /** Zeilennummer im ALTEN Stand, ab 1. `null` bei einer hinzugefügten. */
  oldLine: number | null;
  /** Zeilennummer im NEUEN Stand, ab 1. `null` bei einer entfernten. */
  newLine: number | null;
  text: string;
};

export type DiffResult = {
  lines: DiffLine[];
  added: number;
  removed: number;
  /**
   * Ob der Deckel gegriffen hat.
   *
   * ⚠️ WENN JA, IST `lines` KEIN VERGLEICH MEHR, sondern „alles raus, alles
   * rein". Die Fläche MUSS das sagen: ein Vergleich, der ohne Hinweis behauptet,
   * jede Zeile habe sich geändert, ist eine Falschaussage über die Bearbeitung
   * — und der Betreiber sucht dann nach einer Änderung, die er nie gemacht hat.
   */
  capped: boolean;
};

/**
 * Ab wann nicht mehr verglichen wird.
 *
 * ⚠️ ZWEI DECKEL UND NICHT EINER, weil zwei verschiedene Dinge ausufern
 * können. `MAX_LINES` fängt die schiere Größe — eine Compose-Datei an der
 * Grenze der Gegenseite (256 KB) hat zehntausende Zeilen. `MAX_DIFFERENCES`
 * fängt den anderen Fall: zwei Dateien ÄHNLICHER Größe, die einander nirgends
 * gleichen (jemand hat den ganzen Inhalt ersetzt). Dort ist D so groß wie die
 * Datei, und Myers verliert seinen Vorteil.
 */
export const MAX_LINES = 8_000;
export const MAX_DIFFERENCES = 3_000;

/**
 * Vergleicht zwei Texte zeilenweise.
 *
 * ⚠️ SIE WIRFT NIE UND SIE LÄUFT BEI JEDEM TASTENDRUCK. Was sie nicht rechnen
 * kann, meldet sie als `capped` — und nicht als Fehler, der dem Betreiber die
 * Fläche mitten im Bearbeiten wegnimmt.
 */
export function diffLines(before: string, after: string): DiffResult {
  const a = before.split("\n");
  const b = after.split("\n");

  if (a.length > MAX_LINES || b.length > MAX_LINES) return replaced(a, b);

  // ⚠️ GEMEINSAMER ANFANG UND GEMEINSAMES ENDE ZUERST. Das ist nicht bloss
  // schneller — es ist der Normalfall dieser Fläche: wer eine Compose-Datei
  // bearbeitet, ändert drei Zeilen in der Mitte, und danach hat Myers nur noch
  // diese drei zu betrachten statt der ganzen Datei.
  let head = 0;
  while (head < a.length && head < b.length && a[head] === b[head]) head += 1;
  let tail = 0;
  while (
    tail < a.length - head &&
    tail < b.length - head &&
    a[a.length - 1 - tail] === b[b.length - 1 - tail]
  ) {
    tail += 1;
  }

  const middleA = a.slice(head, a.length - tail);
  const middleB = b.slice(head, b.length - tail);

  const middle = myers(middleA, middleB);
  if (middle === null) return replaced(a, b);

  const lines: DiffLine[] = [];
  for (let index = 0; index < head; index += 1) {
    lines.push({ kind: "equal", oldLine: index + 1, newLine: index + 1, text: a[index] });
  }
  let oldAt = head;
  let newAt = head;
  for (const operation of middle) {
    if (operation.kind === "equal") {
      lines.push({ kind: "equal", oldLine: oldAt + 1, newLine: newAt + 1, text: operation.text });
      oldAt += 1;
      newAt += 1;
    } else if (operation.kind === "remove") {
      lines.push({ kind: "remove", oldLine: oldAt + 1, newLine: null, text: operation.text });
      oldAt += 1;
    } else {
      lines.push({ kind: "add", oldLine: null, newLine: newAt + 1, text: operation.text });
      newAt += 1;
    }
  }
  for (let index = 0; index < tail; index += 1) {
    lines.push({
      kind: "equal",
      oldLine: oldAt + index + 1,
      newLine: newAt + index + 1,
      text: a[a.length - tail + index]
    });
  }

  return {
    lines,
    added: lines.filter((line) => line.kind === "add").length,
    removed: lines.filter((line) => line.kind === "remove").length,
    capped: false
  };
}

/** Der gedeckelte Fall: alles raus, alles rein — und ehrlich benannt. */
function replaced(a: string[], b: string[]): DiffResult {
  const lines: DiffLine[] = [
    ...a.map((text, index): DiffLine => ({ kind: "remove", oldLine: index + 1, newLine: null, text })),
    ...b.map((text, index): DiffLine => ({ kind: "add", oldLine: null, newLine: index + 1, text }))
  ];
  return { lines, added: b.length, removed: a.length, capped: true };
}

type Operation = { kind: DiffKind; text: string };

/**
 * Myers' Vergleichsalgorithmus, mit Deckel.
 *
 * Gibt `null` zurück, wenn mehr als `MAX_DIFFERENCES` Unterschiede nötig
 * wären — dann ist der Vergleich als Vergleich ohnehin wertlos.
 *
 * ⚠️ DER SPUR-SPEICHER IST DER GRUND FÜR DEN DECKEL. Der Rückweg braucht den
 * Zustand JEDER Runde; das sind `D` Reihen zu je `2·(n+m)+1` Zahlen. Ohne
 * Deckel wüchse das bei zwei völlig verschiedenen Dateien ins Unbrauchbare —
 * und zwar im Browser, bei einem Tastendruck.
 */
function myers(a: string[], b: string[]): Operation[] | null {
  const n = a.length;
  const m = b.length;
  if (n === 0 && m === 0) return [];
  if (n === 0) return b.map((text) => ({ kind: "add" as const, text }));
  if (m === 0) return a.map((text) => ({ kind: "remove" as const, text }));

  const max = n + m;
  const offset = max;
  const limit = Math.min(max, MAX_DIFFERENCES);
  const trace: Int32Array[] = [];
  const v = new Int32Array(2 * max + 1);

  for (let d = 0; d <= limit; d += 1) {
    trace.push(v.slice());
    for (let k = -d; k <= d; k += 2) {
      let x: number;
      if (k === -d || (k !== d && v[k - 1 + offset] < v[k + 1 + offset])) {
        x = v[k + 1 + offset];
      } else {
        x = v[k - 1 + offset] + 1;
      }
      let y = x - k;
      while (x < n && y < m && a[x] === b[y]) {
        x += 1;
        y += 1;
      }
      v[k + offset] = x;
      if (x >= n && y >= m) return backtrack(a, b, trace, offset, d);
    }
  }
  return null;
}

/** Der Rückweg durch die gespeicherten Runden. */
function backtrack(
  a: string[],
  b: string[],
  trace: Int32Array[],
  offset: number,
  d: number
): Operation[] {
  const operations: Operation[] = [];
  let x = a.length;
  let y = b.length;

  for (let round = d; round > 0; round -= 1) {
    const previous = trace[round];
    const k = x - y;
    const goDown = k === -round || (k !== round && previous[k - 1 + offset] < previous[k + 1 + offset]);
    const previousK = goDown ? k + 1 : k - 1;
    const previousX = previous[previousK + offset];
    const previousY = previousX - previousK;

    // Die gemeinsamen Zeilen dieser Runde, rückwärts.
    while (x > previousX && y > previousY) {
      x -= 1;
      y -= 1;
      operations.push({ kind: "equal", text: a[x] });
    }
    if (goDown) {
      y -= 1;
      operations.push({ kind: "add", text: b[y] });
    } else {
      x -= 1;
      operations.push({ kind: "remove", text: a[x] });
    }
  }
  // Was vor der ersten Runde gemeinsam war.
  while (x > 0 && y > 0) {
    x -= 1;
    y -= 1;
    operations.push({ kind: "equal", text: a[x] });
  }

  return operations.reverse();
}
