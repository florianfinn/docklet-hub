/**
 * Übernommener Baustein — shadcn/ui.
 *
 * Quelle:      https://ui.shadcn.com/r/styles/new-york-v4/sonner.json
 * Baustein:    sonner (Stil „new-york-v4")
 * Bezugsdatum: 2026-09-05
 * sha256:      439c5d5256091829350d3136309f55f8ba788f1cc0f0dbad016ce6b5b2765488
 *
 * Abweichungen:
 * - `"use client"` entfernt: Next.js-Anweisung ohne Bedeutung unter Vite.
 *   (Der `cn`-Platzhalter gilt für 18 der 20 Dateien dieses Pakets — diese
 *   Datei importiert `cn` gar nicht, gemessen mit
 *   `grep -l 'from "../lib/cn"' web/src/platform/ui/shadcn/*.tsx | wc -l`.)
 * - `next-themes` entfernt: Next.js-Paket, das diese Vite-Anwendung nicht hat.
 *   `useTheme()` und der Import fallen weg, `theme="dark"` steht fest (siehe
 *   Kommentar im Rumpf).
 * - `import type * as React from "react"` ergänzt: die Datei benutzt
 *   `React.CSSProperties` als Typ, ohne `React` selbst zu importieren — unter
 *   Next.js trägt das die Voreinstellung, hier wirft `tsc --noEmit` sonst einen
 *   Fehler.
 */

import type * as React from "react"
import {
  CircleCheckIcon,
  InfoIcon,
  Loader2Icon,
  OctagonXIcon,
  TriangleAlertIcon,
} from "lucide-react"
import { Toaster as Sonner, type ToasterProps } from "sonner"

const Toaster = ({ ...props }: ToasterProps) => {
  // Fest auf dunkel: diese Anwendung ist dunkel-zuerst und hat kein
  // `next-themes` (kein Next.js-Projekt). Paket D7 (Theme-Editor, #62) hängt
  // diese Stelle an die Theme-Einstellung des Hubs, sobald es sie gibt.
  return (
    <Sonner
      theme="dark"
      className="toaster group"
      icons={{
        success: <CircleCheckIcon className="size-4" />,
        info: <InfoIcon className="size-4" />,
        warning: <TriangleAlertIcon className="size-4" />,
        error: <OctagonXIcon className="size-4" />,
        loading: <Loader2Icon className="size-4 animate-spin" />,
      }}
      style={
        {
          "--normal-bg": "var(--popover)",
          "--normal-text": "var(--popover-foreground)",
          "--normal-border": "var(--border)",
          "--border-radius": "var(--radius)",
        } as React.CSSProperties
      }
      {...props}
    />
  )
}

export { Toaster }
