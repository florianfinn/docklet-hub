// Die Handler-Pfade des Agents, aus dem Quelltext von `index.ts` gewonnen.
//
// ⚠️ Wogegen das steht: `route-policy.ts` ist DEFAULT DENY — ein Pfad ohne
// Zeile in `ROUTEN` wird wie `intern-only` behandelt. Wer einen Handler-Pfad
// umbenennt (`/audit-archiv` → `/audit-archive`) und die Musterzeile stehen
// lässt, dreht damit still die Netzstufe dieser Route zu: extern kommt 403, das
// Audit schreibt `route-unknown`, und der Aufrufer sieht eine Ablehnung, die
// wie eine Rechteentscheidung aussieht. Rot wird dabei nichts — die
// Tabellenzeile ist ja weiterhin in sich vollständig, und genau das ist alles,
// was die Prüfung „jede Tabellenzeile ist vollständig" sehen kann.
//
// Deshalb kommen die Pfade hier aus dem Quelltext. Eine von Hand gepflegte
// Liste im Test wäre eine zweite Tabelle und schwiege beim nächsten Umbenennen
// genauso wie die erste.
//
// Rein und ohne Imports: die Quelle kommt als String herein, damit die
// Auswertung ohne fs, ohne Docker und ohne laufenden Server prüfbar ist.

// Ein Regex-Handler wird auf konkrete Beispielpfade normalisiert. Eine
// Zeichenklasse (`[^/]+`, `[A-Za-z0-9._:-]{8,128}`) steht für ein beliebiges
// Segment und wird zu diesem Wert; die Tabelle prüft an einem `:platzhalter`
// nur, dass das Segment nicht leer ist, der konkrete Wert ist ihr egal.
export const EXAMPLE_SEGMENT = "x";

export type Origin = "comparison" | "regex" | "container-action";

export type HandlerPath = {
  pathname: string;
  // Zeile in `index.ts`, damit ein Fehlschlag die Fundstelle nennt und nicht
  // nur den Pfad.
  row: number;
  origin: Origin;
};

// Der zweistufige Dispatcher am Container: der Regex holt nur `<id>/<aktion>`,
// die Aktionen selbst stehen darunter als `action === "…"`.
const CONTAINER_DISPATCHER = "const containerMatch = url.pathname.match";

// Ein Regex-Literal in einer Zeile Quelltext. Zeichenklassen werden als eigener
// Zweig erkannt, sonst beendete das `/` in `[^/]` das Literal zu früh.
const REGEX_LITERAL = String.raw`\/(?:[^/\\\n\[]|\\.|\[(?:[^\]\\]|\\.)*\])+\/[a-z]*`;

function lineOf(source: string, index: number): number {
  let line = 1;
  for (let i = 0; i < index; i += 1) if (source[i] === "\n") line += 1;
  return line;
}

function classEnd(body: string, start: number): number {
  for (let i = start + 1; i < body.length; i += 1) {
    if (body[i] === "\\") {
      i += 1;
      continue;
    }
    if (body[i] === "]") return i;
  }
  throw new Error(`unterminated character class in ${body}`);
}

// Ein Regex-Handler → alle Pfade, die er bedient.
//
// Alternations are unfolded (`(a|b|c)` → three paths), an optional group
// produces both cases, character classes become a sample segment. That is the
// normalisation the guard lives on: without it the regex route would have to
// be kept in step by hand, and it would be a second table again.
export function examplePathsFromRegex(literal: string): string[] {
  const body = literal.slice(1, literal.lastIndexOf("/"));
  let i = 0;

  const quantifier = (values: string[]): string[] => {
    const char = body[i];
    if (char === "+") {
      i += 1;
      return values;
    }
    if (char === "*" || char === "?") {
      i += 1;
      return [...values, ""];
    }
    if (char === "{") {
      const end = body.indexOf("}", i);
      const min = Number(body.slice(i + 1, end).split(",")[0]);
      i = end + 1;
      // `{0,61}` darf leer sein und muss deshalb auch den leeren Fall liefern.
      return min === 0 ? [...values, ""] : values;
    }
    return values;
  };

  const atom = (): string[] => {
    const char = body[i];
    // Anker tragen nichts zum Pfad bei.
    if (char === "^" || char === "$") {
      i += 1;
      return [""];
    }
    if (char === "\\") {
      const raw = body[i + 1];
      i += 2;
      return quantifier([raw]);
    }
    if (char === "[") {
      i = classEnd(body, i) + 1;
      return quantifier([EXAMPLE_SEGMENT]);
    }
    if (char === ".") {
      i += 1;
      return quantifier([EXAMPLE_SEGMENT]);
    }
    if (char === "(") {
      if (body.startsWith("(?:", i)) i += 3;
      else if (body.startsWith("(?", i)) throw new Error(`unknown group type in ${literal}`);
      else i += 1;
      const content = alternatives();
      if (body[i] !== ")") throw new Error(`unbalanced parenthesis in ${literal}`);
      i += 1;
      return quantifier(content);
    }
    i += 1;
    return quantifier([char]);
  };

  const sequence = (): string[] => {
    let parts = [""];
    while (i < body.length && body[i] !== "|" && body[i] !== ")") {
      const chunk = atom();
      parts = parts.flatMap((links) => chunk.map((right) => links + right));
    }
    return parts;
  };

  const alternatives = (): string[] => {
    const result = [...sequence()];
    while (body[i] === "|") {
      i += 1;
      result.push(...sequence());
    }
    return result;
  };

  const paths = alternatives();
  if (i !== body.length) throw new Error(`remainder in pattern ${literal}: ${body.slice(i)}`);
  return [...new Set(paths)];
}

// Die Aktionen des Container-Dispatchers, aus dem Quelltext.
//
// Sie stehen NICHT im Regex, sondern darunter als `action === "…"` — und die
// drei sicheren Aktionen nicht einmal dort, sondern in `SAFE_ACTIONS`. Beides
// wird gelesen, sonst prüfte der Wächter `/containers/x/x`, ein Muster, das es
// als Route gar nicht gibt.
export function containerActions(source: string): string[] {
  const start = source.indexOf(CONTAINER_DISPATCHER);
  if (start < 0) throw new Error(`the container dispatcher (${CONTAINER_DISPATCHER}) is no longer in index.ts`);
  const actions = new Set<string>();
  // ⚠️ Kein `\b` vor `action`: eine Wortgrenze steht auch hinter einem Punkt.
  // `body.action === "string"` (the WebFTP body) would otherwise come in as
  // action "string" and demand a pattern line for a path that does not
  // exist. Only the free-standing dispatcher variable is meant.
  //
  // ⚠️ This lookbehind only covers the INLINE form `body.action === "…"`,
  // not an assignment to a free-standing variable. The body action in
  // src/routes/file-routes.ts is therefore deliberately called `fileAction`,
  // not `action` — otherwise this scanner takes it for the URL action from
  // `containerMatch[2]` and reports three false alarms (the three WebFTP
  // body actions of file-routes.ts without a pattern line). Whoever renames it
  // back gets those false alarms back.
  for (const [, name] of source.slice(start).matchAll(/(?<![.\w$])action === "([^"]+)"/g)) actions.add(name);
  const safe = /const SAFE_ACTIONS = new Set\(\[([^\]]*)\]\)/.exec(source);
  if (safe === null) throw new Error("SAFE_ACTIONS is no longer in the expected form in index.ts");
  for (const [, name] of safe[1].matchAll(/"([^"]+)"/g)) actions.add(name);
  return [...actions].sort();
}

// Alle Pfade, die `index.ts` als Handler bedient.
export function handlerPaths(source: string): HandlerPath[] {
  const found = new Map<string, HandlerPath>();
  const add = (pathname: string, line: number, origin: Origin): void => {
    if (!pathname.startsWith("/")) throw new Error(`${pathname} (index.ts:${line}) is not a path`);
    if (!found.has(pathname)) found.set(pathname, { pathname, row: line, origin });
  };

  // 1. Der direkte Vergleich: `url.pathname === "/audit-archive"`.
  for (const match of source.matchAll(/url\.pathname === "([^"]+)"/g)) {
    add(match[1], lineOf(source, match.index), "comparison");
  }

  // 2. Die Regex-Handler, in beiden Schreibweisen.
  const literals: { literal: string; row: number }[] = [];
  for (const match of source.matchAll(new RegExp(String.raw`url\.pathname\.match\((${REGEX_LITERAL})\)`, "g"))) {
    literals.push({ literal: match[1], row: lineOf(source, match.index) });
  }
  for (const match of source.matchAll(new RegExp(`(${REGEX_LITERAL})` + String.raw`\.exec\(url\.pathname\)`, "g"))) {
    literals.push({ literal: match[1], row: lineOf(source, match.index) });
  }
  // Ein Regex, den das Literal-Muster nicht fasst, verschwände lautlos aus dem
  // Wächter. Die Zahl der Stellen muss deshalb aufgehen.
  const occurrences = (source.match(/url\.pathname\.match\(/g)?.length ?? 0)
    + (source.match(/\.exec\(url\.pathname\)/g)?.length ?? 0);
  if (occurrences !== literals.length) {
    throw new Error(`${occurrences} regex handlers on url.pathname, but only ${literals.length} read`);
  }

  const containerGenerated = `/containers/${EXAMPLE_SEGMENT}/${EXAMPLE_SEGMENT}`;
  for (const { literal, row: line } of literals) {
    for (const pathname of examplePathsFromRegex(literal)) {
      if (pathname === containerGenerated) {
        for (const action of containerActions(source)) {
          add(`/containers/${EXAMPLE_SEGMENT}/${action}`, line, "container-action");
        }
        continue;
      }
      add(pathname, line, "regex");
    }
  }

  return [...found.values()];
}

// Die Präfix-Wächter (`url.pathname.startsWith("/v1/games/runtime/")`).
//
// Sie sind selbst keine Route, entscheiden aber, ob die Regex-Handler dahinter
// überhaupt erreicht werden: ein umbenannter Präfix macht sie zu totem Code,
// ohne dass eine Musterzeile falsch würde.
export function prefixGuards(source: string): { prefix: string; row: number }[] {
  const match: { prefix: string; row: number }[] = [];
  for (const occurrence of source.matchAll(/url\.pathname\.startsWith\("([^"]+)"\)/g)) {
    match.push({ prefix: occurrence[1], row: lineOf(source, occurrence.index) });
  }
  return match;
}

// Was direkt hinter `url.pathname` steht, Stelle für Stelle.
//
// Der Wächter liest genau drei Formen. Käme eine vierte dazu (`switch`, ein
// Vergleich gegen eine Variable, ein `!==`), sähe er die Route dahinter nicht
// mehr — und bliebe still grün. Deshalb wird die Form selbst geprüft.
export function dispatchForms(source: string): { form: string; row: number }[] {
  const formen: { form: string; row: number }[] = [];
  for (const occurrence of source.matchAll(/url\.pathname/g)) {
    const rest = source.slice(occurrence.index + "url.pathname".length);
    const form = rest.startsWith(' === "') ? '=== "…"'
      : rest.startsWith(".match(") ? ".match(…)"
        : rest.startsWith('.startsWith("') ? '.startsWith("…")'
          // Weitergereicht statt verglichen: als Argument, als Ende einer
          // Argumentliste oder in einem Template. Das entscheidet nichts.
          : /^[),}]/.test(rest) ? "passed-on"
            : rest.slice(0, 20);
    formen.push({ form, row: lineOf(source, occurrence.index) });
  }
  return formen;
}

// Jedes andere Objekt, aus dem im Quelltext ein `.pathname` gelesen wird.
//
// Ein zweites URL-Objekt wäre ein Weg an der Formprüfung oben vorbei.
export function foreignPathnameObjects(source: string): { object: string; row: number }[] {
  const match: { object: string; row: number }[] = [];
  for (const occurrence of source.matchAll(/\b(\w+)\.pathname\b/g)) {
    if (occurrence[1] === "url") continue;
    match.push({ object: occurrence[1], row: lineOf(source, occurrence.index) });
  }
  return match;
}
