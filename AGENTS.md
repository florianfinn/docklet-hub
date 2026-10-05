# AGENTS.md

Verbindliche Arbeitsregeln für docklet hub, für Menschen und Agenten.
Arbeitsstand steht in GitHub Issues und Meilensteinen; Begründungen stehen
in docs/design/ und sind dort im Index verlinkt.

## Sprache und Herkunft

- Bezeichner, Dateinamen, technische Schlüssel, Protokollwerte und Branches
  sind englisch. Hub und Agent importieren gemeinsame Werte aus contract/.
- Dokumentation ist deutsch. Commit-, PR- und Merge-Texte sind englisch.
  README.md, CONTRIBUTING.md,
  SECURITY.md, agent/README.md, die deploy-READMEs und erzeugte
  Installationspakete sind englisch.
- Neue und angefasste Codekommentare sind englisch. Bestehende Kommentare
  werden bei fachlichen Änderungen angepasst, nicht in eigener Übersetzungsrunde.
- Codekommentare sind knapp und erklären nur den aktuellen Code: relevante
  Verträge, Randbedingungen oder nicht offensichtliche Zusammenhänge. Meist
  reichen ein bis drei Zeilen. Offensichtlichen Code nicht nacherzählen.
- Keine Blocktexte mit Änderungshistorie, alten Fehlerbehebungen, früheren
  Namen oder Abläufen, „behoben in X“, „war früher so“ oder Diskussionen
  verworfener Alternativen im Code. Änderungshistorie gehört in Git und Issues;
  ausführliche Begründungen und Alternativen bei Bedarf in docs/design/ mit
  Indexeintrag. Historische Pläne gehören nach docs/history/. Inhalte nur
  auslagern, wenn sie weiterhin relevant und belegt sind.
- Bestehende Kommentare werden bei fachlichen Änderungen nach diesen Regeln
  gekürzt oder entfernt. Lizenz- und Herkunftsnachweise sowie notwendige
  Werkzeugdirektiven bleiben erhalten.
- UI-Texte stehen in den Sprachdateien des jeweiligen Features bzw. der
  Plattform. Deutsch ist die erste Sprache. ICU-Apostrophe werden verdoppelt.
- Umlaute und ß werden richtig geschrieben; Hooks, Tests und pr-text prüfen
  Dateien, Commit- und PR-Texte auf ASCII-Umschreibungen und doppelt kodierte
  Zeichen.
- Übernommener Code trägt Quellpfad, volle Quell-SHA, Bezugsdatum und
  begründete Abweichungen. Lizenz- und Herkunftsnachweise bleiben erhalten.
- shadcn-Bausteine zuerst aus shadcnblocks Pro beziehen. Fehlt der
  SHADCNBLOCKS_API_KEY, nachfragen. Nur wenn das keinen Baustein liefert,
  die freie Registry verwenden. Jede Kopie erhält einen Herkunftskopf.

- Keine Autoren- oder Maintainerzuschreibungen an KI-Werkzeuge und keine
  Co-Authored-By-Trailer für solche Werkzeuge in Code, Dokumentation,
  Commit-Texten, Issues oder PRs. Commits und PRs dürfen KI-Mitarbeit als
  Texthinweis ohne E-Mail-Adresse nennen, etwa Assisted-by: Claude Code;
  .claude/settings.json legt ihn fest. Sitzungslinks entfallen; pr-text weist
  sie im PR-Text zurück. Autor und Committer sind Menschen mit
  Noreply-Absender, bei Merges über GitHub ist GitHub der Committer; die
  Identität setzt die jeweilige Umgebung, nicht das Repo. Echte Lizenz- und Herkunftsnachweise
  übernommener Komponenten bleiben erhalten.

## Öffentliche Daten

- Das Repo und alle seine Issues, PRs, Commit-Texte, Screenshots und
  Release-Artefakte enthalten ausschließlich veröffentlichbare Informationen.
- Keine echten privaten E-Mail-Adressen, Geheimnisse, Hostnamen, Domains,
  Betriebs-IP-Adressen, Netzpläne, Routen oder persönlichen Arbeitsplatzpfade.
  Auch Testdaten und Codekommentare sind keine Ausnahme.
- Beispiele verwenden erfundene Namen und reservierte Beispieldomains und
  Beispieladressen. Produkt-Netzvorgaben und notwendige synthetische
  Netzwerktests werden ausdrücklich dokumentiert.
- Laufzeitgeheimnisse stehen in lokalen .env-Dateien. Nur generische
  .env.example-Dateien werden versioniert; jede neue Laufzeitvariable steht
  dort. Der Entwicklungszugang SHADCNBLOCKS_API_KEY ist keine Laufzeitvariable.
- Der Index wird vor dem Commit geprüft, neue Commit-Inhalte und öffentliche
  Noreply-Absender vor dem Push. check-publication meldet nur Pfad und
  Kategorie; sensible Fundwerte werden nicht in Fehlerausgaben wiederholt.
- Automatische Erkennung ersetzt keine Beurteilung von Freitext und Bildern.
  Jeder unabhängige Review prüft zusätzlich die Veröffentlichbarkeit.
- Berichte mit echten Betriebsdaten bleiben privat. Öffentliche Fehlerbelege
  werden bereinigt und verwenden keine privaten Issue-Verlinkungen.

## Planung und Abschluss

- Releases, wichtige Features und überprüfbare Zwischenschritte bekommen
  Meilensteine vor ihrem Beginn. Neue track-Sammel-Issues werden nicht angelegt.
- Jeder Meilenstein nennt Ziel, Umfang, Abhängigkeiten und
  Abnahmekriterium. Ein Abschluss-Issue trägt den Nachweis.
- Issues entstehen nur für Feature-Arbeit, Produkt- und
  Architekturentscheidungen und Befunde, die nicht in der laufenden Sitzung
  erledigt werden. Kleine eigenständige Aufgaben wie Korrekturen, Wartung,
  Abhängigkeitspflege oder Regel- und Doku-Anpassungen werden direkt per PR
  umgesetzt, ohne vorheriges Issue und ohne Meilenstein. Issues zu Befunden
  und Entscheidungen bekommen einen Meilenstein, wenn sie zu einem Feature
  oder Release gehören.
- Feature- und Release-Issues gehören einem konkreten Meilenstein.
  Feature-Meilensteine verlinken ihre Zwischenziele; Release-Meilensteine
  verlinken Pflichtfeatures. release:first-public ermöglicht die vollständige
  Abfrage ohne doppelte Issues.
- Produkt- und Architekturentscheidungen tragen eigene Issues und werden in
  docs/design/ begründet. Vorgaben des Maintainers zu Arbeitsweise und Regeln
  werden ohne eigenes Issue direkt per PR umgesetzt. Widersprüche zu Arbeitsaufträgen werden vor der
  Umsetzung aufgelöst.
- Eine Aufgabe schließt erst nach Merge in ihren Zielbranch, grünen Prüfungen
  und unabhängigem Review. Auf Feature-Branches geschieht der Abschluss
  manuell mit PR, Merge-SHA, Review und Prüfergebnissen im Kommentar.
- Das Feature-Abschluss-Issue bleibt bis zum Merge auf main bestehen.
  Zwischenmeilensteine schließen erst nach belegter Teilabnahme.
- Praktische Release-Abnahmen tragen eigene Issues. Ein Release schließt
  erst nach Integration seiner Pflichtfeatures und Abnahme des konkreten
  Release-Pakets. Lokale Tests ersetzen keine praktische Abnahme.
- docs/design/ trägt Zielbild und Begründungen, keinen Arbeitsstand.
  Datierte Messungen bleiben Nachweise. Historische Pläne werden in
  docs/history/ abgelegt und dort indiziert.

## Branches und unabhängige Agentenreviews

- Jedes Feature wird auf einem eigenen Feature-Branch integriert.
  Arbeitsschritte entstehen auf eigenen Branches und kommen per PR auf diesen
  Feature-Branch. Branch-Namen sind nicht vorgegeben.
- Erst das vollständige Feature kommt mit einem Abschluss-PR auf main.
  Eigenständige Fehlerkorrekturen und Dokumentation dürfen direkt per PR dorthin.
- Vor jedem Merge startet die bearbeitende Sitzung ohne zusätzliche
  Aufforderung einen unabhängigen Reviewer: einen Agenten mit eigenem Kontext,
  der den PR nicht umgesetzt hat und Repo-Regeln, Issues und den vollständigen
  Diff zum Zielbranch erhält. Umfang und Tiefe richten sich nach der Änderung;
  er darf Tests ausführen und prüft auch die Veröffentlichbarkeit.
- Das Ergebnis steht als PR-Kommentar unter dem Konto des Maintainers. Die
  erste Zeile lautet Independent review, direkt darunter folgen Reviewer, Head
  (volle SHA) und Result (pass oder fail), nach einer Leerzeile die Befunde.
  Der Workflow review-status setzt den Status review am aktuellen PR-Head:
  success nur, wenn der Kommentar genau diesen Head mit pass nennt, sonst
  failure, auch für einen unlesbaren Beleg.
- Pflicht-Checks erkennt GitHub nur am Namen. Ein PR, der Dateien unter
  .github/workflows/ oder von Workflows ausgeführte Skripte ändert, kann sie
  selbst grün melden; solche Diffs prüft der Maintainer vor dem Merge selbst.
  Workflows aus Forks laufen erst nach Freigabe (Actions-Einstellung „Require
  approval for all external contributors“).
- Die Sitzung behebt blockierende Befunde sofort selbst. Nach jeder Änderung
  prüft ein neuer unabhängiger Reviewer mit frischem Kontext den neuen Stand.
  Fehlgeschlagene Zwischenrunden bleiben in der Sitzung; gepostet wird der
  Beleg für den finalen Head mit den behobenen Befunden. Optionale Befunde
  werden entschieden und im Beleg kurz begründet. Ist ein Befund im PR nicht
  behebbar, wird der Beleg mit fail gepostet oder ein Issue angelegt.
- Jeder neue Push und jeder Wechsel des Zielbranches braucht einen neuen
  Review; neue Commits auf demselben Zielbranch ohne Konflikt nicht.
- Für main gilt ein aktives Ruleset mit PR-Pflicht und den erforderlichen
  Prüfungen checks, pr-text und review, ohne strikte Aktualität zur Basis.
  Gemergt wird per Squash über GitHub, sobald alle Prüfungen grün sind. Ein Fehler
  aus dem Zusammenspiel zweier PRs fällt im vollen CI-Lauf auf main auf und
  wird sofort per Fix oder Revert behoben.
- Auf Feature-Branches gelten dieselben Schritte als Arbeitsregel; GitHub
  erzwingt sie dort nicht.
- Der Feature-Branch übernimmt main regelmäßig per Merge. Geteilte Historie
  wird nicht rebased oder force-gepusht. Ungeprüfte Zwischenstände bleiben lokal.
- Der einzige Root-Commit wird vor Erstveröffentlichung als vollständiger
  Quellbaum unabhängig geprüft. Danach gilt das PR-Verfahren für jede Änderung.

## Git und Veröffentlichungen

- Kein direkter Push auf main.
- Ein Feature wird zuerst fertig gebaut, besprochen und lokal getestet. Push
  und PR folgen erst auf ausdrückliche Anweisung.
- Commits sind Conventional Commits mit englischem Betreff. Sobald ein Issue
  existiert, steht (#<number>) am Ende. Öffentliche Noreply-Absender verwenden.
- Auf main wird nur per Squash gemergt; der PR-Titel wird zum Betreff, der
  PR-Text zum Commit-Text. PR-Titel sind deshalb Conventional Commits, auch bei
  Reverts (revert: …); die Prüfung pr-text erzwingt das. Wird die Basis eines
  PRs geändert, läuft checks erst mit dem nächsten Push erneut.
- Abschluss-PRs nennen erledigte Issues mit Closes #<number>, einschließlich
  auf dem Feature-Branch bereits abgeschlossener Aufgaben.
- Hub und Agent tragen dieselbe Version. Mindest-Agent-Version und
  Vertragsversion bleiben explizite Release-Grenzen; alte Datenbanken und
  Registrierungen vor docklet hub werden nicht importiert.
- Keine Veröffentlichung eines Produkt-Releases ohne praktische Abnahme.

## Prüfungen und Bestand

- Vor jedem Push laufen lokal pnpm run lint (mit Typprüfung) und pnpm run
  test; pre-push erzwingt das. Den Build prüft CI. Die
  Veröffentlichungskontrolle ist Teil der Tests und Git-Hooks.
- Reine Textänderungen nach scripts/change-scope.mjs (nur .md außerhalb
  ausgeführter Pfade sowie LICENSE oder NOTICE im Wurzelverzeichnis) prüfen
  pre-push und checks ohne Installation, Lint, Tests und Build: nur
  Veröffentlichung, Commit-Texte und die Node-Tests für Texte. pre-push misst
  gegen origin/main; Zweige von Feature-Branches laufen dort voll. Der
  unabhängige Review bleibt Pflicht.
- GitHub-PR-Prüfungen laufen zusätzlich auf Feature-Branches und main für
  Veröffentlichung, Lint, Tests und Build mit minimalen Rechten, ohne
  Produktionsgeheimnisse. Sie ersetzen weder Prüfung vor Push noch Review.
- core.hooksPath muss auf .githooks stehen. Neue Dateien vor der Prüfkette
  stagen, weil git ls-files sie sonst nicht sieht.
- Tests brauchen keine echten Dienste, keinen Docker-Socket und keinen
  laufenden Agenten. Ein Wächter muss bei einem Fehler fallen, nicht warnen.
- Richtiges Verhalten wird nicht an einen Prüfstand angepasst. Anders prüfen,
  echte Geste nachstellen oder reine Logik prüfen; verbleibende Lücken benennen.
  Grenzen werden nicht gelockert und Aufteilungen machen Wächter nicht blind.
- Keine selbst gepflegte Text-/Quelldatei über 1.000 Zeilen. Aufteilen, bevor
  sie die Grenze reißt. Generierte Lockfiles sind ausgenommen.
- DOM-Assertions vergleichen Booleans, keine zyklischen DOM-Knoten.
- Unter happy-dom Radix Select über Tastatur öffnen; keine eigene
  schlechter zugängliche Komponente wegen eines Prüfstandproblems bauen.

## Abhängigkeiten, Images und Datenbank

- Neue Abhängigkeiten begründen. Kleine verständliche Hilfen selbst schreiben.
  Apache-2.0 gilt für Hub und Agent; kompatible Abhängigkeitslizenzen beachten.
- Der Agent hat höchstens zod als Laufzeitabhängigkeit; weitere erfordern
  eine eigene Entscheidung. Gemeinsames Vokabular liegt in contract/.
- Images mindestens auf SemVer pinnen, Digest wo verfügbar; kein latest in
  Installationsvorlagen. Referenzen sind über Umgebungsvariablen übersteuerbar.
  Lokaler Image-Bau bleibt ein Rückfall ohne Registry-Zugang.
- Datenbankmigrationen laufen vorwärts beim Serverstart. Ausgelieferte
  Migrationen werden nicht geändert. Reihenfolge und Schema folgen der
  nummerierten Migrationsfolge; neue Installationen brauchen keine alten Daten.

## Deploy und Änderungstexte

- Kein Subagent verändert laufende Systeme. Ein Deploy braucht die ausdrückliche
  Betreiberbestätigung für genau diesen Deploy und erfolgt von origin/main.
- Vor Schemaänderungen Datenbank sichern; danach Migrationen, /health und
  ausgeliefertes Web-Bundle prüfen. Risiken stehen im PR unter Before deploy.
- Hub-Agent-Protokollbrüche und neue Pflichtwerte werden ausdrücklich benannt.
- Änderungstexte beginnen mit der konkreten Änderung und tragen messbare
  Aussagen mit Zahl und Messweg. Prüfergebnisse und Grenzen werden ehrlich
  genannt. Prosa trägt Zusammenhänge, Listen Gleichartiges; nicht verschachteln.
