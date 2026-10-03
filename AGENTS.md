# AGENTS.md

Verbindliche Arbeitsregeln für docklet hub, für Menschen und Agenten.
Arbeitsstand steht in GitHub Issues und Meilensteinen; Begründungen stehen
in docs/design/ und sind dort im Index verlinkt.

## Sprache und Herkunft

- Bezeichner, Dateinamen, technische Schlüssel, Protokollwerte und Branches
  sind englisch. Hub und Agent importieren gemeinsame Werte aus contract/.
- Dokumentation und Commit-Texte sind deutsch. README.md, CONTRIBUTING.md,
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
- Umlaute und ß werden richtig geschrieben. Texte mit Umlauten kommen über
  UTF-8-Dateien in Git und GitHub, nie als Shell-Argument.
- Übernommener Code trägt Quellpfad, volle Quell-SHA, Bezugsdatum und
  begründete Abweichungen. Lizenz- und Herkunftsnachweise bleiben erhalten.
- shadcn-Bausteine zuerst aus shadcnblocks Pro beziehen. Fehlt der
  SHADCNBLOCKS_API_KEY, nachfragen. Nur wenn das keinen Baustein liefert,
  die freie Registry verwenden. Jede Kopie erhält einen Herkunftskopf.

- Keine Autoren- oder Maintainerzuschreibungen an KI-Werkzeuge und keine
  Co-Authored-By-Trailer für solche Werkzeuge in Code, Dokumentation,
  Commit-Texten, Issues oder PRs. Commits und PRs dürfen KI-Mitarbeit als
  Texthinweis ohne E-Mail-Adresse nennen, etwa Assisted-by: Claude Code;
  .claude/settings.json legt ihn fest. Sitzungslinks entfallen. Autor und
  Committer sind Menschen mit Noreply-Absender; die Identität setzt die
  jeweilige Umgebung, nicht das Repo. Echte Lizenz- und Herkunftsnachweise
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
- Jeder Meilenstein nennt Ziel, Umfang, Abhängigkeiten, Zielbranch und
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

- Feature-Integrationsbranch: codex/feature-<name>. Arbeitsschritte entstehen
  auf eigenen Branches und kommen per PR auf diesen Feature-Branch.
- Erst das vollständige Feature kommt mit einem Abschluss-PR auf main.
  Eigenständige Fehlerkorrekturen und Dokumentation dürfen direkt per PR dorthin.
- Jeder PR wird vor dem Merge automatisch von einem unabhängigen Agenten
  geprüft. Die bearbeitende Sitzung startet ihn ohne zusätzliche Aufforderung.
  Der Reviewer hat den PR nicht umgesetzt und erhält einen eigenen Kontext,
  Repo-Regeln, Issues und den vollständigen Diff zum tatsächlichen Zielbranch.
- Review-Belege nennen Reviewer, Head-/Base-/Test-Merge-SHAs, Befunde und Ergebnis.
  Inhaltliche Änderungen oder Änderungen der Integrationsgrundlage brauchen
  erneuten Review. Blockierende Befunde werden vor dem Merge behoben.
- Die veröffentlichende Sitzung attestiert einen abgeschlossenen Review mit
  scripts/record-agent-review.mjs. Der erforderliche agent-review-Status
  liegt am PR-Head. Der Beleg nennt die geprüften Head-, Base- und
  Test-Merge-SHAs; die Sitzung verantwortet die Wahrhaftigkeit der Attestation.
  Das Skript ersetzt keine Prüfung.
- Jeder Merge läuft über scripts/merge-reviewed-pr.mjs mit dem aktuellen
  privaten Review-Bericht und UTF-8-Merge-Text. Der Helfer verlangt den neuesten
  erfolgreichen GitHub-Prüflauf für genau diese Integration und prüft die
  PR-SHAs unmittelbar vor dem Merge erneut. Währenddessen erfolgen keine
  parallelen Änderungen am Zielbranch. Direkte UI-/API-Merges sind untersagt.
  GitHub erzwingt den Helfer nicht; seine Merge-API bindet atomar nur den Head.
- Für main und codex/feature-* gelten aktive Rulesets mit PR-Pflicht,
  erforderlichen checks und agent-review sowie strikter Aktualität zur Basis.
  GitHub prüft den Test-Merge; dessen künstliche Metadaten werden von der
  vollständigen Prüfung der echten PR-Historie getrennt.
- Der Feature-Branch übernimmt main regelmäßig per Merge. Geteilte Historie
  wird nicht rebased oder force-gepusht. Ungeprüfte Zwischenstände bleiben lokal.
- Der einzige Root-Commit wird vor Erstveröffentlichung als vollständiger
  Quellbaum unabhängig geprüft. Danach gilt das PR-Verfahren für jede Änderung.

## Git und Veröffentlichungen

- Branches heißen codex/<topic> oder claude/<topic>; kein direkter Push auf main.
- Commits sind Conventional Commits mit deutschem Betreff. Sobald ein Issue
  existiert, steht (#<number>) am Ende. Öffentliche Noreply-Absender verwenden.
- Commit-Text über git commit -F, PR-Text über --body-file und Titel/Merge-Text
  über gh api --input mit UTF-8-Dateien. Vor Merge Titel und vollständigen
  Merge-Text mit scripts/check-umlauts.mjs prüfen.
- Abschluss-PRs nennen erledigte Issues mit Closes #<number>, einschließlich
  auf dem Feature-Branch bereits abgeschlossener Aufgaben.
- Hub und Agent tragen dieselbe Version. Mindest-Agent-Version und
  Vertragsversion bleiben explizite Release-Grenzen; alte Datenbanken und
  Registrierungen vor docklet hub werden nicht importiert.
- Keine Veröffentlichung eines Produkt-Releases ohne praktische Abnahme.

## Prüfungen und Bestand

- Vor jedem Push laufen lokal pnpm run lint, pnpm run test und pnpm run build.
  Die Veröffentlichungskontrolle ist Teil der Tests und Git-Hooks.
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
  ausgeliefertes Web-Bundle prüfen. Risiken stehen im PR unter Vor dem Deploy.
- Hub-Agent-Protokollbrüche und neue Pflichtwerte werden ausdrücklich benannt.
- Änderungstexte beginnen mit der konkreten Änderung und tragen messbare
  Aussagen mit Zahl und Messweg. Prüfergebnisse und Grenzen werden ehrlich
  genannt. Prosa trägt Zusammenhänge, Listen Gleichartiges; nicht verschachteln.
