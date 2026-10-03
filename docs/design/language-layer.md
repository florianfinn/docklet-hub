# Die Sprachschicht der Oberfläche

Die Oberfläche trägt zwei Sprachen, Deutsch und Englisch. Dieses Dokument
trägt die Begründung der Entscheidungen dahinter — welche Bibliothek, welches
Nachrichtenformat, wo die Sprache eines Menschen liegt und wer sie ändern
darf. Wo die Arbeit steht, sagt das zugehörige Issue, nicht diese Datei.

Die Regel, aus der alles folgt, steht in AGENTS.md: sichtbarer Text steht
nicht im Code, sondern in Sprachdateien. Sie galt von der ersten Zeile an und
hat genau einen Grund — ein Text, der einmal im JSX steht, wird beim
nachträglichen Herauslösen nie vollständig gefunden. Was hier beschrieben ist,
ist deshalb kein Umbau, sondern die zweite Hälfte einer Entscheidung, die
schon getroffen war: eine Sprachdatei ohne zweite Sprache ist eine Zusage auf
Vorrat.

## 1. `use-intl` statt `next-intl`

Der Betreiber nannte `next-intl`. Die Fassung ist dieselbe, der Autor ist
derselbe, der Nachrichtenvertrag ist derselbe — der Rahmen nicht. Gemessen am
2026-09-05:

```
npm view next-intl@4.14.2 peerDependencies
→ { next: '^12.0.0 || ^13.0.0 || ^14.0.0 || ^15.0.0 || ^16.0.0',
    react: '^16.8.0 || ^17.0.0 || ^18.0.0 || >=19.0.0-rc <19.0.0 || ^19.0.0' }

npm view use-intl@4.14.2 peerDependencies
→ { react: '^17.0.0 || ^18.0.0 || >=19.0.0-rc <19.0.0 || ^19.0.0' }
```

`next-intl` verlangt Next.js als Peer. Dieses Repo baut mit Vite
(`web/vite.config.ts`), und Next.js dazuzuholen, um eine Sprachbibliothek zu
benutzen, wäre ein Rahmenwechsel als Nebenwirkung einer Textentscheidung.
`use-intl` ist der Kern derselben Bibliothek ohne die Next.js-Hülle: dieselben
Hooks (`useTranslations`, `useLocale`, `useFormatter`), dieselbe
Modul-Erweiterung `AppConfig`, dasselbe ICU-Format. Lizenz gemessen
(`npm view use-intl@4.14.2 license`): MIT, passt zur Lizenzregel aus
AGENTS.md.

Die Fassung ist ohne Zirkumflex eingetragen (`"use-intl": "4.14.2"`), wie
`cmdk`, `sonner` und `radix-ui` daneben. Eine Sprachbibliothek, deren Fassung
fließt, ändert Zahlformate, Pluralregeln und die Auflösung von Schlüsseln,
ohne dass ein Commit das zeigt — und ein fließender Stand hat keinen Punkt,
auf den man zurückgehen kann.

## 2. ICU statt einer Zuordnung Schlüssel → Zeichenkette

Die naheliegende Lösung wäre ein Objekt je Sprache und `texte[schlüssel]`
darin. Das trägt genau so lange, wie kein Text eine Zahl enthält.

Die Übersicht enthält welche, und zwar von Anfang an: die Kopfzeile des
Container-Moduls zeigt „3 Hosts · 34 verwaltet · 31 laufen · Stand vor 40
Sekunden" ([`mockup/container-module.html`](mockup/README.md), Z. 137), und
neben jedem Stack steht die Zahl seiner laufenden Container
([`hub-color-and-structure.md`](hub-color-and-structure.md) §5). Sobald eine
Zahl im Text steht, gehen drei Dinge auseinander, die im Deutschen zufällig
zusammenfallen:

- **Plural.** Deutsch und Englisch haben je zwei Formen, aber nicht an
  denselben Stellen, und Sprachen mit mehr als zwei Formen sind der Regelfall,
  nicht die Ausnahme. Eine selbstgebaute Abfrage `n === 1 ? … : …` ist die
  englische Regel, in jede Sprache hineingeschrieben.
- **Zahlformat.** `1.234` ist im Deutschen tausendzweihundertvierunddreißig
  und im Englischen eins Komma zwei drei vier. Wer das mit `String(n)` löst,
  hat den Fehler nicht gemacht, sondern verschoben.
- **Wortstellung.** Der Platz der Zahl im Satz ist je Sprache verschieden.
  Eine Zusammensetzung aus Bruchstücken an der Aufrufstelle nimmt der
  Übersetzung genau die Freiheit, die sie braucht.

ICU beantwortet alle drei in der Sprachdatei statt im Code, und die
Bibliothek, die es liest, kommt ohnehin mit — das ist der Grund, sie
überhaupt zu holen. Eine Zuordnung Schlüssel → Zeichenkette wäre eine
Abhängigkeit weniger und der Anfang einer eigenen kleinen
Formatierungsbibliothek.

Der Vertrag zwischen Sprachdateien und Bibliothek liegt in einer
Modul-Erweiterung (`web/src/app/i18n/use-intl.d.ts`) und nicht in einem eigenen
Typnamen. Der Gedanke dahinter ist älter als dieses Paket und stand vorher in
`web/src/platform/i18n/index.ts`: der Typ der ersten Sprache ist der Vertrag für jede
weitere. Neu ist nur, dass er auf jeden `t(…)`-Aufruf wirkt statt auf eine
Zuweisung. Gemessen am 2026-09-05, jeder Fall einzeln gegen
`npx tsc --noEmit`:

| absichtlicher Fehler | Meldung |
| --- | --- |
| `t("gibtsNicht")` | TS2345 |
| Übersetzung mit fehlendem Schlüssel | TS2740 |
| Übersetzung mit überzähligem Schlüssel | TS2353 |

Der dritte Fall fällt nur, wenn die Sprachdatei ihr Objekt mit
`satisfies typeof de` abschließt — TypeScript prüft überschüssige
Eigenschaften am Objektliteral, nicht an einer Zuweisung.

## 3. Die Sprache liegt im Konto, nicht im Browser

Drei Orte kamen in Frage: der Browser (`localStorage`), die Adresse
(`/de/…`, `/en/…`) und das Konto.

**Die Adresse fällt zuerst.** Sie ist der Ort für öffentliche Seiten, die in
einer bestimmten Sprache gefunden werden sollen. Dieses System hat keine
öffentlichen Seiten; hinter der Anmeldung liest kein Suchdienst mit, und jeder
Pfad trüge ab dann ein Präfix, das nur eine Einstellung transportiert.

**Der Browser fällt am Zweck.** Eine Spracheinstellung gehört zu einem
Menschen, nicht zu einem Gerät. Dass es hier mehrere Menschen geben wird, ist
keine Vermutung, sondern Entwurfsvorgabe: „jemand anderes soll dieses Repo in
seinem eigenen Netz betreiben können"
([`concept-and-plan.md`](concept-and-plan.md) §1, zweites Ziel), und ein
Administrator legt weitere Konten selbst an
([`hub-color-and-structure.md`](hub-color-and-structure.md) §5). Genau daher
kommt die zweite Sprache überhaupt — ein System, das nur beim Autor läuft,
bräuchte sie nicht.

Läge die Sprache im Browser, wäre sie eine Eigenschaft der Maschine: zwei
Menschen an demselben Rechner teilten sie sich, und ein Mensch an zwei
Rechnern träfe dieselbe Wahl zweimal und fände sie an keinem wieder.

**Das Konto bleibt.** Die Sprache reist mit der Sitzung
(`SessionUser.language`) und wird über `PUT /api/session/language` geändert.
Der Browser ist damit nicht bedeutungslos: er beantwortet die Frage, solange
niemand angemeldet ist. `navigator.languages` trägt die Reihenfolge, in der
jemand seine Sprachen bevorzugt, und genau diese Reihenfolge ist die Antwort —
verglichen wird der Sprachanteil (`de-AT` → `de`), Regionen unterscheidet
diese Oberfläche nicht. Findet sich keine, gilt Deutsch.

## 4. `adopt` und `change` sind zwei Vorgänge

Der Kontext der Sprachschicht bietet zwei Funktionen an, die beide die Sprache
setzen und sich in genau einem Punkt unterscheiden: die eine schreibt zurück,
die andere nicht.

- `adopt(language)` übernimmt, was der Server ohnehin weiß. Die Anmeldung
  liefert die Sprache des Kontos mit; die Oberfläche stellt sich darauf ein.
- `change(language)` ist der Umschalter. Er setzt und speichert.

Eine Funktion mit einem Schalter `persist` wäre kürzer und dieselbe
Verwechslung. Der Grund ist nicht Geschmack, sondern die Richtung des
Schadens: `adopt` mit versehentlichem Schreiben schriebe bei jeder Anmeldung
die Einstellung zurück, die es gerade gelesen hat. Solange sie stimmt, fällt
das niemandem auf. Es fällt auf, wenn eine Anmeldung eine veraltete Sitzung
mitbringt — dann überschreibt der Lesevorgang die Wahl, die der Mensch
zwischendurch getroffen hat. Zwei Namen für zwei Vorgänge machen den Fehler
sichtbar, ein vergessenes `persist: false` sieht auf dem Bildschirm aus wie
der richtige Fall.

`change` stellt zuerst um und speichert danach: die Oberfläche antwortet auf
den Klick, nicht auf die Antwort des Servers. Scheitert das Speichern, geht
sie zurück **und sagt es**. Ein stiller Rücksprung sähe aus wie ein
klemmender Schalter, und der Mensch versuchte es ein zweites Mal.

## 5. Die Sprachnamen stehen in ihrer eigenen Sprache

Im Umschalter heißt Deutsch „Deutsch" und Englisch „English" — in **beiden**
Sprachdateien gleich, nicht übersetzt.

Der Grund ist die Lage, in der jemand den Umschalter überhaupt sucht: die
Oberfläche steht in einer Sprache, die er nicht liest. Stünden die Namen
übersetzt da, fände ein Engländer in der deutschen Oberfläche den Eintrag
„Englisch" — ein Wort, das er nicht kennt, neben einem Wort, das er nicht
kennt. Der Name einer Sprache ist die einzige Beschriftung im ganzen System,
die für den gilt, der die aktuelle Sprache **nicht** versteht. Sie zu
übersetzen dreht ihren Zweck um.

Der Preis ist eine Doppelung: dieselben zwei Zeichenketten liegen in beiden
Dateien. Das ist gewollt und keine Nachlässigkeit — der Typvertrag aus §2
verlangt jeden Schlüssel in jeder Sprache, und eine Ausnahme dafür wäre ein
Loch in genau der Prüfung, die fehlende Schlüssel findet.

## 6. Vor der Anmeldung gilt die Sprache des Browsers

Der Hub kennt keinen Gastzugang: hinein kommt nur, wer ein Konto hat. Vier
Zustände liegen trotzdem vor jeder Sitzung — das Laden, die Erstanmeldung, die
Anmeldung und die Meldung, wenn der Hub nicht antwortet. In ihnen gibt es kein
Konto, aus dem eine Sprache käme, also nimmt die Oberfläche die des Browsers,
soweit sie eine davon spricht, sonst Deutsch.

Für die Anmeldung bleibt das folgenlos: wer ein Konto hat, sieht das Formular
in seiner Browsersprache und die Oberfläche danach in seiner Kontosprache. Der
Fall löst sich selbst auf, sobald die Sitzung steht.

Wirkung hat es an genau einer Stelle — der **Erstanmeldung**, dem einen
Bildschirm, hinter dem noch überhaupt kein Konto existiert. Wessen Browser
weder Deutsch noch Englisch meldet, sieht ihn auf Deutsch, legt sein Konto an
und stellt danach um.

Ein `localStorage` für diese vier Zustände wäre die Alternative gewesen: der
Umschalter erschiene auch ohne Anmeldung und schriebe in den Browser, bis ein
Konto da ist. Dagegen spricht, dass er einen zweiten Speicherort für dieselbe
Einstellung schafft — und damit die Frage, welcher gilt, wenn beide sich
widersprechen. Ein Mensch, der im Browser Englisch gewählt hat und sich an
einem Konto mit Deutsch anmeldet, bekommt eine Antwort, die jemand festlegen
muss; jede der beiden möglichen ist an einer Stelle falsch. Die Browsersprache
allein hat diese Frage nicht: sie gilt, bis ein Konto etwas anderes sagt, und
dann gilt das Konto.
