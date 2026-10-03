# Register für übernommenen shadcn-Code

Dieses Dokument ist das Register für den Übernahme-Ritus der shadcn-Bausteine, begonnen mit Paket D2
(„Grundbausteine", 20 Dateien) und fortgeschrieben mit Paket D3 („Die Schale", vier weitere Dateien). Es
hält fest, warum die freie shadcn-Registry und nicht shadcnblocks Pro die Quelle ist, welche Form ein
Herkunftskopf hat, warum an der Stelle des Commit-SHA hier ein `sha256` steht, den ganzen Bestand der
inzwischen 26 Bausteine und die Abweichungen, die für mehrere Dateien gelten. Was für D2 galt, gilt für D3
unverändert weiter — dieser Abschnitt wird bei jedem weiteren Paket fortgeschrieben, nicht neu geschrieben.

## Zum Dateinamen

Im Quellprojekt `dashboard-homelab` heißt diese Datei `HERKUNFT.md`. Hier heißt sie `PROVENANCE.md`, weil
dieses Repo einen Wächter über Dateinamen hat, den das Quellprojekt nicht hat:
`web/tests/english-filenames.test.mjs` prüft jedes Pfadsegment gegen dieselbe deutsche Wortliste wie die
ESLint-Regel, und `herkunft` steht darin (`eslint-rules/german-words.txt`, Zeile 405). Dateinamen sind
englisch, Inhalte deutsch — die Regel gilt auch für die Datei, die den Ritus festschreibt.

Bis #144 nannte AGENTS.md an der Regel selbst noch den Namen des Vorbilds, und die Begründung dafür stand
nur hier — an einer Stelle, die erst findet, wer die Datei schon gefunden hat. Seither steht beides
zusammen: AGENTS.md, Abschnitt „Übernommener Code", nennt `PROVENANCE.md` und den Grund.

## Zum Ort

Bis #255 lag dieser Ordner unter `web/src/ui/shadcn/`, mit `cn.ts` und `initials.ts` unter `web/src/ui/lib/`.
Beide sind mit dem Umbau „Ordnung nach Features" nach `web/src/platform/ui/` gezogen, weil sie Querschnitt
ohne Fachwissen sind (`docs/design/feature-architecture.md`, Abschnitt 2). Der relative Import `../lib/cn`
blieb dabei gleich; Herkunftsköpfe und Abweichungen gelten unverändert, nur die Pfade dieses Repos in den
Köpfen sind nachgezogen. Wer einen Baustein mit einer früheren Fassung vergleicht, sucht ihn vor #255
unter dem alten Pfad.

## a) Warum die freie Registry und nicht shadcnblocks Pro

Gemessen, mit dem Schlüssel aus der Umgebung (`SHADCNBLOCKS_API_KEY`):

| Aufruf | Ergebnis |
| --- | --- |
| `GET https://www.shadcnblocks.com/r/button.json` mit gültigem Schlüssel | `404 {"error":"Block, component, example, or page not found"}` |
| dito `card`, `dialog`, `sidebar` | `404`, dieselbe Meldung |
| `GET https://www.shadcnblocks.com/r/hero1.json` mit demselben Schlüssel | `200`, 4716 Bytes |
| `registryDependencies` von `hero1` | `["utils","badge","button"]` |

Daraus: der Schlüssel ist gesetzt und gültig, also greift Schritt 2 der Reihenfolge aus AGENTS.md („ist der
Schlüssel nicht gesetzt: nachfragen") nicht. shadcnblocks liefert *Blöcke*, die die shadcn-Grundbausteine
**voraussetzen** (siehe `registryDependencies` von `hero1`), und liefert die Grundbausteine selbst nicht.
Damit greift Schritt 3 der Reihenfolge wörtlich: die freie shadcn-Registry.

Für spätere Pakete gilt das nicht pauschal: ganze Blöcke (Navbar, Login, Dashboard-Raster) kommen sehr wohl
von shadcnblocks Pro — nur die Grundbausteine dieses Pakets nicht, weil shadcnblocks sie nicht führt.

## b) Warum ein `sha256` an der Stelle des Commit-SHA

AGENTS.md verlangt für übernommenen Code den vollen Commit-SHA. Die freie shadcn-Registry liefert keinen:
über alle 20 abgerufenen Einträge dieses Pakets gemessen (jede Registry-URL einzeln geholt, die Schlüssel
der JSON-Antwort gezählt) trägt ein Eintrag zwischen vier und acht Schlüsseln — Verteilung
`{4: 1, 5: 17, 6: 1, 8: 1}` —, und über alle 20 kommen zusammen neun verschiedene Schlüssel vor: `$schema`,
`cssVars`, `dependencies`, `docs`, `files`, `name`, `registryDependencies`, `tailwind`, `type`. Keiner davon
benennt eine Fassung, ein Datum oder einen Commit. An die Stelle der SHA tritt deshalb der `sha256` des
abgerufenen Registry-Eintrags (JSON-Antwort, als `sha256` in der Bestandstabelle unten geführt). Er benennt
dieselben Bytes ebenso eindeutig und wandert ebenso wenig weiter wie ein Commit. Diese Begründung steht hier
einmal und nicht zwanzigmal in den Köpfen der einzelnen Bausteine.

## c) Zu `components.json`

`components.json` in der Repo-Wurzel hält die getroffene Wahl fest (Stil „new-york", CSS-Variablen statt
fester Farben, lucide als Icon-Satz). Sie ist **nicht** für das shadcn-Kommandozeilenwerkzeug tauglich,
weil dieses Projekt keinen `@/`-Alias in `tsconfig.json` hat und die Bausteine von Hand übernommen werden,
nicht über das Werkzeug. Dieser Satz steht hier, damit niemand die Datei später für eine Lüge hält.

## d) Bestand — alle 26 Dateien dieses Ritus

Alle Werte ausgeschrieben, nicht geraten. Maßgebliche Quelle jedes Werts ist die Registry-Antwort selbst,
unter der jeweiligen `Registry-URL` jederzeit erneut abrufbar — nicht eine Datei aus der Sitzung, in der
das jeweilige Paket entstand. Der `sha256` ist der Hash genau dieser abgerufenen Antwort.

**Wichtig:** 19 der ersten 20 Dateien (Paket D2) legt die Basis-Sitzung von D2 (dieses Dokument) **nicht
selbst an** — sie gehören anderen Agenten jenes Pakets. Nur `use-mobile.ts` ist in jener Sitzung entstanden.
Das Register führt den vollen Bestand trotzdem schon, weil es der eine Ort ist, an dem der Bestand steht —
kein Fehler und keine Lüge, sondern der Grund, warum dieses Register einem Agenten gehört und nicht zwanzig.
Für Paket D3 gilt das nicht: alle vier Dateien dieses Pakets (`avatar.tsx`, `breadcrumb.tsx`,
`collapsible.tsx`, `command.tsx`) legt dieselbe Sitzung an, die auch diesen Registereintrag schreibt — hier
gab es keine Aufteilung auf mehrere Agenten.

Die Spalte „Zeilen (Vorlage)" zählt die Registry-Vorlage, nicht die Datei daneben — die Datei im Repo ist um
den Herkunftskopf und die Abweichungen länger als die Vorlage.

| Datei | Baustein | Registry-URL | sha256 | Zeilen (Vorlage) |
| --- | --- | --- | --- | --- |
| `avatar.tsx` | avatar | https://ui.shadcn.com/r/styles/new-york-v4/avatar.json | `f843fc6e2d2fea1337bdcdc8b70c5189f84562d87f8e852e994f4bbdd7cd229d` | 108 |
| `badge.tsx` | badge | https://ui.shadcn.com/r/styles/new-york-v4/badge.json | `0f988b37cf1c56e7ecc83b1dcf24c9af4e73ce4341da5caf2c9d9b07a551319b` | 47 |
| `breadcrumb.tsx` | breadcrumb | https://ui.shadcn.com/r/styles/new-york-v4/breadcrumb.json | `18043f281e20e08fa017a3bba2b2dec462ebba2b0ebf9685b34225cf7b253bfa` | 108 |
| `button.tsx` | button | https://ui.shadcn.com/r/styles/new-york-v4/button.json | `4b8d7d848742727973c1b088af8d15f0b628272a1316f2d2fa344e73ddff9e9c` | 63 |
| `card.tsx` | card | https://ui.shadcn.com/r/styles/new-york-v4/card.json | `c7ebaa49ba2a0613838558f3892c5007523c2dc26d6b36a244145d454a796106` | 91 |
| `chart.tsx` | chart | https://ui.shadcn.com/r/styles/new-york-v4/chart.json | `2ea906f5c8e304dfb81c84e7b2172d13c03a302e183b7195cac24c101dee72e5` | 373 |
| `collapsible.tsx` | collapsible | https://ui.shadcn.com/r/styles/new-york-v4/collapsible.json | `fdc6666e9c728d7e731b0e4d67e11db81020aff47408c259549fc1aefcc8e3e7` | 33 |
| `command.tsx` | command | https://ui.shadcn.com/r/styles/new-york-v4/command.json | `c1f02d0805a0c5c55428e3350214ca8150a4ce98a40ec962118ec66709f60038` | 184 |
| `context-menu.tsx` | context-menu | https://ui.shadcn.com/r/styles/new-york-v4/context-menu.json | `e9680a7b71840b7203e1625acab8754d7c18122b66289baf281c3a6e31246ada` | 252 |
| `dialog.tsx` | dialog | https://ui.shadcn.com/r/styles/new-york-v4/dialog.json | `0115e3a57aa55a978c5fed0d77f7e98edd694215aae3e569def3fff722ba9f26` | 158 |
| `dropdown-menu.tsx` | dropdown-menu | https://ui.shadcn.com/r/styles/new-york-v4/dropdown-menu.json | `235b1231cf71d94225eccd6c19117e7fa7b09cf256d23a199d63aee53265fd52` | 256 |
| `input.tsx` | input | https://ui.shadcn.com/r/styles/new-york-v4/input.json | `b1fffa12ba72ce30a291749012b47235eda110648b8106725ced22b5b31c8f1b` | 20 |
| `label.tsx` | label | https://ui.shadcn.com/r/styles/new-york-v4/label.json | `b03d6bc91da205758df87c5403d74bae4d742f1f4ac5ae0b94ad7a29ab6350ea` | 23 |
| `radio-group.tsx` | radio-group | https://ui.shadcn.com/r/styles/new-york-v4/radio-group.json | `299fa36d5c5df3aefa40a59d8d3f92a1ccc9feae6b5187135851d9846348f1af` | 44 |
| `select.tsx` | select | https://ui.shadcn.com/r/styles/new-york-v4/select.json | `ca3189ea8101a04f144b6d0f0e7330841639bfa5f4d57e7cca0894d39b30817b` | 189 |
| `separator.tsx` | separator | https://ui.shadcn.com/r/styles/new-york-v4/separator.json | `4242a9fe839cae9083acff1280b7cccfda10e97bbc83283aed12d2d12bebdc6a` | 27 |
| `sheet.tsx` | sheet | https://ui.shadcn.com/r/styles/new-york-v4/sheet.json | `bdf118300491675f05a9181af491217ba690929338aefd108437c2b07d25432f` | 142 |
| `sidebar.tsx` | sidebar | https://ui.shadcn.com/r/styles/new-york-v4/sidebar.json | `421f1735955361a12466c5c6e7d4c1124cc7f76422b4fdd5dcdf8451b8ae4052` | 726 |
| `skeleton.tsx` | skeleton | https://ui.shadcn.com/r/styles/new-york-v4/skeleton.json | `1ed4d99f9d632d9697a054eefcd19932abd68cef7808407986f6e14da401edf7` | 13 |
| `slider.tsx` | slider | https://ui.shadcn.com/r/styles/new-york-v4/slider.json | `99f6044fa83df91dfda17d3cc57cf5297c3759d57fd483665e518e4961208e73` | 62 |
| `sonner.tsx` | sonner | https://ui.shadcn.com/r/styles/new-york-v4/sonner.json | `439c5d5256091829350d3136309f55f8ba788f1cc0f0dbad016ce6b5b2765488` | 40 |
| `switch.tsx` | switch | https://ui.shadcn.com/r/styles/new-york-v4/switch.json | `cc526c3a4827be315be746355a988e22dacc99d663ed31924fd30c2507cdc005` | 34 |
| `table.tsx` | table | https://ui.shadcn.com/r/styles/new-york-v4/table.json | `35a45f90ee92883533c4c1029212d38bd263694e90ea54fbfaf66a099f7d3cc4` | 115 |
| `tabs.tsx` | tabs | https://ui.shadcn.com/r/styles/new-york-v4/tabs.json | `49320e6dcf56570753bb14ed3f5d66acf07d12e183c0e9024466995b25be5b1d` | 90 |
| `tooltip.tsx` | tooltip | https://ui.shadcn.com/r/styles/new-york-v4/tooltip.json | `1b7b452b34beab05b22bd653963abd1c88ebd8e9ebcc89dcaebf4ac4938c929e` | 56 |
| `use-mobile.ts` | use-mobile | https://ui.shadcn.com/r/styles/new-york-v4/use-mobile.json | `4cd4736a08751c89e2ebc10f9d329c430ddb6194f46bf848e5ed470c0407bca1` | 19 |

`context-menu.tsx` kam am 2026-09-29 für das Kontextmenü an der Stack-Zeile der Übersicht dazu. Schritt 1 der
Reihenfolge aus AGENTS.md lief mit dem Schlüssel aus der Umgebung: `GET
https://www.shadcnblocks.com/r/context-menu.json` antwortete `404`, dieselbe Anfrage auf `hero1.json` mit
demselben Schlüssel `200` — derselbe Befund wie in Abschnitt a), also Schritt 3.

## e) Abweichungen, die für mehrere Dateien gelten

1. `"use client"` entfernt — eine Next.js-Anweisung, in einer Vite-Anwendung ohne Bedeutung.
2. `import { cn } from "cn"` auf `../lib/cn` gezogen — Registry-Platzhalter (siehe `web/src/platform/ui/lib/cn.ts`).
3. `@/registry/...`-Importe auf relative Pfade gezogen — dieses Projekt hat keinen `@/`-Alias. Das betrifft
   **zwei** Dateien, nicht nur eine: `dialog.tsx` (`@/registry/new-york-v4/ui/button` → `./button`) und
   `sidebar.tsx` (sieben Importe, `@/registry/new-york-v4/ui/X` → `./X` und
   `@/registry/new-york-v4/hooks/use-mobile` → `./use-mobile`).
4. In `sonner.tsx`: `next-themes` entfernt. Der Baustein liest dort das Thema; diese Anwendung ist
   dunkel-zuerst und hat kein `next-themes`. Ein Next.js-Paket für eine Zeile wäre die falsche Abhängigkeit.
   Stattdessen fest `theme="dark"`, mit einem Kommentar, dass Paket D7 (Theme-Editor, #62) daran die
   Theme-Einstellung hängt.
5. In `skeleton.tsx`, `sonner.tsx` und (Paket D3) `collapsible.tsx`: einen `React`-Import ergänzt — alle
   drei benutzen `React.` ohne den Import (gemessen), was in einem Next.js-Projekt die Voreinstellung trägt
   und hier `tsc --noEmit` umwirft. Die Form unterscheidet sich: `skeleton.tsx` und `collapsible.tsx`
   benutzen `React.ComponentProps` als Parametertyp einer Funktionssignatur, `import * as React from
   "react"` (gemessen: `skeleton.tsx` importiert nichts weiter aus `react`; `collapsible.tsx` trägt
   `React.ComponentProps` an drei Stellen und sonst nichts aus `react`); `sonner.tsx` benutzt
   `React.CSSProperties` ausschließlich als Typ innerhalb einer Typzusicherung, deshalb dort
   `import type * as React from "react"` (gemessen: `grep -n 'as React' web/src/platform/ui/shadcn/sonner.tsx`
   zeigt keine andere Verwendung).
6. In `sidebar.tsx`: die englischen Kommentare im Rumpf auf Deutsch gezogen — 12 Zeilen an 10 Stellen
   (gezählt mit `grep -n '//\|{/\*'` an der Vorlage; zwei Stellen sind zweizeilig). `sidebar.tsx` ist die
   einzige der 20 Dateien mit Kommentaren im Rumpf (gemessen).
7. In `dialog.tsx`, `sheet.tsx`, `sidebar.tsx` und (Paket D3) `breadcrumb.tsx` sowie `command.tsx`:
   sichtbarer und vom Screenreader vorgelesener Text (`sr-only`-Spans, Beschriftungen, `aria-label`,
   `title`, und in `command.tsx` die Auflösung von zwei Parametern, die ebenfalls über ein
   `sr-only`-Element vorgelesen werden) über `useTranslations()` aus `use-intl` und Schlüssel aus
   `web/src/platform/i18n/messages/de.ts` geführt, statt fest im JSX zu stehen — dieses Projekt führt UI-Texte nicht im
   Code (web/tests/ui-texts.test.mjs), und ein Screenreader läse den englischen Registry-Text sonst
   unverändert vor. Ursprünglich (D2/D3) lief das über das projekteigene Modul `web/src/i18n` (seit #255 `web/src/platform/i18n`); Issue #70
   zieht es auf den Hook der Sprachbibliothek. `use-intl` selbst steht deshalb in
   `web/tests/vendored-origin.test.mjs` unter `FRAMEWORK_PACKAGES`, nicht unter `RITUAL_PACKAGES`: es ist
   Rahmenwerk dieser Abweichung, keine Abhängigkeit, die der Registry-Eintrag eines Bausteins selbst
   nennt — derselbe Grund, aus dem dort `react`/`react-dom` stehen.
8. In `sidebar.tsx`, `SidebarMenuSkeleton`: die zufällige Breite von `React.useMemo` auf
   `React.useState(() => …)` gezogen. Die Vorlage würfelt mit `Math.random()` innerhalb eines `useMemo`;
   die ESLint-Regel `react-hooks/purity` (aus `eslint-plugin-react-hooks`, `eslint.config.mjs`) weist das
   zu Recht zurück — React darf ein `useMemo` jederzeit verwerfen und neu berechnen, die Breite spränge
   dann. Der Erzeuger von `useState` läuft garantiert genau einmal.
9. (Paket D3) `breadcrumb.tsx` bringt gemessen kein `"use client"` mit — anders als die übrigen 23 Dateien
   dieses Registers, die entweder eins entfernt bekamen oder (wie `badge.tsx`) es schon nicht führten.
   Abweichung 1 trifft auf diese Datei deshalb nicht zu; es gibt hier nichts zu entfernen.
10. (Paket D3) `collapsible.tsx` importiert `cn` gemessen nicht (keine Klassennamen-Zusammensetzung im
    Baustein). Abweichung 2 trifft auf diese Datei deshalb nicht zu.
11. (Paket D3) In `command.tsx`: `title` und `description` von `CommandDialog`
    („Command Palette", „Search for a command to run...") stehen in der Vorlage als Vorgabewerte einer
    Parameterzerlegung (`title = "…"`), nicht als JSX-Attribut oder Textknoten — der in AGENTS.md und im
    Auftrag genannte Suchlauf (`grep -n 'title=\|placeholder='`) fasst diese Stelle deshalb nicht (er
    verlangt `title=` ohne Leerzeichen davor). Sie sind trotzdem derselbe Fall wie Abweichung 7: fest
    verdrahteter englischer Text, der über ein `sr-only`-`DialogHeader` standardmäßig vom Screenreader
    vorgelesen wird, sobald `CommandDialog` ohne eigene `title`/`description`-Prop verwendet wird. Deshalb
    über die Schlüssel `uiCommandPaletteTitle` / `uiCommandPaletteDescription` geführt statt belassen.
    (Issue #70) Ein Hook lässt sich nicht als Vorgabewert einsetzen — er liefe dann nur, wenn die
    aufrufende Stelle die Prop weglässt, ein bedingter Hook-Aufruf. `title`/`description` stehen deshalb
    seither ohne Vorgabewert in der Zerlegung und lösen sich im Rumpf über `title ?? t(...)` auf; der Hook
    `useTranslations()` selbst steht davor, unbedingt, am Kopf der Funktion.

## f) Abweichung gegenüber dem Wortlaut des Issues

Issue #62 nennt `@radix-ui/*` als Abhängigkeit. Die Registry importiert heute aus dem gebündelten Paket
`radix-ui` (`import { Slot } from "radix-ui"`). Wir folgen der Registry.

## g) `cssVars` und `tailwind` im `sidebar`-Eintrag — bewusst nicht übernommen

Der Registry-Eintrag zu `sidebar` trägt zusätzlich zu den fünf Grundschlüsseln zwei Felder, die kein anderer
Eintrag dieses Pakets führt: `cssVars` (feste HSL-Tripel je Farbe, getrennt nach hell/dunkel) und `tailwind`
(eine Erweiterung von `tailwind.config`, die diese Variablen als Farben registriert). Das ist die Bauart von
Tailwind 3. Dieses Projekt fährt Tailwind 4 mit `@theme inline` (`web/src/platform/theme/tokens.css`), hat keine
`tailwind.config`, und seine Farben werden aus einem Farbton abgeleitet statt fest hinterlegt
(`web/src/platform/theme/palette.css`). Beide Felder sind deshalb nicht übernommen — keine Auslassung, sondern eine
Entscheidung. Die Namen, die `sidebar.tsx` tatsächlich benutzt (`sidebar`, `sidebar-foreground`,
`sidebar-border`, `sidebar-ring`, `sidebar-accent`, `sidebar-accent-foreground`), führt
`web/src/platform/theme/tokens.css` zusammen mit `web/src/platform/theme/palette.css` bereits.

## h) Anmerkung der Registry zu `tooltip`, die das nächste Paket betrifft

Der Registry-Eintrag zu `tooltip` trägt ein Feld `docs` mit dem Hinweis, die Anwendung in einen
`TooltipProvider` zu hüllen. `sidebar.tsx` bringt in `SidebarProvider` bereits einen eigenen
`TooltipProvider` mit; wer einen Tooltip außerhalb der Seitenleiste benutzt, braucht einen eigenen
`TooltipProvider` an der Wurzel der Anwendung.

## i) `chart` (#213) — shadcnblocks Pro zuerst, dann die freie Registry

Gemessen am 2026-09-30 mit dem Schlüssel aus der Umgebung (`SHADCNBLOCKS_API_KEY` gesetzt):
`GET https://www.shadcnblocks.com/r/<name>.json` antwortet für `chart`, `charts`, `chart-line` und
`chart-area` jeweils mit `404 {"error":"Block, component, example, or page not found"}` (56 Bytes). Damit
greift Schritt 3 der Reihenfolge wie in Abschnitt a): die freie Registry. Ihr Eintrag misst 11.411 Bytes und
trägt sechs Schlüssel (`$schema`, `name`, `dependencies`, `registryDependencies`, `files`, `type`).

Er nennt als Abhängigkeit `recharts@3.8.0`, und genau diese Fassung steht exakt gepinnt in
`web/package.json` — `recharts` gehört damit zu den Paketen des Ritus
(`web/tests/vendored-origin.test.mjs`, `RITUAL_PACKAGES`). `registryDependencies` nennt `card`; der liegt
schon hier. Die Lizenzen der 28 Pakete, die `recharts` mitbringt (ohne `@types/*`), gemessen am
`license`-Feld ihrer `package.json` unter `node_modules/.pnpm`: 16 MIT, 11 ISC, 1 BSD-3-Clause — kein
Copyleft.

## Form des Herkunftskopfs

Wörtlich diese Form, als erster Block der Datei (Beispiel für `button.tsx`):

```tsx
/**
 * Übernommener Baustein — shadcn/ui.
 *
 * Quelle:      https://ui.shadcn.com/r/styles/new-york-v4/button.json
 * Baustein:    button (Stil „new-york-v4")
 * Bezugsdatum: 2026-09-05
 * sha256:      <64 Hexzeichen, Hash der abgerufenen Registry-Antwort, siehe Bestandstabelle oben>
 *
 * Abweichungen:
 * - `"use client"` entfernt: Next.js-Anweisung ohne Bedeutung unter Vite.
 * - `import { cn } from "cn"` auf `../lib/cn` gezogen: Registry-Platzhalter.
 */
```

Es gehört genau der `sha256` in den Kopf, der zum Abruf **dieser** Datei gehört — der Hash der Registry-Antwort
unter der `Quelle:`-URL, die im selben Kopf steht, nicht die eines Nachbarn. Ein Kopf, der vom Nachbarn
abgeschrieben ist, sieht aus wie ein richtiger und wird von keinem Bau bemerkt — ein Wächter prüft später,
dass kein Hash zweimal vorkommt.
