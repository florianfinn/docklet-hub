# Farbsystem und Gliederung der Oberfläche

Ergebnis der Design-Etappe D0, 2026-09-05. Die Referenz dazu ist
[`mockup/hub-palette.html`](mockup/hub-palette.html) — dort lässt sich jede
Einstellung umschalten und ansehen. Hier steht, warum sie so gewählt ist.

Die Grundlage ist [`mockup/color-system.html`](mockup/README.md): eine Zahl
`--h` je Palette, alles Weitere daraus gerechnet. Was der Canvas je Modul des
Hauptdashboards vergibt, braucht im Hub eine eigene Achse — der Hub hat keine
Module.

## 1. Die Achse: Bereich in der Schale, Host im Inhalt

Vier Möglichkeiten wurden gegeneinander gehalten: Palette je Host, je
Menübereich, je Reiter, oder eine einzige Farbe für den ganzen Hub. Gewählt ist
die Verbindung der ersten beiden.

**Warum der Host die Hauptachse trägt.** Der teure Irrtum im Hub ist der auf dem
falschen Arm. Eine Farbe, die den Host benennt, trägt damit die Information,
deren Verwechslung den Schaden macht — im Unterschied zur Reiterfarbe, die nur
sagt, wo man geklickt hat. Dazu kommt ein Bestandsargument: `docker_host` ist
die einzige der vier Kandidaten, die eine stabile Kennung besitzt
(`id text PRIMARY KEY`, `server/src/platform/db/migrations/003-hosts.sql:14`). Reiter,
Bereiche und Stacks existieren im Datenmodell nicht; ihre Kennung müsste erst
erfunden werden.

**Warum die Schale trotzdem Farbe trägt.** Ohne sie bleiben alle Flächen ohne
Hosts — Profil, Einstellungen — vollständig grau. Der Bereich beantwortet „wo
bin ich", der Host „woran arbeite ich". Beide Fragen stellen sich gleichzeitig,
also beantworten sie zwei Ebenen und nicht eine.

**Warum die Schale gedämpft ist.** Trüge die Seitenleiste dieselbe Sättigung wie
eine Host-Karte daneben, stünden zwei Bedeutungen in derselben Farbe. Die Schale
rechnet deshalb mit `calc(--c × 0.32)`, und zwei Farbtöne sind ihr fest
reserviert, damit sie nie an einen Host fallen.

## 2. Vier Ebenen, nach Aufgabe gestaffelt

Je seltener und wichtiger etwas ist, desto kräftiger darf es auftreten. Die
Sättigung `--c` ist dafür der Hebel; der Farbton `--h` bleibt die Kennung.

| Ebene | Sättigung | Töne | Wer vergibt |
| --- | --- | --- | --- |
| Zustand | fest, aus `:root` | 160 in Ordnung, 85 Achtung, 22 Ausfall | das System |
| Host | `--c × 1.3`, gedeckelt bei 0.215 | Vorrat 62, 130, 195, 255, 300, 350 | der Betreiber |
| Eigene Marke | `--c × 0.5` | derselbe Vorrat, dazu ein grauer Ton | der Betreiber |
| Bereich | `--c × 0.32` | 225 Betrieb, 325 Profil und Einstellungen | fest vergeben |

Der Vorrat folgt aus dem Farbtonkreis des Artboards (`color-system.html`,
Z. 347–417): elf benannte Positionen, davon drei an Zustände vergeben und damit
gesperrt, zwei den Bereichen reserviert, sechs frei für Hosts.

**Bernstein trägt zwei Rollen.** Als Punkt bedeutet er einen kranken Container,
als gefülltes Label „Update verfügbar". Beides gehört derselben Bedeutungsklasse
an — Aufmerksamkeit ohne Ausfall — und wird durch die Form unterschieden, nicht
durch den Ton.

**Zwei Deckungsstufen über dem Artboard.** `--accent` liegt dort bei 13 %
(Z. 38). Auf dem dunklen Grund trägt das keine Fläche. Ergänzt sind deshalb
`--accent-firm` (22 %) und `--accent-strong` (34 %); die Formel bleibt
unverändert, nur die Deckung wächst.

## 3. Systemmarke und eigene Marke

Zwei Arten von Beschriftung, die nicht verwechselt werden dürfen:

- **Systemmarken** vergibt der Hub aus dem, was der Agent meldet: „Update",
  „neu", „zu alt". Sie sind gefüllt, weil sie eine Handlung nahelegen, und sie
  gehören nicht in den Theme-Editor.
- **Eigene Marken** vergibt der Betreiber an einen Stack oder an einen einzelnen
  Container. Sie sind getönt statt gefüllt, laufen auf halber Sättigung und
  ordnen nur. Eine Marke darf auch grau sein.

Der Unterschied gehört ins Bauteil, nicht allein in die Farbe: sonst hängt die
Unterscheidung an einer Farbwahl, die der Editor jederzeit ändern kann.

## 4. Was der Editor anbietet

Jede Stellschraube ist bei shadcn eine CSS-Variable, also per Preset
umschaltbar, ohne Markup anzufassen.

| Stellschraube | Stufen | Umfang |
| --- | --- | --- |
| Farbton | die sechs freien Töne, dazu Neutral | je Host, je Marke |
| Sättigung | 0.055 zurückhaltend, 0.145 normal, 0.19 kräftig | global |
| Farbeinsatz am Host | keine Farbe, nur Kante, Kopf getönt, ganze Karte | je Host |
| Darstellung einer Marke | Label, getönte Fläche | je Marke |
| Einrückung der Container eines Stacks | eingerückt, flach | je Stack |
| Schriftart | IBM Plex als Datei, Systemschrift | global |
| Rundung | 4 px kantig, 8 px weich, 12 px rund | global |
| Dichte | 15 px / 1.55 normal, 14 px / 1.45 kompakt | global |
| Hell und Dunkel | dunkel, hell | global |
| Diagrammfarben | Drehung wie im Artboard, einfarbig | global |
| Fokusring | aus `--h`, neutral | global |

Drei Angaben aus der früheren Entscheidung haben im Artboard keine Entsprechung und sind deshalb neu
gefasst: eine Variable `--radius` existiert dort nicht (statt ihrer zehn feste
px-Werte, am häufigsten 7, 9 und 8 px); einen Schlagschatten gibt es nicht (der
einzige `box-shadow` ist die Reiterunterkante), und `--sunk` ist deckend, kann
also kein Glas tragen; ein `:focus`-Stil fehlt vollständig, obwohl `--ring`
definiert ist. Rundung, Flächentiefe und Fokusring sind damit Neuentwürfe und
keine Übernahmen.

Nicht im Editor: die drei Zustandsfarben, Anordnung und Reihenfolge der
Bereiche, das Icon-Set.

## 5. Die Gliederung: Stacks zuerst

Ein Stack ist die Einheit, in der ein Dienst betrieben wird; ein einzelner
Container ist selten für sich interessant. Die Reihenfolge folgt daraus:

- **Übersicht** führt Stacks, gruppiert nach Host, dazu die Container ohne
  Stack. Sie ist die Fläche, die nach der Anmeldung erscheint.
- **Container** ist der Deepdive: jeder Container einzeln, nach Host geordnet,
  die Container eines Stacks eingerückt unter ihm.
- **Die Seite eines Stacks** trägt die Farbe ihres Hosts und die Marke des
  Stacks. Zu ihr gehört, was den ganzen Stack betrifft: die Container-Liste,
  das Protokoll aller Container in einem Strom, die Compose-Datei, gemeinsame
  Variablen und Netze, Start und Stopp. Was je Container gilt, hängt eine Ebene
  tiefer.

**Der Zustand wird zusammengefasst.** In der Übersicht bestimmt der schlechteste
Container die Farbe seines Stacks: ein ausgefallener färbt ihn rot, ein kranker
bernstein, sonst bleibt er grün. Daneben steht die Zahl der laufenden Container.
Auf der Stack-Seite und im Deepdive gilt wieder jeder Container für sich.

Diese Regel ist Logik und kein Design. Sie gehört in den Server und braucht
einen Test, der genau den Fall prüft, der ohne sie falsch beantwortet würde: ein
Stack mit sieben laufenden und einem ausgefallenen Container.

**Verwaltung hängt am Profil.** Benutzer und eigenes Profil liegen auf einer
Fläche, Einstellungen auf einer zweiten; beide erreicht man über das
Namensschild unten links, nicht über die Navigation. Der Hub läuft lokal, ein
Administrator legt weitere Konten selbst an — ein Einladungsweg über E-Mail
ergibt hier keinen Sinn.

## 6. Was daraus für die Ablage folgt

- **Host:** ein Farbton und eine Stufe des Farbeinsatzes je Datensatz in
  `docker_host`. Zwei Spalten.
- **Eigene Marke:** ein Name, ein Farbton, eine Darstellungsart. Ein eigener
  Datensatz.
- **Zuordnung einer Marke:** Stacks und Container besitzen im Hub keine
  Kennung — sie kommen flüchtig aus der Antwort des Agenten
  (`server/src/domain/containers/containers.ts:42`). Die Zuordnung hängt deshalb am Paar aus
  Host-Kennung und Compose-Projekt beziehungsweise Containername.
- **Stack:** Marke und Einrückung je Stack, an derselben Kennung.
- **Darstellung im Ganzen:** Sättigung, Schrift, Rundung, Dichte, Schema als
  Einstellung des Hubs, die ein Administrator schreibt und alle lesen.

Alles davon zusammen ist eine Migration, die es im Schema bisher nicht gibt;
`docker_host` trägt kein Feld für Darstellung
(`grep -rn "color" server/src/platform/db/` ohne Treffer, gemessen 2026-09-05).

## 7. Folgen für den Zuschnitt der Pakete

Gegenüber der früheren Entscheidung verschiebt sich zweierlei. D6 baut die **Stack-Übersicht** statt
der Container-Liste; die Container-Liste wird die zweite Fläche desselben
Pakets. Und die Seite eines Stacks kommt hinzu: ihre Übersicht gehört zur
Oberfläche vor Phase 5, ihre Reiter für Protokoll, Compose und Betrieb gehören
zu Phase 5, weil dort der Schreibzugriff entsteht.

## 8. Abbildung auf die shadcn-Token

Die Grundwerte aus `color-system.html` tragen im Mockup eigene Namen. Die
Übersetzung in die shadcn-Konvention, mit der der Editor aus Abschnitt 4
arbeitet, ist eine reine Umbenennung — kein Wert ändert sich dabei:

| Mockup | shadcn-Token |
| --- | --- |
| `--bg` | `--background` |
| `--card` | `--card` |
| `--card2` | `--popover` und `--secondary` |
| `--sunk` | `--muted` |
| `--fg` | `--foreground` |
| `--fg2` | `--muted-foreground` |
| `--fg3` | `--subtle-foreground` |
| `--line` | `--border` |
| `--line2` | `--input` |

`--subtle-foreground` ist der einzige Name ohne Vorbild im Mockup: die
shadcn-Konvention kennt nur zwei Textstufen, das Artboard führt drei, und für
die dritte gibt es in der Zielsprache schlicht kein Wort.

**Warum die Ableitung auf einer Selektorliste steht.** Eine CSS-Variable löst
sich dort auf, wo sie deklariert ist, nicht wo sie benutzt wird — eine Formel
wie `--primary: oklch(0.78 var(--c) var(--h))` rechnet mit dem `--h` des
Elements, das die Formel selbst trägt, nicht mit dem des Elements, das sie
später über die Vererbung liest. Damit ein Host, eine Marke und ein Bereich
je ihren eigenen Farbton bekommen, muss dieselbe Formel auf jedem Element
stehen, das eine eigene Palette führen kann — deshalb steht sie in einer
einzigen Regel mit der Selektorliste `:root, [data-hue], [data-host],
[data-area], [data-mark]`, und Farbton sowie Sättigung folgen danach in
eigenen Regeln gleicher Spezifität. Die Reihenfolge im Stylesheet
entscheidet dabei nur dort, wo dieselbe Eigenschaft zweimal bei gleicher
Spezifität deklariert wird — Ableitung und Tonvorrat etwa deklarieren
verschiedene Eigenschaften, ein `var()` löst träge am Benutzungsort auf und
nicht in Schreibreihenfolge, ein Tausch zwischen ihnen ändert am Rendering
nichts. Das betrifft genau drei Paare: `--c` (`:root` gegen `[data-host]`,
`[data-mark]`, `[data-area]`), die vier Flächenvariablen `--head-face`,
`--body-face`, `--mark-face`, `--mark-line` (die Ableitungsregel gegen
`[data-ink]` und `[data-mark-style]`), und die Stellschrauben `--chroma`,
`--radius`, `--density-size`, `--density-leading`, `--stack-indent`
(`:root` gegen die Umschalter in `tokens.css`). Bei diesen dreien gilt: wer
zuletzt im Stylesheet steht, gewinnt.

**Warum `@theme inline`.** Ohne das Schlüsselwort erzeugt Tailwind für jede
Farbe eine eigene Zwischenvariable, deklariert auf `:root` (und `:host`) —
aus `--color-primary: var(--primary)` wird dort eine `:root`-Deklaration,
und die Hilfsklasse schreibt nur noch `background-color:
var(--color-primary)`. Das ist keine Tailwind-Eigenheit, sondern zum
zweiten Mal dieselbe Regel von oben: `var(--primary)` löst sich an der
Stelle auf, an der `--color-primary` deklariert ist — also an `:root`, mit
dessen eigenem `--primary`, unabhängig davon, was ein Nachfahre
überschreibt. Der fertige Wert vererbt sich danach nur noch als fixe Farbe
nach unten; eine Palette, die auf `[data-host]` oder einem anderen
Nachfahren umgeschaltet wird, kommt nicht mehr an. Mit `inline` entsteht
keine Zwischenvariable: die Hilfsklasse schreibt `var(--primary)` direkt in
die Regel und löst damit am benutzenden Element auf, wo der jeweils nächste
Vorfahre mit einer eigenen Palette gilt.

Hell bleibt hier ausgeklammert: ein heller Wertesatz ist kein zweiter Blick
auf dieselben Zahlen, sondern verlangt einen eigenen Kontrasttest gegen den
hellen Grund, und dieser Test gehört zu D7.
