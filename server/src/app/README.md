# app

Setzt den Server zusammen: `router.ts` legt den Router an, hängt die
Herkunftsprüfung vor alles und meldet die Einträge der Feature-Liste
`features.ts` in ihrer Reihenfolge an; `router-support.ts` trägt `ApiOptions`,
das, was `index.ts` jedem Eintrag mitgibt. `app/` darf jede Schicht darunter
importieren, ein Feature nur über seine Tür `index.ts`; nichts darunter
importiert `app/`.

Daneben liegen die Tests, die den ganzen Router bauen (`*-routes.test.ts`,
`request-origin-routing.test.ts`, `enrollment-integration.test.ts` und ihre
Prüfstände `exec-test-support.ts`, `file-routes-test-support.ts`). Sie prüfen
eine Fläche durch die echte Reihenfolge der Zwischenschichten und können
deshalb nicht im Feature liegen: ein Feature importiert `app/` nicht. Die
Tests ohne Express stehen im Feature selbst (`features/<name>/*.test.ts`).

Bis #271 lag dieser Ordner als `server/src/api/` neben `server/src/features.ts`.

Regeln und Begründung: `docs/design/feature-architecture.md`, Abschnitte 2
und 3. Die Grenzen prüft `.dependency-cruiser.mjs`.
