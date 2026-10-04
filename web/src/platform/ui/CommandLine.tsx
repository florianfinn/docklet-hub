import type { ReactNode } from "react";

import { cn } from "./lib/cn";

// A command or value the operator copies to ANOTHER machine, character for
// character. Own row, own surface, `select-all` so one click marks all of it.
//
// `overflow-x-auto` with `max-w-full`/`min-w-0` lets a long line scroll inside
// its own row instead of pushing the surrounding dialog open.
//
// `prompt` marks a shell command with a `$` that is neither selected nor read
// out, so `code` holds exactly what gets typed. `highlight` colours the first
// occurrence of a substring, typically the path the operator has to check.
export function CommandLine({
  children,
  prompt = false,
  highlight
}: {
  children: string;
  prompt?: boolean;
  highlight?: string;
}) {
  const index = highlight ? children.indexOf(highlight) : -1;
  const content: ReactNode =
    highlight && index >= 0 ? (
      <>
        {children.slice(0, index)}
        <span className="font-semibold text-primary">{highlight}</span>
        {children.slice(index + highlight.length)}
      </>
    ) : (
      children
    );

  return (
    <span
      className={cn(
        "mt-1.5 flex max-w-full items-baseline gap-2 rounded-md border border-border bg-muted px-2.5 py-1.5 font-mono text-[12px] text-foreground",
        prompt && "border-l-2 border-l-primary"
      )}
    >
      {prompt ? (
        <span aria-hidden="true" className="select-none font-semibold text-primary">
          $
        </span>
      ) : null}
      <code className="block min-w-0 flex-1 select-all overflow-x-auto whitespace-pre">{content}</code>
    </span>
  );
}
