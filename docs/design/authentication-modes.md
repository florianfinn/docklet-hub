# Anmeldemodi und Wiederherstellung

Genau ein Modus ist aktiv: ohne Login, lokaler Login oder vertrauenswürdiger Proxy-Login. Setup und Betriebswechsel tragen denselben Vertrag. Zunächst gibt es Admins; zusätzliche Rollen sind eine spätere Erweiterung.

Der Proxy-Modus vertraut einem nachgewiesenen Zugriffsweg, nicht einem beliebigen Header. Vor Umsetzung werden Listener, direkte Erreichbarkeit, Account-Zuordnung und Wiederherstellung entschieden. Ein Wechsel darf keinen unbeabsichtigten zweiten Zugangsweg öffnen.
