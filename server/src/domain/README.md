# domain

Was mehrere Features fachlich brauchen, ohne selbst eine Fläche zu sein. Warum
`hosts` hier liegt und kein Feature ist, steht in
`docs/design/feature-architecture.md`, Abschnitt 4; `containers` kam mit #281
dazu, weil Übersicht, Dateien, Hosts, Container-Routen und der Host-Zyklus
dieselben Containeransichten lesen.

| Ordner   | Inhalt                                                                                                    |
| -------- | --------------------------------------------------------------------------------------------------------- |
| `hosts/` | Host-Register (`docker_host`), Datensatz und Ansicht eines Hosts, Weg zum Agenten samt Geheimnis je Arm; Erreichbarkeit, Ausstattung und Version eines Agenten; der Host-Zyklus im Hintergrund und sein Beobachtungsspeicher |
| `containers/` | Containerlisten und Messwerte vom Agenten, Gruppierung in Stacks, Systemcontainer, Abgleich der Registry, Freigabe-Speicher |

Jedes Modul hier hat eine Tür, `index.ts`, mit benannten Re-Exporten. Von
außen wird nur sie importiert. Bei `hosts/` hält sie zurück, was ein Aufrufer
nicht in der Hand haben soll: den Schritt, der das Geheimnis eines Arms wählt
(`resolveAgentSecret`, #77). Eine Route kommt zum Agenten über
`createHostAccess(…).connect(host)`.

`domain/` importiert kein Feature, und von außen geht es nur durch die Tür.
Beides prüft `.dependency-cruiser.mjs` (`domain-not-features`,
`domain-only-through-door`).
