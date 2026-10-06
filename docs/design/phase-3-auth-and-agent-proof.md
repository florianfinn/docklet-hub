# Anmeldung, Agentenvertrag und Vertrauensgrenzen

## 1. Anmeldung

Das Zielbild steht in authentication-modes.md. Genau ein Modus ist aktiv: ohne Login, lokale Anmeldung oder vertrauenswürdige Proxy-Anmeldung. Setup, Moduswechsel und Wiederherstellung müssen denselben Zugriffsschutz verwenden. Weitere Admins sind optional; zusätzliche Rollen sind eine spätere Ausbaustufe.

## 2. Herkunft und Proxy-Vertrauen

Browser-Anfragen und Agentenkommunikation sind unterschiedliche Vertrauensgrenzen. Zustandsänderungen prüfen Sitzung beziehungsweise den gewählten Modus und die zulässige Herkunft. Proxy-Identitätsheader dürfen nur aus dem konfigurierten vertrauenswürdigen Weg übernommen werden. Namen oder Hostheader allein begründen kein Vertrauen. Unerwartete externe Ziele und private Endpoint-Konfigurationen müssen für den Betreiber verständlich behandelt werden.

## 3. Gemeinsamer Vertrag

Hub und Agent importieren englische Schemas und technische Werte aus contract/. Vertragsversion und Mindest-Agent-Version begrenzen Fähigkeiten ausdrücklich. Unbekannte Gründe eines neueren Agenten werden nachvollziehbar durchgereicht, soweit das Schema dafür einen offenen Text vorsieht. Ältere Agenten brauchen einen erreichbaren Update-Weg, auch wenn normale Schreibaktionen gesperrt sind.

Der Hub-Agent-Vertrag kennt keine Netzstufe. Der Hub steht nur im eigenen Netz (LAN oder VPN); eine vom Aufrufer selbst gemeldete Stufe schützt nichts, weil jeder Inhaber des Geheimnisses sie frei setzen könnte. Die wirksamen Grenzen des Agenten sind Geheimnis, Allowlist, Pfadgrenzen der Freigaben, hinterlegte Compose-Anker, Fremdverwaltung, Kill-Switch, Selbstschutz und die Härtungsprüfung beim Anlegen und Anwenden: Neue Verstöße werden dort abgelehnt oder verlangen eine Bestätigung. Bei Aktionen an bestehenden Containern wird die Delegationssperre gemeldet und protokolliert, blockiert aber nicht. Entscheidung: #152.

## 4. Prüfungen

Schemas, Statuscodes und fehlerhafte Antwortformen sind ohne echte Dienste prüfbar. Anmeldung, Proxy-Vertrauen und Wiederherstellung werden zusätzlich am konkreten Release-Paket praktisch abgenommen. Öffentliche Fehlerbelege verwenden synthetische Identitäten.
