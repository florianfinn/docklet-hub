/**
 * Übernommener Baustein — shadcn/ui.
 *
 * Quelle:      https://ui.shadcn.com/r/styles/new-york-v4/separator.json
 * Baustein:    separator (Stil „new-york-v4")
 * Bezugsdatum: 2026-09-05
 * sha256:      4242a9fe839cae9083acff1280b7cccfda10e97bbc83283aed12d2d12bebdc6a
 *
 * Abweichungen:
 * - `"use client"` entfernt: Next.js-Anweisung ohne Bedeutung unter Vite.
 * - `import { cn } from "cn"` auf `../lib/cn` gezogen: Registry-Platzhalter.
 */
import * as React from "react"
import { cn } from "../lib/cn";
import { Separator as SeparatorPrimitive } from "radix-ui"

function Separator({
  className,
  orientation = "horizontal",
  decorative = true,
  ...props
}: React.ComponentProps<typeof SeparatorPrimitive.Root>) {
  return (
    <SeparatorPrimitive.Root
      data-slot="separator"
      decorative={decorative}
      orientation={orientation}
      className={cn(
        "shrink-0 bg-border data-[orientation=horizontal]:h-px data-[orientation=horizontal]:w-full data-[orientation=vertical]:h-full data-[orientation=vertical]:w-px",
        className
      )}
      {...props}
    />
  )
}

export { Separator }
