/**
 * Übernommener Baustein — shadcn/ui.
 *
 * Quelle:      https://ui.shadcn.com/r/styles/new-york-v4/breadcrumb.json
 * Baustein:    breadcrumb (Stil „new-york-v4")
 * Bezugsdatum: 2026-09-05
 * sha256:      18043f281e20e08fa017a3bba2b2dec462ebba2b0ebf9685b34225cf7b253bfa
 *
 * Abweichungen:
 * - `import { cn } from "cn"` auf `../lib/cn` gezogen: Registry-Platzhalter.
 * - Kein `"use client"` zu entfernen: diese Vorlage bringt keins mit
 *   (gemessen, anders als bei den meisten übrigen Bausteinen dieses Pakets).
 * - Das `aria-label` von `Breadcrumb` (Vorlagenwert „breadcrumb") und der
 *   `sr-only`-Text „More" von `BreadcrumbEllipsis` über `useTranslations()`
 *   aus `use-intl` und die Schlüssel `uiBreadcrumbNav` und `uiBreadcrumbMore`
 *   aus `web/src/platform/i18n/messages/de.ts` geführt: dieses Projekt hält UI-Texte nicht im
 *   Code (web/tests/ui-texts.test.mjs), und ein Screenreader läse den
 *   englischen Registry-Text sonst unverändert vor.
 */
import * as React from "react"
import { cn } from "../lib/cn"
import { ChevronRight, MoreHorizontal } from "lucide-react"
import { Slot } from "radix-ui"
import { useTranslations } from "use-intl"

function Breadcrumb({ ...props }: React.ComponentProps<"nav">) {
  const t = useTranslations()
  return <nav aria-label={t("uiBreadcrumbNav")} data-slot="breadcrumb" {...props} />
}

function BreadcrumbList({ className, ...props }: React.ComponentProps<"ol">) {
  return (
    <ol
      data-slot="breadcrumb-list"
      className={cn(
        "flex flex-wrap items-center gap-1.5 text-sm break-words text-muted-foreground sm:gap-2.5",
        className
      )}
      {...props}
    />
  )
}

function BreadcrumbItem({ className, ...props }: React.ComponentProps<"li">) {
  return (
    <li
      data-slot="breadcrumb-item"
      className={cn("inline-flex items-center gap-1.5", className)}
      {...props}
    />
  )
}

function BreadcrumbLink({
  asChild,
  className,
  ...props
}: React.ComponentProps<"a"> & {
  asChild?: boolean
}) {
  const Comp = asChild ? Slot.Root : "a"

  return (
    <Comp
      data-slot="breadcrumb-link"
      className={cn("transition-colors hover:text-foreground", className)}
      {...props}
    />
  )
}

function BreadcrumbPage({ className, ...props }: React.ComponentProps<"span">) {
  return (
    <span
      data-slot="breadcrumb-page"
      role="link"
      aria-disabled="true"
      aria-current="page"
      className={cn("font-normal text-foreground", className)}
      {...props}
    />
  )
}

function BreadcrumbSeparator({
  children,
  className,
  ...props
}: React.ComponentProps<"li">) {
  return (
    <li
      data-slot="breadcrumb-separator"
      role="presentation"
      aria-hidden="true"
      className={cn("[&>svg]:size-3.5", className)}
      {...props}
    >
      {children ?? <ChevronRight />}
    </li>
  )
}

function BreadcrumbEllipsis({
  className,
  ...props
}: React.ComponentProps<"span">) {
  const t = useTranslations()
  return (
    <span
      data-slot="breadcrumb-ellipsis"
      role="presentation"
      aria-hidden="true"
      className={cn("flex size-9 items-center justify-center", className)}
      {...props}
    >
      <MoreHorizontal className="size-4" />
      <span className="sr-only">{t("uiBreadcrumbMore")}</span>
    </span>
  )
}

export {
  Breadcrumb,
  BreadcrumbList,
  BreadcrumbItem,
  BreadcrumbLink,
  BreadcrumbPage,
  BreadcrumbSeparator,
  BreadcrumbEllipsis,
}
