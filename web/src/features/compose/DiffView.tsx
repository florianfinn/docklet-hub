import { useTranslations } from "use-intl";

import { classOfKind, highlightLines } from "./yaml-highlight";
import type { DiffLine, DiffResult } from "./text-diff";

// Der Blick auf „was ändert sich" — einspaltig oder nebeneinander.
//
// ⚠️ BEIDE FORMEN LESEN DIESELBE RECHNUNG. `diffLines` läuft EINMAL, und die
// Umschaltung entscheidet nur, wie ihr Ergebnis angeordnet wird. Zwei
// Rechnungen wären zwei Wahrheiten darüber, was sich geändert hat, und die
// zweispaltige zeigte beim ersten Sonderfall etwas anderes als die einspaltige.
//
// ⚠️ DIE FARBE IST NICHT DIE EINZIGE AUSKUNFT. Jede Zeile trägt zusätzlich ein
// `+` oder `−` als Zeichen. Wer nur Grün und Rot benutzt, baut eine Fläche, die
// für rund acht Prozent der Männer keine Aussage macht — und für jeden, der
// einen Ausschnitt in Schwarzweiss ausdruckt.

/** Die Einfärbung einer Diff-Zeile, gemeinsam für beide Formen. */
function toneOf(kind: DiffLine["kind"]): string {
  switch (kind) {
    case "add":
      return "bg-state-ok/10 text-foreground";
    case "remove":
      return "bg-destructive/10 text-foreground";
    default:
      return "";
  }
}

function signOf(kind: DiffLine["kind"]): string {
  return kind === "add" ? "+" : kind === "remove" ? "−" : " ";
}

/** Der Text einer Zeile, eingefärbt wie im Editor. */
function LineText({ text }: { text: string }) {
  // ⚠️ DERSELBE EINFÄRBER WIE IM EDITOR und nicht ein zweiter für den
  // Vergleich. Zwei Einfärber ergäben eine Datei, die in der Bearbeitung
  // anders aussieht als in der Vorschau — und der Betreiber prüfte am Ende
  // nicht das, was er ansieht.
  const pieces = highlightLines(text)[0] ?? [];
  return (
    <>
      {pieces.map((piece, index) => {
        const className = classOfKind(piece.kind);
        return className === "" ? (
          <span key={index}>{piece.text}</span>
        ) : (
          <span key={index} className={className}>
            {piece.text}
          </span>
        );
      })}
    </>
  );
}

function Gutter({ value }: { value: number | null }) {
  return (
    <span aria-hidden="true" className="w-10 shrink-0 select-none pr-2 text-right text-subtle-foreground">
      {value ?? ""}
    </span>
  );
}

/** Einspaltig: alt und neu untereinander, mit Kontext dazwischen. */
function Unified({ lines }: { lines: DiffLine[] }) {
  return (
    <div className="overflow-x-auto font-mono text-[12.5px] leading-[1.55]">
      {lines.map((line, index) => (
        <div key={index} className={`flex min-w-fit whitespace-pre ${toneOf(line.kind)}`}>
          <Gutter value={line.oldLine} />
          <Gutter value={line.newLine} />
          <span aria-hidden="true" className="w-4 shrink-0 select-none text-subtle-foreground">
            {signOf(line.kind)}
          </span>
          <span className="pr-3">
            <LineText text={line.text} />
          </span>
        </div>
      ))}
    </div>
  );
}

/**
 * Eine Zeile der zweispaltigen Form: was links steht und was rechts.
 *
 * ⚠️ EINE ENTFERNTE UND EINE HINZUGEFÜGTE ZEILE STEHEN NEBENEINANDER, wenn sie
 * unmittelbar aufeinander folgen — das ist der Fall „diese Zeile wurde
 * geändert", und ihn auf zwei Höhen zu verteilen zwänge den Blick zum Springen.
 * Was ohne Gegenüber bleibt, bekommt eine leere Zelle und keine erfundene.
 */
type Paired = { left: DiffLine | null; right: DiffLine | null };

export function pairLines(lines: DiffLine[]): Paired[] {
  const pairs: Paired[] = [];
  let index = 0;
  while (index < lines.length) {
    const line = lines[index];
    if (line.kind === "equal") {
      pairs.push({ left: line, right: line });
      index += 1;
      continue;
    }
    // Ein Block aus Entfernten, danach ein Block aus Hinzugefügten — so
    // liefert der Vergleich eine geänderte Stelle.
    const removed: DiffLine[] = [];
    while (index < lines.length && lines[index].kind === "remove") {
      removed.push(lines[index]);
      index += 1;
    }
    const added: DiffLine[] = [];
    while (index < lines.length && lines[index].kind === "add") {
      added.push(lines[index]);
      index += 1;
    }
    const height = Math.max(removed.length, added.length);
    for (let step = 0; step < height; step += 1) {
      pairs.push({ left: removed[step] ?? null, right: added[step] ?? null });
    }
  }
  return pairs;
}

function Side({ line }: { line: DiffLine | null }) {
  if (line === null) {
    // ⚠️ Eine leere Zelle und keine erfundene Zeile. Sie trägt die Farbe
    // NICHT: „hier steht nichts" ist etwas other als „hier wurde gelöscht".
    return <div className="flex min-w-fit whitespace-pre opacity-40">{"​"}</div>;
  }
  return (
    <div className={`flex min-w-fit whitespace-pre ${toneOf(line.kind)}`}>
      <Gutter value={line.kind === "add" ? line.newLine : line.oldLine} />
      <span aria-hidden="true" className="w-4 shrink-0 select-none text-subtle-foreground">
        {signOf(line.kind)}
      </span>
      <span className="pr-3">
        <LineText text={line.text} />
      </span>
    </div>
  );
}

function SideBySide({ lines }: { lines: DiffLine[] }) {
  const pairs = pairLines(lines);
  return (
    <div className="grid grid-cols-2 divide-x divide-border font-mono text-[12.5px] leading-[1.55]">
      <div className="overflow-x-auto">
        {pairs.map((pair, index) => (
          <Side key={index} line={pair.left} />
        ))}
      </div>
      <div className="overflow-x-auto">
        {pairs.map((pair, index) => (
          <Side key={index} line={pair.right} />
        ))}
      </div>
    </div>
  );
}

export type DiffViewProps = {
  result: DiffResult;
  side: boolean;
};

export function DiffView({ result, side }: DiffViewProps) {
  const t = useTranslations();

  if (result.added === 0 && result.removed === 0) {
    return <p className="px-4 py-3 text-[13px] text-muted-foreground">{t("composeDiffNone")}</p>;
  }

  return (
    <div>
      {/* ⚠️ DER DECKEL WIRD GESAGT UND NICHT VERSCHWIEGEN. Was darunter steht,
          ist dann kein Vergleich mehr, sondern „alles raus, alles rein" — und
          ein Betreiber, der das für einen Vergleich hält, sucht nach einer
          Änderung, die er nie gemacht hat. */}
      {result.capped ? (
        <p className="border-b border-border bg-state-warn/10 px-4 py-2 text-[13px]">{t("composeDiffCapped")}</p>
      ) : null}
      {side ? <SideBySide lines={result.lines} /> : <Unified lines={result.lines} />}
    </div>
  );
}
