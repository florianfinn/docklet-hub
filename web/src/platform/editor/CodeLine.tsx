import { classOfKind, type CodePiece } from "./yaml-highlight";
export function CodeLine({ pieces }: { pieces: CodePiece[] }) {
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
