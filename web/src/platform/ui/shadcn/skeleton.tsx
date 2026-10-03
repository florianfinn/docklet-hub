/**
 * Übernommener Baustein — shadcn/ui.
 *
 * Quelle:      https://ui.shadcn.com/r/styles/new-york-v4/skeleton.json
 * Baustein:    skeleton (Stil „new-york-v4")
 * Bezugsdatum: 2026-09-05
 * sha256:      1ed4d99f9d632d9697a054eefcd19932abd68cef7808407986f6e14da401edf7
 *
 * Abweichungen:
 * - `import { cn } from "cn"` auf `../lib/cn` gezogen: Registry-Platzhalter.
 * - `import * as React from "react"` ergänzt: die Datei benutzt
 *   `React.ComponentProps`, importiert `React` aber nicht (gemessen). Das
 *   trägt in einem Next.js-Projekt die Voreinstellung, hier wirft
 *   `tsc --noEmit` sonst um.
 */
import * as React from "react";
import { cn } from "../lib/cn";

function Skeleton({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="skeleton"
      className={cn("animate-pulse rounded-md bg-accent", className)}
      {...props}
    />
  )
}

export { Skeleton }
