/**
 * Übernommener Baustein — shadcn/ui.
 *
 * Quelle:      https://ui.shadcn.com/r/styles/new-york-v4/label.json
 * Baustein:    label (Stil „new-york-v4")
 * Bezugsdatum: 2026-09-05
 * sha256:      b03d6bc91da205758df87c5403d74bae4d742f1f4ac5ae0b94ad7a29ab6350ea
 *
 * Abweichungen:
 * - `"use client"` entfernt: Next.js-Anweisung ohne Bedeutung unter Vite.
 * - `import { cn } from "cn"` auf `../lib/cn` gezogen: Registry-Platzhalter.
 */
import * as React from "react"
import { cn } from "../lib/cn";
import { Label as LabelPrimitive } from "radix-ui"

function Label({
  className,
  ...props
}: React.ComponentProps<typeof LabelPrimitive.Root>) {
  return (
    <LabelPrimitive.Root
      data-slot="label"
      className={cn(
        "flex items-center gap-2 text-sm leading-none font-medium select-none group-data-[disabled=true]:pointer-events-none group-data-[disabled=true]:opacity-50 peer-disabled:cursor-not-allowed peer-disabled:opacity-50",
        className
      )}
      {...props}
    />
  )
}

export { Label }
