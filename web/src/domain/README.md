# domain

Was mehrere Features fachlich brauchen, ohne selbst eine Fläche zu sein — im
Server ist das `hosts` (`docs/design/feature-architecture.md`, Abschnitt 4).
Im Web liegt hier seit #256 `hosts/`: die Liste der Arme (`useHosts()`), die
der Host-Bildschirm und die Farbtafel der Einstellungen über einen
gemeinsamen Eintrag im Zwischenspeicher lesen. Seit #267 trägt `hosts/` auch,
was jede Fläche an einem Arm zeigt (Ton, Statusmarke, Zähler, Raster), die Typen
eines Hosts und die Hub-Adresse nach außen (`hub-network.ts`).

Jedes Modul hier hat eine Tür, `index.ts`, mit benannten Re-Exporten und ohne
`export *`; von außen wird nur sie importiert. `domain/` kennt kein Feature.
Beides prüft `.dependency-cruiser.mjs` (`domain-not-features`,
`domain-only-through-door`), die Türen dazu
`web/tests/import-boundaries.test.mjs`.
