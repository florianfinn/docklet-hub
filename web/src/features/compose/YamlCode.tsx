import { classOfKind, highlightLines, type CodePiece } from "./yaml-highlight";

// Die Anzeige eines YAML-Textes mit Zeilennummern.
//
// ⚠️ DIE ZEILENNUMMERN STEHEN IN EINER EIGENEN SPALTE UND NICHT IM TEXT. Wer
// sie in denselben Fluss schreibt, gibt sie beim Kopieren mit heraus — und ein
// Betreiber, der einen Ausschnitt in eine Datei zurückträgt, trägt dann
// Zeilennummern hinein. Sie sind zudem `aria-hidden`: eine Vorlesehilfe soll
// den Inhalt lesen und nicht bei jeder Zeile eine Zahl davor sagen.
//
// ⚠️ `whitespace-pre` UND NICHT `pre-wrap`. Eine umgebrochene Zeile stünde
// unter einer Zeilennummer, die dann für zwei Bildzeilen gilt — die Spalte
// liefe gegen den Text aus dem Tritt. Lange Zeilen rollen deshalb waagerecht.
// Dieselbe Wahl trifft der Editor darüber (E6a), und zwar aus einem zweiten,
// härteren Grund: sein unsichtbares Textfeld muss an denselben Stellen
// umbrechen wie diese Anzeige.

export type YamlCodeProps = {
  text: string;
  /** Die Nummer der ersten Zeile. Für Ausschnitte im Vergleich. */
  firstLine?: number;
  /** Zusätzliche Klassen für den Rahmen. */
  className?: string;
};

/** Eine Zeile, gefärbt. Ohne Stücke bleibt sie leer und behält ihre Höhe. */
export function CodeLine({ pieces }: { pieces: CodePiece[] }) {
  // ⚠️ Ein leeres Element hätte die Höhe null und brächte die Zeilenspalte zum
  // Verrutschen. Das Nullbreiten-Leerzeichen hält die Zeile auf.
  if (pieces.length === 0) return <>{"​"}</>;
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

export function YamlCode({ text, firstLine = 1, className }: YamlCodeProps) {
  const lines = highlightLines(text);
  return (
    <div className={`overflow-x-auto font-mono text-[12.5px] leading-[1.55] ${className ?? ""}`}>
      <div className="flex min-w-fit">
        <div
          aria-hidden="true"
          className="sticky left-0 select-none border-r border-border bg-card pr-2 pl-3 text-right text-subtle-foreground"
        >
          {lines.map((_, index) => (
            <div key={index}>{firstLine + index}</div>
          ))}
        </div>
        <pre className="min-w-fit whitespace-pre px-3">
          {lines.map((pieces, index) => (
            <div key={index}>
              <CodeLine pieces={pieces} />
            </div>
          ))}
        </pre>
      </div>
    </div>
  );
}
