# Anmeldung und Erstanmeldung

Die beiden Bildschirme, die vor jeder Sitzung liegen: die Anmeldung und die
Erstanmeldung, die es genau einmal im Leben eines Hubs gibt. Dieses Dokument
trägt die Begründung dahinter — warum sie auf einem gemeinsamen Rahmen sitzen,
warum eine Datei dafür gelöscht statt danebengelegt wurde, warum der
Sprachumschalter davor nichts speichert und warum der Grund eine gerechnete
Fläche ist und keine Animation. Was daran gerade Arbeit ist, sagt das
zugehörige Issue, nicht diese Datei.

Vorlage sind die Artboards des Design-Canvas (`Main.dc.html`,
`Anmeldung.dc.html`, `AnmeldungFehler.dc.html`); gebaut ist aus den
shadcn-Bausteinen und den Token der vorangegangenen Design-Etappen. Die
Sprachschicht darunter begründet [`language-layer.md`](language-layer.md), die
Palette [`hub-color-and-structure.md`](hub-color-and-structure.md).

## 1. Ein Rahmen für zwei Bildschirme — und eine gelöschte Datei

Beide Bildschirme zeigen dasselbe Gerüst: Markenblock, Karte mit Titel und
Formular, Fußzeile mit Fassung und Sprachumschalter, darunter der Grund. Das
liegt in einem Bauteil (`AuthCard`), und die Bildschirme liefern nur ihre
Felder.

Bis hierher tat das `web/src/screens/form.tsx` — `FormShell` plus die Hilfen
`Field`, `inputClassName` und `buttonClassName`, alles rohes Markup. Der
Kopfkommentar dieser Datei sagte selbst, wozu sie da war: eine Übergangslösung,
solange die Token-Konvention noch nicht feststand, und sie solle „ersetzt
werden, nicht wachsen".

**Warum gelöscht und nicht danebengelegt.** Ein zweiter Rahmen neben dem ersten
kostet nichts an dem Tag, an dem er entsteht, und alles danach: jede spätere
Änderung an einem Formular fängt mit der Frage an, welcher der beiden Rahmen
gemeint ist, und die Antwort hängt daran, welchen Import die Datei zufällig
trägt. Eine Übergangslösung, die den Übergang überlebt, ist keine mehr, sondern
eine zweite Bauart.

**Der dritte Verwender.** Der Schnitt dieses Pakets nannte zwei Verwender von
`form.tsx` — die beiden Anmeldebildschirme. Es waren drei:
`web/src/features/hosts/HostForm.tsx` holte von dort `Field`, `inputClassName`
und `buttonClassName`. Gefunden hat ihn der Wächter, der zuerst und aus dem
Vertrag geschrieben wurde: seine Prüfung „keine Datei importiert `./form`" zeigt
auf jede Fundstelle, nicht auf die erwarteten. Wer die Datei gelöscht und nur
die beiden Anmeldebildschirme umgebaut hätte, hätte einen Bildschirm gebrochen,
der mit der Anmeldung nichts zu tun hat.

**Warum `HostForm` mitgenommen wurde und nicht die Hilfen verschoben.** Die
Hilfen in den Hosts-Ordner zu schieben wäre die kleinere Änderung gewesen und
hätte genau das am Leben gehalten, was der Kopfkommentar beerdigt sehen wollte:
ein `label` um alles, drei Klassenkonstanten, kein Baustein. Der Hub hätte
danach zwei Formularsprachen im selben Baum gehabt, ohne dass irgendwo stünde,
welche gilt.

Der Preis ist eine angefasste Datei außerhalb des Pakets, und die Grenze dafür
ist eng gezogen: dieselben drei Felder, dieselben Rückrufe, dieselben Texte,
dieselbe Reihenfolge — getauscht ist nur das rohe Markup gegen `Label`, `Input`
und `Button`. Das Auswahlfeld bleibt ein `select` des Browsers; der
Radix-Aufklapper aus der Bausteinsammlung brächte Tastaturführung, Portal und
eigenen Zustand mit, und das wäre die Umgestaltung, die dieser Umbau
ausdrücklich nicht ist.

**Warum in `AuthCard` keine `Field`-Hülle entstanden ist.** Ein Bauteil, das
`Label` und `Input` zusammen einpackt, ist genau die Zwischenschicht, an der
`form.tsx` gewachsen war: es muss jede Eigenschaft beider Bausteine
durchreichen, sobald ein Bildschirm etwas anderes braucht. Geteilt wird
deshalb nur die Typografie der Beschriftung, als exportierte Klassenkonstante.
Die Verbindung von Beschriftung und Feld setzt jeder Bildschirm selbst über
`htmlFor` und `id` — der `Label`-Baustein ist `LabelPrimitive.Root` und
umschließt sein Feld nicht, anders als das abgelöste `Field`.

**Die Landmarke `main` sitzt in `AuthCard`.** Die zustandslose Schale setzt
bewusst keine; wer darin steht, bringt sie mit. Bisher tat das `FormShell` —
ohne diese eine Zeile hätte das Dokument in genau den zwei Zuständen
„Anmeldung" und „Erstanmeldung" keine Hauptlandmarke, und ein Screenreader
fände keinen Einstieg. Genau eine: die beiden Bildschirme im Inneren setzen
keine zweite.

## 2. Der Sprachumschalter vor der Anmeldung speichert nicht

**Warum es ihn überhaupt gibt.** Vor der Sitzung gilt die Sprache des Browsers
([`language-layer.md`](language-layer.md) §6). Für die Anmeldung ist das
folgenlos — wer ein Konto hat, sieht die Oberfläche gleich danach in seiner
Kontosprache. Es hat Wirkung an genau einer Stelle: bei der Erstanmeldung, dem
einen Bildschirm, hinter dem noch überhaupt kein Konto liegt. Wessen Browser
weder Deutsch noch Englisch meldet, bekommt ihn auf Deutsch und hätte ohne
Umschalter keinen Weg, das zu ändern, bevor er sein Konto anlegt. Der
Umschalter ist die Antwort auf diesen einen Fall, nicht ein Komfortangebot.

**Warum er nicht speichert.** Ein zweiter gespeicherter Ort für dieselbe
Einstellung wirft die Frage auf, welcher gewinnt: Wer im Browser Englisch
gewählt hat und sich an einem Konto mit Deutsch anmeldet, bekommt eine Antwort,
die jemand festlegen muss — und jede der beiden möglichen ist an einer Stelle
falsch. Eine Ansicht, die beim nächsten Laden wieder die Browsersprache zeigt,
wirft diese Frage gar nicht erst auf. Sie gilt, bis ein Konto etwas anderes
sagt, und dann gilt das Konto.

**Dass `adopt` gerufen wird und nicht `change`, ist die technische Form
derselben Entscheidung** und kein Umsetzungsdetail. Der Sprachkontext bietet
beide an, und sie unterscheiden sich in genau einem Punkt: `change` schreibt
über `PUT /session/language` ans Konto und setzt damit eine Sitzung voraus —
vor der Anmeldung gibt es keine, der Aufruf endete in einer 401, während die
Oberfläche fröhlich umspränge und niemand den Fehler sähe. `adopt` stellt die
laufende Ansicht um und schreibt nichts.

Beide kompilieren, beide sehen auf dem Bildschirm richtig aus, und der falsche
fällt erst dem auf, der die Konsole offen hat. Deshalb hängt an dieser Zeile
ein eigener Wächter: er liest `AuthCard.tsx` und verlangt `adopt` und
nirgends `change`. Eine Zusage, die nur im Kommentar steht, ist eine Bitte.

Der Preis ist ein vergesslicher Umschalter: Wer die Anmeldung neu lädt, sieht
wieder die Browsersprache. Für den Weg, für den er gebaut ist — Sprache
umstellen, Konto anlegen, danach die Kontosprache — reicht die Dauer eines
Ladens.

## 3. Der Grund ist ein Modul mit genau einer Tür

Der animierte Grund liegt in vier Dateien in einem Ordner: die Tür (`index.ts`),
die Hülle mit Leinwand, Größe, Schleife und Farbe, die Rechnung ohne React und
ohne DOM, und eine CSS-Datei mit Lage und Maske.

Der Grund dafür ist, was der Grund ist: **Zierde.** Er trägt keine Information,
er ersetzt keine Anzeige, und niemand arbeitet mit ihm. Etwas, das man morgen
austauschen oder herauswerfen möchte, darf nirgends verankert sein, wo es nicht
sein muss — sonst kostet das Herauswerfen eine Suche durch die Anwendung, und
genau deshalb bleibt es dann stehen.

Daraus folgt jede einzelne Regel des Moduls:

- **Keine Eigenschaften.** Der Aufruf ist `<DotWave />` — kein `width`, kein
  `color`, kein `speed`, kein `className`. Was das Bauteil wissen muss, misst es
  selbst. Ein Bauteil ohne Schnittstelle hat keine, die veralten kann.
- **Genau eine Berührung mit dem Entwurfssystem:** die Variable
  `--accent-foreground`, abgelesen an einem Element, das sich das Modul selbst
  anlegt. Von außen wird nichts gereicht und nichts gesetzt.
- **Die CSS-Datei importiert sich selbst** über das Bauteil und ist nicht in der
  Sammeldatei der Stile eingetragen. Ein Eintrag dort wäre ein dritter Ort, an
  dem der Grund verankert wäre.
- **Der Rückbau ist zwei Handgriffe:** den Ordner löschen, die eine Zeile im
  Rahmen streichen. Es hängt sonst nichts daran — kein Zustand, kein Kontext,
  kein Ereignis nach außen.

Dass die Rechnung ohne einen einzigen `import` auskommt, ist nicht Sparsamkeit,
sondern der Zweck des Schnitts: Was weder React noch das DOM kennt, lässt sich
nachrechnen, ohne einen Browser zu starten. Der Wächter des Moduls liest
deshalb nicht nur Quelltext, er importiert die Rechnung und misst am Ergebnis.

## 4. Warum eine Leinwand und keine Elemente mit `animation-delay`

Die naheliegende Bauart wäre ein Punkt je Element und eine CSS-Animation mit
gestaffelter `animation-delay`. Sie trägt genau so weit, wie die Welle **eine**
Schwingung ist.

Sie ist keine. Sie ist die Summe aus dreien, mit verschiedenen Längen,
Richtungen und Umlaufzeiten. Eine Verzögerung ist ein Phasenversatz — sie
verschiebt eine Schwingung in der Zeit, sie addiert keine zweite. Und ein
Element hat je Eigenschaft genau eine Animation. Drei Schwingungen brauchten
also drei ineinandergeschachtelte Elemente je Punkt.

Das Raster über 1440×900 trägt **2 402 Punkte** (gemessen am 2026-09-05:
`createWaveField(1440, 900).length`). Drei Elemente je Punkt wären rund 7 200
Knoten für einen Hintergrund, der nichts anzeigt. Auf einer Leinwand ist es
**ein** Element, und die Rechnung ist frei.

Was die Perspektive macht, macht ein Exponent: 30 Zeilen, zum Horizont hin
zusammengedrängt. Der Horizont liegt bei **33 % der Höhe**, darüber entsteht
kein Punkt — das obere Drittel bleibt leer, und das ist der Entwurf, kein
Versehen (gemessen: kein Punkt über y = 297 bei 900 px Höhe). Der Ausschlag
läuft von **±70 px** in der vordersten Zeile auf **±14 px** in der hintersten;
er ist damit größer als der Zeilenabstand, und benachbarte Zeilen überschneiden
sich. Auch das ist gewollt: Erst dadurch sieht man eine Fläche und keine
Reihen.

## 5. Warum die drei Umlaufzeiten 9, 13,5 und 21 Sekunden sind

Die drei Schwingungen laufen in 9 s, 13,5 s und 21 s um. Der Gedanke dahinter
ist, dass sich das Bild praktisch nie wiederholt und hinten etwas anderes steht
als vorn.

**Berichtigung einer Behauptung, die dieses Paket zuerst mitführte:** Die drei
Zeiten haben sehr wohl ein gemeinsames Vielfaches, und es ist nicht
unerreichbar weit weg — es liegt bei **189 s** (189/9 = 21, 189/13,5 = 14,
189/21 = 9). Richtig ist etwas anderes: Sie sind **paarweise kein ganzzahliges
Vielfaches** voneinander (13,5/9 = 1,5, 21/9 = 2,3̅, 21/13,5 = 1,5̅). Deshalb
fällt keine der drei regelmäßig mit einer anderen zusammen, und die Summe
kehrt erst nach dem kleinsten gemeinsamen Vielfachen aller drei zu sich zurück.

Die Gegenprobe zeigt, worauf es ankommt: 9/18/27 hätte dieselbe Anmutung im
Einzelbild und holte diesen Punkt auf **54 s** heran — eine sauber atmende
Tapete, und kein Test würde dabei rot. Genau deshalb ist die Zusage in einer
Rechnung festgehalten statt in einem Kommentar: Der Wächter prüft die
Verhältnisse der drei Zeiten, nicht ihre Zahlenwerte.

Die Laufrichtung steht in den Vorzeichen zweier Zahlen der ersten Zeile und
nirgends sonst. Wer dort ein Minus setzt, dreht die ganze Welle um, ohne dass
sich sichtbar etwas anderes ändert.

## 6. Die Farbe: gesättigt an einer Stelle, ein Hauch im Grund

Gesättigte Fläche gibt es auf beiden Bildschirmen genau eine: die Schaltfläche.
Sie trägt `--primary`, und an der Palette ist dafür nichts geändert worden —
kein gesetzter Ton, keine Ausnahme, keine zweite Regel. Alles andere ist Grau
mit Rändern.

Die Punkte des Grundes tragen denselben Farbton, hell und schwach: 16 % Deckung
hinten, 62 % vorn, dazu moduliert die Höhe. Das weicht die frühere Regel
„Primärfarbe nur im Hauptteil" bewusst auf, auf ausdrücklichen Wunsch nach
präsenterer Farbe.

**Warum der Grund den Ton aus `--accent-foreground` liest statt einen zweiten,
eingefrorenen Ton zu behaupten.** Eine Leinwand braucht eine konkrete Farbe;
die Palette liefert eine Variable, gerechnet aus derselben Achse wie jede
andere Farbe des Hubs. Stünde im Skript ein fertiger Wert, hätte der Hub zwei
Wahrheiten über seine Akzentfarbe: eine, die der Betreiber im Theme einstellt,
und eine, die der Hintergrund festhält. Beim ersten Umstellen liefen sie
auseinander, und nichts meldete es.

Der Weg dazwischen ist ein Element, das nichts anzeigt und `--accent-foreground`
trägt; das Bauteil liest den berechneten Wert daran ab. Was der Browser dort
ausgibt, ist per Definition eine Farbe, die er auch wieder lesen kann.

Zwei Fallen hängen daran, beide gemessen:

- Ein `fillStyle`, den der Browser nicht versteht, wird **stillschweigend**
  verworfen — die Leinwand zeichnete dann Schwarz auf Schwarz, und nichts sagte
  etwas. Deshalb wird nach dem Setzen zurückgelesen; ohne gültige Farbe bleibt
  der Grund leer statt falsch.
- Der Rückvergleich darf nicht gegen die gesetzte Zeichenkette laufen: Der
  Getter gibt eine normalisierte Schreibweise zurück, nicht die Eingabe. Ein
  Zeichenvergleich schlüge damit **auch bei einer gültigen Farbe** fehl und
  ließe den Grund immer leer — genau der Ausfall, den die Regel verhindern
  soll. Verglichen wird deshalb mit dem Stand davor.

Aus derselben Regel folgt, dass auch die Maske über der Leinwand keinen rohen
Farbwert schreibt. Für eine Maske zählt allein der Alphakanal; das Schwarz
darin ist kein Gestaltungswert, sondern nur der Träger der drei Deckungsstufen.
Eine Ausnahme allein für Maskenwerte wäre eine Lücke, die später niemand mehr
von einem eingefrorenen Ton unterscheidet.

## 7. Die Fassung kommt beim Bauen, nicht über eine Route

In der Fußzeile steht die Fassung des Hubs. Sie kommt aus der `package.json` der
Repo-Wurzel und wird beim Bauen als Konstante in den Quelltext eingesetzt.

Keine Route liefert heute eine Fassungsnummer, und eine dafür zu bauen hieße,
einen Wert über das Netz zu holen, der sich zwischen zwei Bauten nicht ändern
kann. Bewusst die Wurzel und nicht die des Arbeitsbereichs: Die Fassung des
Hubs ist die des Ganzen; die Nummern der einzelnen Arbeitsbereiche sagt niemand
nach außen zu. Und bewusst beim Bauen statt als Import im Anwendungscode — ein
Import der `package.json` zöge Abhängigkeiten, Skripte und Beschreibung in das
ausgelieferte JavaScript, für eine einzige Zeichenkette.

**Ist der Wert leer, zeigt die Fußzeile an dieser Stelle nichts** — keinen
Platzhalter, kein „unbekannt", keine „0.0.0". Eine erfundene Nummer ist
schlimmer als gar keine, weil sie geglaubt und weitergemeldet wird: Wer sie in
einer Fehlermeldung zitiert, sucht danach am falschen Stand. Der leere Kasten
bleibt trotzdem stehen, damit der Sprachumschalter daneben nicht wandert.

## 8. Verworfene Alternativen

**Vier Entwurfsrichtungen lagen als Artboards nebeneinander**, alle mit
demselben Markenblock und derselben Feldtypografie:

- **A — Karte auf leerer Fläche.** Der gewählte Aufbau ohne Grund und ohne
  Fußzeile. Verworfen, weil die Fläche eines 1440 px breiten Schirms damit zu
  drei Vierteln aus einem einzigen Grauton besteht: korrekt und ohne jeden
  Anhalt, dass hier ein System beginnt.
- **B — ohne Karte, Felder auf Linien.** Schmaler, leiser, näher an einem
  Formular als an einem Bildschirm. Verworfen aus demselben Grund wie A und mit
  einem Zusatz: Ohne Karte gibt es keinen Ort für die Fußzeile, und Fassung wie
  Sprachumschalter müssten frei in der Fläche schweben.
- **C — zweigeteilte Fläche**, links das Formular, rechts eine Kontextspalte.
  Die naheliegendste Antwort auf die leere Fläche und die am gründlichsten
  verworfene. Der Grund liegt nicht in der Gestaltung: **Die Kontextspalte darf
  vor der Anmeldung fast nichts sagen.** Kein Hostname, keine Zahl, kein
  Kontoname, kein Hinweis darauf, wie viele Menschen hier arbeiten — schon die
  Fehlermeldung der Anmeldung verrät bewusst nicht, ob es zu einer Adresse ein
  Konto gibt. Übrig bleibt ein allgemeiner Satz darüber, was ein Docker-Hub
  ist, den der Betreiber beim zweiten Mal nicht mehr liest. Der Artboard trug
  das selbst als Zeile: „Mehr steht hier bewusst nicht." Eine halbe Bildfläche
  für einen Satz, der nichts sagen darf, ist die teuerste Art, eine leere Fläche
  zu füllen.
- **D — Karte über einer bewegten Fläche.** Gewählt. Der Grund trägt keine
  Information und behauptet auch keine; er zeigt, dass etwas läuft, und sonst
  nichts. Was er nicht sagen darf, kann er nicht falsch sagen.

**Der gespeicherte Sprachumschalter.** Die Alternative zu §2: Der Umschalter
schreibt in den Browser, bis ein Konto da ist. Er wäre nicht vergesslich und
sähe an jeder Stelle richtig aus. Verworfen, weil er einen zweiten Speicherort
für dieselbe Einstellung schafft und damit die Frage, welcher gilt, wenn beide
sich widersprechen — eine Frage, die jemand beantworten müsste und die keine
gute Antwort hat. Die Browsersprache allein hat sie nicht.

## 9. Eine gemessene Falle, die keine Prüfung fängt

`inset: 0` streckt eine `canvas` **nicht**. Sie ist ein ersetztes Element: Bei
`width: auto` gilt ihre eigene Größe, und die ist ohne Attribute 300×150. Die
damit überzählige Angabe wird aufgelöst, indem `right` und `bottom` fallen — der
Kasten bleibt 300×150 in der linken oberen Ecke. Bei einem nicht ersetzten
Element, etwa einem `div`, würde dieselbe Regel strecken; genau dieser
Unterschied stellt die Falle.

Gemessen am 2026-09-05 im gebauten Bildschirm: `getBoundingClientRect()` meldete
300×150 bei `position: absolute`, `inset: 0` und einem umgebenden `main` mit
`position: relative`. Das Bauteil rechnete daraufhin sein Raster über 300×150
und zeichnete es in die Ecke — sichtbar, plausibel und falsch. Mit
`width: 100%; height: 100%` daneben: Kasten 1440×900, **29 466 leuchtende
Bildpunkte**, unterster Punkt bei y = 899.

Der Entwurf hat den Fehler verdeckt, weil die Leinwand dort feste Maße in einer
Regel trug, die es in der Anwendung nicht gibt. Kein Wächter, kein `tsc` und
kein Bau meldet so etwas — nur ein Blick auf den gebauten Bildschirm. Das ist
der Grund, warum ein Bildschirm dieses Pakets angesehen und nicht nur geprüft
wurde.

## 10. Offene Fragen

Fragen, die dieses Paket aufgeworfen und nicht beantwortet hat. Sie sind hier
als Fragen notiert, weil ihre Antwort eine Entscheidung ist und keine Arbeit.

- **Wohin gehört die Rechnung, die aus einem Namen die Initialen macht?** Der
  Betreiber hat sie nach `web/src/platform/ui/lib/initials.ts` gelegt; der Markenblock
  der Seitenleiste und der über der Karte holen sie von dort. Bewusst ist
  daran zweierlei: dass sie kein Text in der Sprachdatei ist — ein Kürzel, das
  neben dem Namen steht, aus dem es kommt, wäre eine zweite Stelle, die bei
  einer Umbenennung mitgepflegt werden müsste — und dass sie nur einmal im
  Baum liegt, weil zwei Abschriften derselben Rechnung zwei Wahrheiten sind.
- **Wie lange trägt die abgeschriebene Klassenzeile am Auswahlfeld des
  Host-Formulars?** Sie ist eine Kopie der Klassen des `Input`-Bausteins,
  damit das `select` neben den Textfeldern nicht aus der Reihe fällt. Ändert
  sich der Baustein, läuft sie auseinander, und nichts wird rot.
- **Wie weit darf ein Betreiber-Theme den Grund mitziehen?** Die Punkte folgen
  `--accent-foreground` und damit derselben Achse wie die Schaltfläche. Bei
  einer sehr gesättigten Einstellung wird aus dem Hauch eine Fläche. Ob es
  dafür eine Obergrenze braucht oder ob der Grund dem Theme bedingungslos
  folgt, ist nicht entschieden.
Entschieden ist dagegen, was bei `prefers-reduced-motion: reduce` geschieht:
**gar kein Grund**. Nicht ein stehendes Bild, sondern eine leere Fläche.

Der erste Bau zeichnete genau ein Bild und warf die Schleife nicht an — die
sichere Antwort, aber nur die halbe. Die Einstellung kommt vom Gerät
desjenigen, der sich anmeldet, und wer sie setzt, hat meist einen körperlichen
Grund: eine vestibuläre Störung, bei der Bewegung auf dem Schirm echten
Schwindel auslöst, Migräne, Reisekrankheitsneigung. Weniger Bewegung heißt dort
in aller Regel auch weniger visuelles Rauschen — und 2.400 Punkte sind Rauschen,
ob sie wandern oder stehen.

Der Preis ist benannt und angenommen: zwei Leute bekommen denselben Bildschirm
verschieden beschrieben. Das ist vertretbar, weil der Grund Zierde ist und
nichts trägt. Karte, Marke und Fußzeile sind der Bildschirm; sie stehen ohne
ihn genauso.

## 11. Compose-Definition bewusst wählen

Die Ersteinrichtung fragt „Compose-Definition bei Start und Neustart anwenden“
mit Vorauswahl „An“ und nennt die Wirkung: Bei Hub-eigenen Stacks übernimmt Start
die Definition und Neustart erstellt Container neu. Die Einstellung lässt sich
später in den Einstellungen ändern; die Grenzen für fremdverwaltete Stacks
stehen in [container-lifecycle.md](container-lifecycle.md).

Die Wahl reist mit derselben geschützten Anfrage wie das erste Konto. Der
Anlegeweg validiert sie vor dem Belegen des Einrichtungsplatzes und speichert sie
vor dem Konto; scheitert die Speicherung, entsteht kein Konto mit einer anderen
Wahl. Scheitert anschließend das Anlegen des Kontos, kann die nächste
Ersteinrichtung die Wahl neu setzen. Ein zweiter Schreibaufruf nach erfolgreicher
Anmeldung könnte bei einem Verbindungsabbruch die Vorauswahl stehen lassen,
obwohl der Betreiber „Aus“ gewählt hat. Bestehende Installationen werden nicht
erneut befragt.
