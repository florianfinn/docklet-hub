/**
 * Übernommener Baustein — shadcn/ui.
 *
 * Quelle:      https://ui.shadcn.com/r/styles/new-york-v4/collapsible.json
 * Baustein:    collapsible (Stil „new-york-v4")
 * Bezugsdatum: 2026-09-05
 * sha256:      fdc6666e9c728d7e731b0e4d67e11db81020aff47408c259549fc1aefcc8e3e7
 *
 * Abweichungen:
 * - `"use client"` entfernt: Next.js-Anweisung ohne Bedeutung unter Vite.
 * - Kein `cn`-Import zu ziehen: diese Vorlage importiert `cn` nicht
 *   (gemessen, anders als `avatar.tsx`, `breadcrumb.tsx` und `command.tsx`).
 * - `import * as React from "react"` ergänzt: die Datei benutzt
 *   `React.ComponentProps` an drei Stellen, importiert `React` aber nicht
 *   (gemessen: `grep -c 'React\.' collapsible.tsx` gegen
 *   `grep -c 'import \* as React' collapsible.tsx`). Das trägt in einem
 *   Next.js-Projekt die Voreinstellung, hier wirft `tsc --noEmit` sonst um.
 */
import * as React from "react"
import { Collapsible as CollapsiblePrimitive } from "radix-ui"

function Collapsible({
  ...props
}: React.ComponentProps<typeof CollapsiblePrimitive.Root>) {
  return <CollapsiblePrimitive.Root data-slot="collapsible" {...props} />
}

function CollapsibleTrigger({
  ...props
}: React.ComponentProps<typeof CollapsiblePrimitive.CollapsibleTrigger>) {
  return (
    <CollapsiblePrimitive.CollapsibleTrigger
      data-slot="collapsible-trigger"
      {...props}
    />
  )
}

function CollapsibleContent({
  ...props
}: React.ComponentProps<typeof CollapsiblePrimitive.CollapsibleContent>) {
  return (
    <CollapsiblePrimitive.CollapsibleContent
      data-slot="collapsible-content"
      {...props}
    />
  )
}

export { Collapsible, CollapsibleTrigger, CollapsibleContent }
