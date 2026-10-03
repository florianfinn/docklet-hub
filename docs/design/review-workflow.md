# Unabhängige Agentenreviews

Die bearbeitende Sitzung startet vor jedem PR-Merge einen unabhängigen Agenten mit eigenem Kontext. Der Reviewer hat den PR nicht umgesetzt und prüft Ziel, vollständigen Diff, Tests und öffentliche Daten gegen den tatsächlichen Zielbranch.

Ein vertrauenswürdiger Maintainer attestiert den realen Review mit node scripts/record-agent-review.mjs <PR> <report.json>. Der Bericht nennt reviewer, headSha, baseSha, mergeSha, result und summary. Das Skript prüft die aktuellen PR-SHAs, kontrolliert den tatsächlich veröffentlichten Text und veröffentlicht den bereinigten Beleg. Es setzt agent-review ausschließlich am geprüften PR-Test-Merge-SHA. Ändert sich Head oder Base, entsteht ein anderer Integrationscommit und der alte Status erfüllt die Schranke nicht mehr.

Rulesets für main und codex/feature-* müssen verlangen PR, checks und agent-review sowie eine aktuelle Integrationsgrundlage. GitHub-Prüfungen bauen den Test-Merge. Die Veröffentlichungs- und Commit-Prüfung bewertet dessen gesamten Quellbaum und die vollständige echte PR-Historie; GitHubs künstlicher Merge-Betreff ist keine Conventional-Commit-Entscheidung eines Beitrags.

Diese Maintainer-Attestation ist keine eigene GitHub-Identität des Agenten und kein kryptografischer Beweis seiner Unabhängigkeit. Die veröffentlichende Sitzung verantwortet den echten unabhängigen Review. Der einzelne Root-Commit wird vor der Erstveröffentlichung als vollständiger Quellbaum geprüft.
