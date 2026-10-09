# Tickets und Meldekanäle

Tickets machen belegte Betriebsereignisse im Hub sichtbar. Discord, SMTP-E-Mail,
Gotify und generischer Webhook ergänzen diese Sicht durch ausdrücklich aktivierten
Versand. Ticket-Erzeugung und externe Zustellung sind getrennt: Ein nicht
konfigurierter Dienst verhindert kein Ticket. Die Grundlage betrifft #203 und die
Produktentscheidungen aus #22, #23, #24, #157 und #46.

## Quellen, Episoden und Lifecycle

Fünf Ereignisschlüssel bilden die vorhandenen Produktquellen ab:

| Ereignis | Ziel und Nachweis | Empfohlene Handlung |
| --- | --- | --- |
| `self-healing-exhausted` | Container oder gebündelter Stack; vorhandener Selbstheilungsstatus mit ausgeschöpftem Budget | `inspect-self-healing` |
| `connection-lost` | Host; durchgehend fehlende Verbindung seit mindestens 300.000 ms | `check-connection` |
| `update-failed` | Host bei Agent-Update, Container oder Stack bei Container-Update; endgültiges belegtes Update-Ergebnis | `inspect-update` |
| `agent-update-available` | Host; vorhandenes geprüftes Agent-Update-Angebot | `review-update` |
| `container-update-available` | Container oder Stack; nachgewiesenes Angebot einer tatsächlichen Image-Version | `review-update` |

Container-Update-Verfügbarkeit nutzt das vorhandene Agent-`GET
/containers/:id/update-check`, das echte lokale und entfernte Registry-Digests
liest. Der Hub muss diese Quelle autonom anbinden, Antwort und Update-Eignung
prüfen und unbekannte Digests als unbekannt behandeln. Laufzeitstatus, Tags allein, ein Pull-Wunsch oder erfundene Statusfelder sind
kein Angebot. Ohne gültigen Nachweis entstehen keine Verfügbarkeitstickets; die autonome
Quellenanbindung ist eine technische Abhängigkeit. Die Agent-API wird für diese
Grundlage nicht geändert. `CONTRACT_VERSION` bleibt 13, der Agent-Fingerprint und
Release-/Mindest-Agent-Version bleiben unverändert. Agent-Jobs sind flüchtig
und auf 24 Stunden bzw. 256 jüngste Ergebnisse begrenzt; ein Agent-Neustart kann
sie verlieren. Self-update liefert den letzten persistierten Lauf, Healing
höchstens 256 geschlossene Incidents. Polling garantiert keine Historie bei
längerer Hub-Abwesenheit oder verlorenen Agent-Jobs. Der Hub speichert erkannte
Tickets selbst 30 Tage; vollständige rückwirkende Erfassung erfordert einen
eigenen dauerhaften Ergebnis-Handoff und wird hier nicht zugesagt. Die neuen Hub/Web-Schemas
verwenden `zod/mini` und `NOTIFICATION_API_VERSION = 1`; sie sind kein Bestandteil
des Agent-Drahtvertrags.

Eine Episode beginnt mit einem belegten neuen Ereignis. Der Hub erzeugt einen
stabilen, begrenzten `episodeKey`; Ereignis, Ziel und Episode bilden gemeinsam den
persistenten Deduplizierungsschlüssel. Ein Update-Lauf identifiziert die
Fehlerepisode, ein angebotenes Update dessen Version/Digest. Wiederholte Messungen
aktualisieren dasselbe Ticket. Verfügbarkeit einer anderen Version ist eine neue
Episode. Gleiche Angebote erzeugen keine erneute Meldung.

Tickets haben genau `open`, `acknowledged` und `resolved`. Quittieren setzt
`acknowledgedAt`, bestätigt die Wahrnehmung und beendet Erinnerungen. Es setzt
kein Selbstheilungsbudget zurück, ruft keine Reparatur auf und erzeugt keine
Nachricht. Die bestehende separate Aktion zur Wiederfreigabe der Selbstheilung
bleibt erforderlich. Die vorhandene Agent-SelfHealingAcknowledge-Aktion setzt
das Budget zurück und darf deshalb nie als Ticket-Ack aufgerufen werden. Ein
stabilitätsbedingtes Refill schließt den Agent-Incident nicht; dessen offener
Status allein ist ebenso wenig ein Recovery-Nachweis wie ein gefülltes Budget.
Recovery braucht frischen belegten gesunden Laufzeit-/Healing-Zustand. Wiederholtes Quittieren ist idempotent; erledigte Tickets
bleiben erledigt. Die API bietet weder manuelles Erledigen noch Wiederöffnen.

Erledigen setzt `resolvedAt` ausschließlich nach belegter Erholung: aktuelle
Verbindung, zurückgesetzter/erholter Selbstheilungsvorfall, erfolgreiches
Folgeupdate oder belegtes Verschwinden/Installieren des konkreten Update-Angebots.
Fehlende, veraltete oder Offline-Daten erledigen nichts. Erst eine neue Episode
nach Erholung erzeugt ein neues Ticket. Erledigte Tickets bleiben 30 Tage nach
`resolvedAt`; offene und quittierte Tickets werden nie durch Retention entfernt.

Eine Verbindungsunterbrechung unter fünf Minuten erzeugt kein Ticket. Nach fünf
Minuten entsteht ein Hostticket mit gebündelten betroffenen Containern, keine
Container-Ticketflut. Ohne Nachweis der Ursache lautet die Aussage nur
Verbindungsverlust; Agent-Ausfall und Host-Ausfall werden nicht behauptet.
`affectedContainerCount` zählt alle Betroffenen; `affectedContainers` enthält
höchstens 200 eindeutige Einträge. Die Oberfläche zeigt eine Kürzung anhand der
Differenz. Alle anderen Ereignisse haben eine leere Betroffenenliste und Zähler 0.

## Dienste, Notify-Tabs und Vererbung

Der globale Notify-Tab verwaltet genau einen Dienst pro Transport, das globale
Format, globale Zieldefaults und eigene globale Hostregeln. Einrichten eines
Dienstes aktiviert keinen Versand. Werkswerte: `defaults = []`, `hostRules = []`,
Logs aus, Recovery aus, Zusatztext leer. Update-Verfügbarkeit erscheint damit nur
im Hub, bis sie ausdrücklich als Ereignis ausgewählt wird.

Container und Stacks besitzen jeweils einen Notify-Tab mit Mehrfachauswahl der
Dienste und Ereignisse. Ausklappbare Custom-Felder bieten Zusatztext, Logs-Opt-in,
Recovery und bei Discord/Webhook ein anderes Versandziel. Ein Discord-Kanal wird
über seinen eigenen Discord-Webhook eingerichtet. SMTP-Empfänger und Gotify-Ziel
werden ausschließlich global konfiguriert. Es gibt keine transportübergreifende
Ausweichzustellung.

`mode: inherit` übernimmt die ganze Auswahl samt Ergänzungen: Stack von globalen
Zieldefaults, Container vom Stack, ohne Stack direkt von globalen Zieldefaults.
`mode: explicit` ersetzt sie vollständig. `selections: []` ist ausdrücklich aus.
Eine explizite Container-Auswahl übernimmt keine Stack-Ergänzungen, auch nicht bei
gleichem Dienst. `resolveNotificationSelection` ist die gemeinsame reine Regel
für diese Auswahl; bei einem Container ohne Stack wird als Stack `inherit`
übergeben. `inheritedFrom` nennt die wirksame Ebene, `effective` enthält ihre
vollständige Auswahl. Doppelte Dienste oder Ereignisse werden abgelehnt. Der
persistente Versand-Schlüssel Ticket/Episode, Phase und Dienst verhindert mehrere
Nachrichten je Dienst/Ereignis unabhängig von wiederholter Quellenabfrage.

Jede ausgewählte Dienstregel nennt mindestens ein Ereignis. Zielregeln erlauben
Selbstheilungsbudget-Ende, Update-Fehler und Container-Update-Angebote. Hostregeln
erlauben Verbindungsverlust, Agent-Update-Fehler und Agent-Update-Angebote; sie
werden nicht von Zieldefaults abgeleitet. Eine deaktivierte Hostregel entspricht
fehlender Auswahl. Bei einem Stack-Ereignis wird die Stack-Regel verwendet, bei
einem Container-Ereignis dessen aufgelöste Regel; ein gebündeltes Stack-Ereignis
wird nicht zusätzlich als Einzelereignis an jeden Container versendet.

Optionale Flags der wirksamen Auswahl überschreiben Dienstdefaults auch bei
`false`. Fehlende Flags übernehmen Dienstdefaults. Zusatztext des Dienstdefaults
und Zusatztext der wirksamen Auswahl werden in dieser Reihenfolge durch einen
Zeilenumbruch verbunden; ein leerer lokaler Text fügt nichts hinzu. Das globale
Pflichtformat bleibt erhalten. Ziel-Destination fehlt oder `keep`: bisherige
lokale Destination erhalten; `clear`: lokale Destination entfernen und globales
Dienstziel nutzen; `set`: vollständig ersetzen. Bei erstmals expliziter Auswahl
ist `keep` ohne vorhandene lokale Destination gleich keinem Override. Beim Wechsel
auf `inherit` oder Weglassen eines Dienstes werden dessen lokale Overrides gelöscht.

Bulk ist eine echte Auswahl von 1 bis 200 Containern und/oder Stacks und setzt
für alle dieselbe explizite Konfiguration oder Vererbung. Explizit leer deaktiviert
alle ausgewählten Ziele. Die Operation ist atomar; unbekannte Ziele, ungültige
Konfiguration und Revisionskonflikte verändern keines der Ziele. Ein gemischter
Bulk aus Stack und Container darf bewusst beide Ebenen setzen; die Containerregel
hat weiter Vorrang. Kein implizites Hinzufügen zu vorhandenen Auswahlen.

## Geheimnisse und Nachricht

Schreibschemas und Leseschemas sind getrennt. Secrets und private Endpoints werden
nie als gespeicherte Rohwerte zurückgegeben. Lesesichten enthalten ausschließlich
`configured`, `destinationConfigured` und `credentialConfigured`, lokale Overrides
nur `destinationConfigured`. Die UI zeigt dafür eine feste Maske, niemals einen
Ausschnitt des Secrets. Auch SMTP-Host, Absender und Empfänger sind private
Verbindungsdaten und stehen nur im Schreibobjekt. `configured` bedeutet vollständig
und strukturell gültig eingerichtet, nicht erfolgreich erreicht. Keine Credentials
werden als Teil eines Ticketgrunds oder Queuefehlers ausgegeben.

Jedes Geheimnis hat den Schreibbefehl `keep`, `set` oder `clear`; `set` akzeptiert
nur nichtleere Werte, höchstens 4096 Zeichen. SMTP ersetzt die Verbindung atomar,
mit TLS oder verpflichtendem STARTTLS; keine unverschlüsselte Versandoption.
Benutzername/Passwort dürfen beide `null` sein; Auth-Kombination und erforderliche
Dienstfelder werden vor Commit auf Vollständigkeit geprüft. Unvollständige Dienste
können unselektiert gespeichert werden; ein ausgewählter unvollständiger Dienst
führt zu `configuration-incomplete`. `authorization` ist ein einzelner Headerwert,
keine freie Headerliste; CR/LF und Kontrollzeichen sind vor Speicherung abzulehnen.
URLs erlauben HTTP/S ohne eingebettete Benutzerinformationen. Notify-Konfiguration
liegt als private Laufzeitinformation in der Hub-Datenbank wie bestehende
Agent-Secrets. DB-Zugriffsrechte und geschützte Betriebsbackups sind erforderlich;
es entsteht keine neue Schlüssel- oder Vault-Pflicht. Die UI-/DB-Konfiguration ist
maßgeblich, ungenutzte SMTP-/Discord-Env-Platzhalter aktivieren keinen Versand.
Deren Dokumentation und Entfernung gehören zum Transport-/Integrationspaket.
Für SMTP ist server-only Nodemailer (MIT) wegen TLS und MIME begründet;
eine selbstgebaute SMTP-Implementierung wird nicht verwendet. Der Transport muss
zusätzlich Destinationen, Redirects, TLS und Netzwerkzugriff gemäß Vertrauensgrenze
prüfen; Schema-Parsing allein ist keine SSRF-Abwehr. Keine Secretwerte in Logs,
Fehlerantworten, Audit-Differenzen oder Prozessargumenten.

Das globale Format enthält alle vier festen Tokens `{target}`, `{cause}`, `{time}`
und `{action}`. Zusatztext darf diese Tokens verwenden. Unbekannte Tokens, einzelne
Klammern, Ausdrücke und verschachtelte Templates werden abgelehnt. Es gibt keine
Auswertung von Code, keine beliebigen Objektpfade und keine Rekursion. Globales
Format höchstens 2000, jeder Zusatztext höchstens 1000 Zeichen; diese Grenzen zählen
JavaScript-Stringlänge. Nach einfacher Tokenersetzung bleiben Ziel, bereinigte
Ursache, Zeitpunkt und empfohlene Handlung Pflichtinformationen. Transportgerechtes
Escaping erfolgt nach der Ersetzung, etwa JSON, Mailtext/MIME oder Discord-Markup
und deaktivierte Mentions; Texte steuern keine Header oder URLs.

Der Hub zeigt für #157 einen bereinigten Ticket-Logauszug über `evidence.logs`.
`notificationTicketEvidenceSchema` enthält `notificationLogEvidenceSchema`: genau
`{ state: "available", text, truncated }` oder `{ state: "unavailable", reason }`.
Verfügbare Evidenz hat 1 bis 4000 Zeichen und einen expliziten Kürzungswert.
`reason` ist ausschließlich `not-collected`, `source-unavailable` oder
`redaction-unavailable`; ein nicht verfügbarer Auszug enthält niemals Text.
Fehlender sicherer Bereinigungsnachweis führt zu `redaction-unavailable`, nie zum
Rückfall auf rohe Logs. Diese Schemaform beweist keine Inhaltsbereinigung; die
Quelle muss das sichere Ergebnis nachweisen. Der Hub-Logauszug aktiviert keinen
externen Versand. Tickets ohne gesammelte Logs liefern `not-collected`.

Logs sind ausschließlich pro wirksamem Versandziel opt-in, standardmäßig aus.
Der Hub bereinigt Ursachen und Logs durch ein Positivmodell; rohe Agentdiagnostik,
Credentials, private Endpoints und Verbindungskonfiguration werden nie automatisch
kopiert. Ein Logauszug hat höchstens 4000 Zeichen. Die Nachricht hat höchstens 8000
Zeichen vor transportbedingtem Escaping und zusätzlich die Grenze des Transports.
Optionale Logs/Zusatztexte werden sichtbar gekürzt oder in einem eindeutig
markierten gekürzten Format ausgegeben; Pflichtinformationen werden nicht still
entfernt. Format- und Schema-Grenzen ersetzen keine Inhaltsbereinigung.

## Persistente Zustellung und Grenzen

Eine Ticketänderung und ihr Zustellungsauftrag werden transaktional gespeichert.
Queue-Schlüssel sind Ticket/Episode, `initial` oder `recovery`, Dienst und
`generation`. Tests verwenden `phase: test`, `ticketId: null`. Recovery wird nur
beim belegten Erledigen und aktivierter Recovery-Regel versendet; Quittieren sendet
nichts. Es gibt keine periodischen fachlichen Erinnerungen. Bereits akzeptierte
Initialzustellungen und ihre Transportwiederholungen bleiben beim Quittieren
bestehen; das ist kein neuer Ereignisversand.

`queued` hat 0 Versuche, `sending` zählt den gestarteten Versuch. Nach einem
vorübergehenden Fehler oder Timeout folgen höchstens drei Wiederholungen mit
Pausen 30 Sekunden, 2 Minuten und 10 Minuten jeweils **nach dem vorherigen
Fehlversuch**, insgesamt höchstens vier Versuche. Authentifizierung, Validation,
endgültige Ablehnung und fehlende Konfiguration führen direkt zu `failed`.
`retrying` enthält einen zukünftigen `nextAttemptAt` und einen vorübergehenden
Fehler. Ein Versuch endet spätestens nach 15 Sekunden durch Timeout/Abbruch.
`delivered`, `failed` und `cancelled` sind terminal und haben `finishedAt`, aber
keinen nächsten Versuch. Fehler sind feste Kategorien statt Transport-Rohtext.

Worker beanspruchen Aufträge atomar mit Lease; Wiederanlauf übernimmt abgelaufene
Leases und konserviert Versuchszahl/Fälligkeit. Ein nach verlorenem Antwortsignal
unbekanntes Ergebnis zählt als Timeout. Externe Zustellung kann deshalb nur
at-least-once sein; Idempotenzschlüssel werden wo unterstützt mitgesendet. Lokale
Deduplizierung garantiert keine Exactly-once-Zustellung bei fremden Diensten.

Manuelles erneutes Senden ist für `failed` oder `cancelled` mit erwarteter
Generation zulässig, setzt dieselbe Zustellung auf `queued`, erhöht `generation`
um eins, setzt Versuche/Fehler/Endzeit zurück und verwendet aktuelle Konfiguration.
Ein aktiver oder zugestellter Auftrag ergibt `conflict`; parallele Retry-Aufrufe
können keinen Doppelversand anlegen. Die Historie hält den vorherigen Endfehler.
Initial- und Recovery-Versand verwenden sonst einen bereinigten Inhalts- und
Konfigurationssnapshot; eine Regeländerung erzeugt keinen rückwirkenden Versand.
Entfernte Destinationen und widerrufene Credentials dürfen keine weitere Zustellung
über den alten Snapshot erlauben: verbleibende betroffene Aufträge werden sichtbar
`cancelled`. Secrets liegen geschützt referenziert, nie im öffentlichen Queuemodell.

Höchstens 10.000 aktive Queueeinträge; bei voller Queue bleibt der Versandbedarf
als persistenter Ticketauftrag bestehen und wird später aufgenommen.
`pendingDeliveryCount` macht noch nicht in die Queue aufgenommene Absichten pro
Ticket sichtbar (höchstens acht: vier Dienste mal Initial-/Recoveryphase).
Keine offene Episode oder Versandabsicht geht still verloren. Direkte Test-/Retry-
Anfragen antworten mit `queue-full`. Terminale Zustellungen bleiben höchstens 30
Tage und höchstens 10.000 Einträge; älteste terminale Einträge werden zuerst
entfernt. Pro Ticket bleiben höchstens 100 interne Historieneinträge. Eine öffentlich
sichtbare Historie oder ein Kürzungshinweis wird ohne eigenes Wire-DTO nicht
zugesagt; die Ticketansicht liefert Zustand, Evidenz und ausstehende Absichten. Episoden-Deduplizierung verhindert Wiederholungen desselben Vorfalls. Pagination
begrenzt Antworten und Leseaufwand, nicht den Gesamtbestand aktiver Tickets:
Neue offene Episoden können diesen Bestand weiter vergrößern. Offene und quittierte
Tickets werden dafür nicht gelöscht.

## Stabile Hub/Web-API (Grundlage 1)

Alle Routen liegen unter `/api/notifications`. Lesezugriff erfordert eine
angemeldete Sitzung für Tickets und Deliveries. Alle Notify-Settings-/Zielregel-
Reads sowie Konfigurationsänderung, Quittierung, Test und Retry benötigen
Adminrechte und vorhandene Origin-/CSRF-Prüfung. Es entstehen keine anonymen
Webhook-Eingangsrouten. HTTP-Queries konvertiert der Router explizit in den unten
angegebenen Typ, etwa `limit` zur Zahl; Schema akzeptiert keine stillen Coercions.
Das bestehende allgemeine `GET /api/settings` bleibt für alle Konten secretfrei
und enthält keine Notify-Verbindungsdaten; maskierte Notify-Admin-Reads bleiben
in der hier genannten separaten API. IDs und Cursor sind opaque Strings von 1 bis 200 Zeichen. Zeitpunkte sind UTC-ISO
8601. Konfiguration hat eine gemeinsame monoton steigende `revision` für globale
Settings und alle Zielregeln; jeder Write prüft `expectedRevision` atomar und erhöht
sie genau einmal. Reads liefern diesen Stand, Bulk liefert ihn für alle Ziele.

| Methode und relativer Pfad | Eingabeexport | Erfolgsantwortexport / HTTP |
| --- | --- | --- |
| GET `/settings` | keine | `notificationSettingsResponseSchema` / 200 |
| PUT `/settings` | `notificationSettingsWriteSchema` | `notificationSettingsResponseSchema` / 200 |
| GET `/hosts/:hostId/stacks/:projectName` | Pfad-ID | `notificationScopeResponseSchema` / 200 |
| PUT `/hosts/:hostId/stacks/:projectName` | `notificationScopeRequestSchema` | `notificationScopeResponseSchema` / 200 |
| POST `/targets/read` | `notificationTargetRequestSchema` | `notificationScopeResponseSchema` / 200 |
| PUT `/targets` | `notificationTargetWriteRequestSchema` | `notificationScopeResponseSchema` / 200 |
| PUT `/selections/bulk` | `notificationBulkRequestSchema` | `notificationBulkResponseSchema` / 200 |
| POST `/channels/test` | `notificationTestRequestSchema` | `notificationDeliveryResponseSchema` / 202 |
| GET `/tickets` | `notificationTicketsQuerySchema` | `notificationTicketsResponseSchema` / 200 |
| GET `/tickets/counts` | keine | `notificationCountsResponseSchema` / 200 |
| GET `/tickets/:ticketId` | Pfad-ID | `notificationTicketResponseSchema` / 200 |
| POST `/tickets/:ticketId/acknowledge` | `notificationAckRequestSchema` (`{}`) | `notificationTicketResponseSchema` / 200 |
| GET `/deliveries` | `notificationDeliveriesQuerySchema` | `notificationDeliveriesResponseSchema` / 200 |
| GET `/deliveries/:deliveryId` | Pfad-ID | `notificationDeliveryResponseSchema` / 200 |
| POST `/deliveries/:deliveryId/retry` | `notificationRetryRequestSchema` | `notificationDeliveryResponseSchema` / 202 |

Globale Antwort ist `{ notifications: { revision, channels, format, defaults,
hostRules } }`, Zielantwort `{ target, revision, configuration, inheritedFrom,
effective }`, Bulkantwort `{ revision, targets }`. Einzelantworten sind `{ ticket }`
bzw. `{ delivery }`. Listen sind `{ tickets, nextCursor }` oder `{ deliveries,
nextCursor }`, maximal 100 Einträge, Standardlimit 50. Sortierung: `createdAt` bei
Deliveries bzw. `openedAt` bei Tickets absteigend, ID als stabiler Tie-Breaker.
Cursor bindet Sortierung und Filter; ungültiger Cursor ergibt `invalid-input`.
Ticketfilter: `state`, `event`, `hostId`, `targetKind`; Deliveryfilter: `ticketId`,
`state`, `channel`. Querywerte dürfen jeweils nur einmal vorkommen.

Die zentrale Ticketseite bietet diese Filter und interne Direktlinks, abgeleitet
aus dem typisierten Ziel statt frei gelieferten URLs. Eine Navigation zeigt
`active = open + acknowledged`; erledigte Tickets zählen nicht. Die Antwort
`{ open, acknowledged, active }` zählt Tickets, keine betroffenen Container und
keine Zustellungsversuche. Zählung ist global und unabhängig vom Seitenfilter.

Fehlerantwort ist immer `notificationFailureSchema`, `{ error: <key> }` ohne
Rohdetails: 400 `invalid-input`, 401 `unauthenticated`, 403 `admin-required` oder
`forbidden-origin`, 404 `target-unknown`, `ticket-unknown`, `delivery-unknown`,
409 `conflict`, 422 `channel-unconfigured` oder `configuration-incomplete`,
503 `queue-full`. Jede konfigurative Schreibanfrage ist ein vollständiger Ersatz
der angegebenen Ebene; nur Geheimnisbefehle erlauben gezieltes Beibehalten. Alle
Schreibschemas sind strict und lehnen zusätzliche Felder wie `rearm` ab.

## Abnahmegrenzen

Gemeinsame Schematests belegen gültige und ungültige Daten, Secret-Trennung,
Platzhaltergrenzen, Auswahldeduplizierung, Vererbung inklusive explizit leer,
Bulk und Hostregeln sowie konsistente Ticket-/Queueansichten. Schema-Fixierung
belegt keine tatsächliche Zustellung, Inhaltsbereinigung, Registry-Verfügbarkeit,
Transaktionsatomarität, Retention oder Wiederanlauf. Diese Eigenschaften verlangen
in den jeweiligen Backend-, Quellen-, Transport- und UI-Paketen echte Tests mit
injizierter Uhr/Transport sowie praktische Abnahme der vollständigen Integration.

Zielidentitäten folgen dem vorhandenen Update-/Stop-Intent-Vokabular: Stack
`{ kind: "stack", hostId, projectName }`, Einzelcontainer `{ kind: "container",
hostId, target: { kind: "container", containerName } }`, Compose-Dienst mit
`target: { kind: "compose", projectName, serviceName }`. Docker-IDs sind nur
aktuelle Ausführungsbindungen und stehen nicht im persistenten Override-Schlüssel.
`POST /targets/read` ist ein ausschließlich lesender Admin-Lookup mit strukturiertem
Ziel, `PUT /targets` setzt `{ target, expectedRevision, configuration }`. Das
Stack-Pfadpaar ist dieselbe Operation in pfadbasierter Form. Namenswechsel oder
Projektwechsel übertragen keine Konfiguration automatisch; verschwundene Ziele
bleiben als inaktive Zuordnung erhalten, ohne Versand. Erneutes Auftreten desselben
Namens erfordert nach nachgewiesenem Entfernen explizite Admin-Bestätigung durch
einen Ziel-Write, bevor alte Regeln wirksam werden. Bloße Offline-Daten sind kein
Entfernen. Skalierte Compose-Dienste teilen dieselbe Dienstregel; Ereignisepisoden
bleiben pro tatsächlich betroffenem Vorfall unterscheidbar. Ticket-Ziel und Label
bleiben für die Historie erhalten, auch wenn ein Direktlink kein Ziel mehr findet.

## Persistenzgrenze

Die PostgreSQL-Persistenz hält globale Settings und Zielregeln unter einer
gemeinsamen revisionierten Singleton-Sperre. Zielschlüssel verwenden Host, Projekt
und Container-/Dienstname, keine flüchtige Docker-ID. Eine belegte Entfernung
hinterlässt eine inaktive Zuordnung; Wiederauftreten aktiviert alte Regeln erst
nach einem expliziten Admin-Write. Offline-Beobachtungen sind keine Entfernung.

Ticket und Initial-/Recovery-Absichten entstehen in derselben Transaktion.
Die Absicht bleibt bis zur atomaren Queue-Aufnahme gespeichert; Queueüberlauf
verliert daher keinen Versandbedarf. Aufgenommene Absichten bleiben als
Deduplizierungsbeleg am Ticket. Retention löscht ausschließlich erledigte Tickets
nach 30 Tagen; noch nicht aufgenommene Absichten verhindern die Löschung bis zur
Aufnahme. Der Queue-Owner muss referenzierte aktive Zustellungen vor Löschung
schützen und seine terminale Retention separat durchsetzen.

Öffentliche Lesesichten werden mit den gemeinsamen Contract-Schemas geprüft.
Private Verbindungsdaten bleiben im Runtime-Repository; Queue-Snapshots tragen
nur eine Bindungsprüfsumme und einen Zielregelverweis. Die Queue prüft vor Versand
aktuelle Regeln und Credentials und beendet widerrufene Bindungen sichtbar.
Querygebundene signierte Cursor verwenden einen stabil injizierten privaten
Schlüssel; die App ist für dessen geschützte dauerhafte Bereitstellung zuständig.
