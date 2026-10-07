# Push, Review und Abschluss

Dieser Ablauf ist vor Push, PR-Erstellung, Review und Merge verbindlich zu lesen,
auch von unabhängigen Reviewern. Ein vollständiger erster Review und gezielte
Folgereviews erhalten die Befunde, ohne für jede Textkorrektur dieselbe Prüfung
neu zu beginnen. Repo-Regeln zu Veröffentlichung, Prüfungen und Freigaben gelten
weiter; Umfang und Tiefe des Reviews richten sich nach der Änderung.

## Vorbereitung und erster Review

Vor dem ersten Push prüft die bearbeitende Sitzung die Änderung selbst. Entfällt
oder ändert sich ein Verhalten, sucht sie nach seiner Bedeutung, nicht nur nach
Bezeichnern: Sprachdateien, Dokumentation und Kommentare gehören dazu. Neue
Aussagen in Dokumentation und UI-Texten werden gegen den Code belegt. Eine Suche
nach alten Bezeichnern allein übersieht Fließtext, der altes Verhalten beschreibt.

Direkt nach dem Anlegen eines PRs entfernt die Sitzung Zeilen, die ihr Werkzeug
an den PR-Text anhängt, etwa eine Fußzeile mit Sitzungslink. Sie wartet auf eine
grüne Prüfung `pr-text`, bevor sie den Review startet. Die Einstellung
`attribution.sessionUrl` verhindert solche Fußzeilen nicht bei jeder Anbindung.

Vor jedem Merge startet die Sitzung ohne zusätzliche Aufforderung einen
unabhängigen Reviewer mit eigenem Kontext, der die Änderung nicht umgesetzt hat.
Er erhält Repo-Regeln, diese Doku, Auftrag, relevante Issues und Abnahmekriterien,
Zielbranch und Head-SHA sowie den vollständigen Diff zum tatsächlichen Zielbranch.
Der erste Review deckt den gesamten PR ab: Verhalten, Tests, Bedeutungssuche,
Belege neuer Aussagen und Veröffentlichbarkeit. Der Reviewer darf Tests ausführen;
eine Doku-Korrektur braucht einen kurzen Blick, ein Feature eine gründliche Prüfung.
Er berichtet alle entdeckten Befunde gesammelt, auch wenn ein Blocker feststeht.

Der einzige Root-Commit wird vor Erstveröffentlichung als vollständiger Quellbaum
unabhängig geprüft. Danach gilt das PR-Verfahren für jede Änderung.

## Befunde entscheiden und gebündelt beheben

Jeder Befund erhält eine stabile Kennung innerhalb des PRs, Fundstelle, Problem
mit Beleg und eine begründete Einstufung. Blockierend sind Fehler in Verhalten,
Sicherheit oder verbindlichen Abnahmekriterien sowie Texte, die Nutzer zu falschen
Handlungen führen oder wesentliche Verträge falsch beschreiben. Kleine
Präzisierungen von Kommentaren und Testnamen sind grundsätzlich optional, sofern
sie kein solches Problem darstellen. Der Reviewer begründet den konkreten Schaden
oder die verletzte Anforderung; eine Ungenauigkeit allein erzwingt kein `fail`.

Die Sitzung führt eine Befundliste mit den Entscheidungen „behoben“, „begründet
verworfen“ oder „zur Nacharbeit übernommen“. Für behobene Punkte nennt sie den
Fix-Commit, für verworfene die fachliche Begründung, für übernommene das Issue und
die dortige Kennung. Bei einem ungelösten Blocker bleibt das Ergebnis `fail`.
Ein Issue ersetzt seine Behebung und Prüfung vor dem Merge nicht.

Eine Korrekturrunde prüft bei jedem blockierenden Befund die Fehlerklasse über
alle vergleichbaren Pfade. Der Korrekturauftrag verlangt eine Prüfmatrix für
diese Pfade und Belege, dass die neuen Tests ohne die Korrektur fehlschlagen.

Blocker und passende optionale Korrekturen werden in einer Korrekturrunde gesammelt
behoben, selbst geprüft und gemeinsam gepusht. Nach einem bestandenen Review
werden zusätzliche optionale Verbesserungen zur Nacharbeit übernommen, statt
den geprüften Stand erneut umzubauen. Die Liste wird im finalen Review-Beleg
veröffentlicht; spätere Arbeit bleibt über die verlinkten Issues nachvollziehbar.
Zwischenberichte bleiben in der Sitzung, ihre Befunde dürfen nicht verloren gehen.

## Gezielte Folgereviews und Grenze der Wiederholung

Jeder neue Push braucht einen neuen unabhängigen Reviewer mit frischem Kontext.
Er erhält zusätzlich die vorherige geprüfte Head-SHA, den vollständigen vorherigen
Bericht samt Befundliste und Entscheidungen sowie den Diff seit diesem Stand.
Der gesamte Diff zum Zielbranch bleibt zugänglich. Ein Folgereview prüft die Fixes,
ihre Auswirkungen, mögliche Regressionen und die Befundentscheidungen. Er muss
bereits geprüfte, unveränderte Teile nicht vollständig neu untersuchen. Bei
größerem Umbau, unvollständigem Vorbericht oder neuen Hinweisen erweitert er den
Prüfumfang ausdrücklich und begründet dies.

Neue Funde werden ebenfalls erfasst. Übernommene optionale Befunde werden nicht
ohne neue sachliche Gründe erneut als Blocker aufgerollt; echte neue Blocker
verhindern weiter den Merge. Ein `pass` für den aktuellen Head bestätigt die
Abnahme anhand des ersten Reviews und der geprüften Folgeänderungen.

Nach zwei Korrekturrunden, die keinen bestandenen Review ergeben, startet die
Sitzung keine weitere Runde automatisch. Sie bündelt die Ursachen: unklare
Anforderung, unvollständige Prüfung, fehlerhafte Fixes oder falsche Einstufung.
Sie dokumentiert im PR einen konkreten Korrektur- und Prüfplan, bevor sie
fortsetzt. Benötigt dieser eine fachliche Entscheidung, holt sie diese beim
Maintainer ein. Die Grenze ist keine Merge-Freigabe; ungelöste Blocker bleiben
blockierend und ein unlösbarer Stand wird mit `fail` belegt.

Ein Wechsel des Zielbranches verlangt einen neuen vollständigen Review und
einen erneuten Push, damit `checks` für die neue Basis läuft. Neue Commits auf
demselben Zielbranch ohne Konflikt verlangen keinen erneuten Review.

## Thematische Arbeitspakete für kleine Nacharbeiten

Kleine übernommene Befunde werden nach gemeinsamem Bereich, Korrekturziel und
Prüfweg gebündelt. Vor dem Anlegen sucht die Sitzung passende offene Issues und
prüft auf Duplikate. Sie ergänzt ein passendes Paket oder legt ein begrenztes
Issue mit der [Vorlage für Review-Nacharbeiten](../../.github/ISSUE_TEMPLATE/review-follow-ups.md)
an. Solche Pakete sind die Ausnahme vom Verbot neuer `track`-Sammelissues;
ein dauerhaftes Issue für beliebige Verbesserungen ist kein Arbeitspaket.

Jeder Punkt enthält eine Checkbox mit stabiler Kennung, Fundstelle, Problem und
Beleg, gewünschter Korrektur sowie Ursprungs-PR und Review-Bezug. Das Issue nennt
Ziel, Umfang und gemeinsame Abnahme; es muss ohne Rekonstruktion des Chats
bearbeitbar und klein genug für einen überschaubaren PR sein. Befunde aus privaten
Zwischenberichten werden im Issue mit bereinigten Belegen beschrieben. Kennungen
werden nicht neu vergeben. Feature- und Release-Bezüge erhalten den passenden
Meilenstein; unabhängige Wartung braucht keinen eigenen Meilenstein.

Bei Arbeiten am betroffenen Bereich prüft die Sitzung passende offene Pakete und
nimmt zusammengehörige Punkte mit, wenn sie zum Auftrag passen. Bei der Übernahme
nennt sie im Issue die ausgewählten Kennungen und die verantwortliche Sitzung oder
Person. Der umsetzende PR nennt Issue und Kennungen; nach dem Merge werden die
Punkte mit PR, Merge-SHA und Prüfbeleg abgehakt. Teil-PRs verwenden kein `Closes`
für das ganze Paket. Das Issue schließt erst, wenn alle Punkte behoben oder
begründet verworfen sind. Bei Übergabe einer Aufgabe nennt die Sitzung verbleibende
Pakete als konkrete Wartungsaufgaben; sie verschwinden nicht aus dem Abschluss.

## Review-Beleg und GitHub-Status

Die Sitzung veröffentlicht den Beleg als neuen PR-Kommentar unter dem Konto des
Maintainers. Die erste Zeile lautet `Independent review`; unmittelbar darunter
stehen ohne Leerzeile `Reviewer`, `Head` (volle SHA) und `Result` (`pass` oder
`fail`). Nach einer Leerzeile nennt der Text Prüfumfang, bei Folgereviews den
vorherigen geprüften Head und Bericht, alle Befundentscheidungen mit Fixes oder
Issue-Verweisen, Prüfungen und Grenzen. Ein Kommentar nennt einen echten Reviewer;
die bearbeitende Sitzung darf sich nicht selbst als unabhängigen Reviewer ausgeben.

Der Workflow `.github/workflows/review-status.yml` reagiert auf neu erstellte
Kommentare mit `author_association OWNER`, die mit `Independent review` beginnen.
Er führt `scripts/review-status.mjs` aus dem Standardbranch aus, nie Code des PRs,
mit Leserechten und `statuses: write`. Nur der Kopfblock zählt: `success` entsteht
bei einem gültigen `pass` für genau den aktuellen Head; sonst entsteht `failure`,
auch bei unlesbarem Beleg oder älterem Head. Bearbeitete Kommentare lösen nichts
aus. Ein neuer Review wird deshalb neu gepostet. Das bestehende Format reicht
auch für gezielte Folgereviews; Actions und Ruleset brauchen dafür keine Änderung.

## Merge und technische Absicherung

Das Ruleset für `main` verlangt PR sowie `checks`, `pr-text` und `review`, ohne
strikte Aktualität zur Basis. Gemergt wird per Squash über GitHub, sobald alle
Prüfungen für den aktuellen Head grün sind, der Beleg `pass` lautet, keine Blocker
verbleiben und die Befundentscheidungen nachvollziehbar sind. Auf Feature-Branches
gelten dieselben Schritte als Arbeitsregel; GitHub erzwingt sie dort nicht.

PR-Titel und PR-Text werden Betreff und Text des Squash-Commits. Titel sind deshalb
Conventional Commits, auch bei Reverts (`revert: …`). `pr-text` prüft außerdem
Umschreibungen von Umlauten, doppelt kodierte Zeichen und Sitzungslinks.
Die lokalen Prüfungen, Pre-Push-Hooks und CI bleiben gemäß `AGENTS.md` Pflicht;
ein gezielter Folgereview ändert diese Prüfketten nicht.

Der Review-Status hängt am Head, nicht an der Basis. Ein konfliktfreier Merge
anderer PRs macht ihn nicht ungültig. Das Risiko zweier einzeln grüner PRs,
die zusammen brechen, trägt der volle CI-Lauf bei jedem Push auf `main`;
ein solcher Fehler wird sofort per Fix oder Revert behoben.

Der Kommentar ist eine Attestation der Sitzung, kein kryptografischer Beweis der
Unabhängigkeit. Pflicht-Checks erkennt GitHub nur am Namen. Ein PR kann über eigene
Workflows Jobs mit den erforderlichen Namen grün melden. Deshalb prüft der
Maintainer Diffs unter `.github/workflows/` und in von Workflows ausgeführten
Skripten vor dem Merge selbst. Workflows aus Forks laufen erst nach Freigabe;
dafür gilt die Actions-Einstellung „Require approval for all external contributors“.
