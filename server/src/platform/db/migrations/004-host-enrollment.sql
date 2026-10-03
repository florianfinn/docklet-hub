-- Was ein Host mitbringt, damit er sich anmelden kann — Phase 4a.
--
-- 003 trug den einen Host, den dieser Hub ohne Anmeldung kennt: den lokalen.
-- Ab hier kommen Arme dazu, und ein Arm ist mehr als Name und Adresse. Er hat
-- eine Tunneladresse, einen eigenen öffentlichen WireGuard-Schlüssel, ein
-- eigenes Agent-Secret, ein einmal gültiges Anmelde-Token und einen Zustand
-- dazwischen: angelegt, aber noch nicht angemeldet.
--
-- ⚠️ Alle Spalten kommen NULLABLE bzw. mit Vorgabe herein. Die bestehende
-- Zeile des lokalen Hosts bleibt damit gültig, ohne dass diese Migration sie
-- kennt: sie fällt in die Vorgaben (state = 'registered', keine
-- Tunneladresse, kein Token). Eine Spalte mit NOT NULL und ohne Vorgabe hätte
-- den Start eines bestehenden Hubs angehalten — auf einer frischen Datenbank
-- wäre das nie aufgefallen.
--
-- Die Reihenfolge in dieser Datei ist Absicht: erst Spalten, dann die
-- Altdaten füllen, dann die Bedingungen. Umgekehrt schlüge die Bedingung
-- „registriert heißt: registered_at steht" gegen die Altzeile fehl, die ihn
-- noch nicht hat.

ALTER TABLE docker_host
  -- Die Adresse, unter der der Hub diesen Arm im Tunnel erreicht. `inet` und
  -- nicht `text`: Postgres normalisiert damit die Schreibweise, und der
  -- eindeutige Index unten lässt sich nicht durch „10.254.0.02" umgehen.
  --
  -- ⚠️ NULL für den lokalen Host. Er steht im Compose-Netz, nicht im Tunnel.
  ADD COLUMN tunnel_address       inet,
  -- Der ÖFFENTLICHE Schlüssel des Arms. Der private liegt ausschließlich im
  -- erzeugten Archiv und wird hier bewusst NICHT gespeichert: was der Hub
  -- nicht hat, kann aus ihm auch nicht abfließen. Ist das Archiv verloren,
  -- wird es neu erzeugt — und rotiert dabei Schlüssel, Secret und Token.
  ADD COLUMN wireguard_public_key text,
  -- Das gemeinsame Geheimnis zwischen Hub und genau diesem Agenten. Je Host
  -- ein eigenes: ein Wert für alle wäre ein Schlüssel, der mit jedem weiteren
  -- Arm mehr wert wird.
  ADD COLUMN agent_secret         text,
  -- Der Abdruck des einmal gültigen Anmelde-Tokens (SHA-256, hex). Das Token
  -- selbst steht nur im Archiv. Nach dem Verbrauchen steht hier NULL.
  ADD COLUMN token_hash           text,
  -- 'pending' = angelegt, Archiv erzeugt, Agent hat sich noch nicht gemeldet.
  -- 'registered' = der Agent hat sich mit seinem Token gemeldet.
  --
  -- ⚠️ Es gibt bewusst KEINEN dritten Zustand „bestätigt" (#19). Wer
  -- registriert ist, ist sichtbar; ein Bestätigungsschritt wäre ein Klick,
  -- der nichts entscheidet, was das Token nicht schon entschieden hat.
  ADD COLUMN state                text        NOT NULL DEFAULT 'registered',
  -- Fehlversuche der Anmeldung. Ab der Marke in host-record.ts nimmt der Hub
  -- das Token nicht mehr an, auch wenn es stimmt — der Weg zurück ist ein
  -- neues Archiv.
  ADD COLUMN failed_attempts      integer     NOT NULL DEFAULT 0,
  -- Wann sich der Agent gemeldet hat. `created_at` aus 003 sagt, wann der
  -- Betreiber den Host angelegt hat; zwischen beiden liegt die Zeit, in der
  -- das Archiv unterwegs war.
  ADD COLUMN registered_at        timestamptz,
  -- Ein abweichender Endpoint für genau diesen Arm. Leer heißt: der Wert aus
  -- der Umgebung gilt. Gebraucht wird das, wenn ein Arm den Hub über einen
  -- anderen Namen erreicht als alle anderen.
  ADD COLUMN endpoint_override    text;

-- Die Altzeile bekommt ihren Zeitstempel, bevor die Bedingung ihn verlangt.
-- `created_at` und nicht `now()`: der lokale Host war da, seit er eingetragen
-- wurde, und ein Zeitstempel, der den Tag der Migration nennt, wäre eine
-- Aussage über diese Migration und nicht über den Host.
UPDATE docker_host SET registered_at = created_at WHERE registered_at IS NULL;

ALTER TABLE docker_host
  ADD CONSTRAINT docker_host_state_check
    CHECK (state IN ('pending', 'registered')),

  -- Zwei Arme mit derselben Tunneladresse wären zwei Arme, von denen einer
  -- nicht erreichbar ist — und welcher, entschiede die Routingtabelle.
  --
  -- ⚠️ Diese Bedingung IST die Vergabestelle der Adressen, nicht ein Netz
  -- darum herum. Der Hub sucht die nächste freie Adresse und lässt sich hier
  -- sagen, ob er zu spät war (hosts.ts). Ein Zähler im Speicher hätte bei
  -- zwei gleichzeitigen Anlegern zweimal dieselbe Zahl geliefert, und beide
  -- Archive trügen dieselbe Adresse.
  ADD CONSTRAINT docker_host_tunnel_address_key UNIQUE (tunnel_address),

  -- Eine Tunneladresse ist eine EINZELNE Adresse, kein Netz.
  --
  -- ⚠️ Ohne diese Bedingung ist der Fehler still: `inet` vergleicht Adresse
  -- UND Präfixlänge, also ist '10.254.0.2/24' nicht gleich '10.254.0.2/32'.
  -- Eine Zeile mit der falschen Länge wäre über ihre eigene Adresse nicht
  -- mehr auffindbar, und die Anmeldung dieses Arms scheiterte mit „unbekannte
  -- Quelle" statt mit einem Schemafehler.
  ADD CONSTRAINT docker_host_tunnel_address_host_check
    CHECK (tunnel_address IS NULL OR masklen(tunnel_address) = 32),

  -- Der lokale Host steht nicht im Tunnel und meldet sich nicht an.
  ADD CONSTRAINT docker_host_local_check
    CHECK (kind <> 'local' OR (tunnel_address IS NULL AND state = 'registered')),

  -- Ein Arm ohne Tunneladresse, ohne Secret oder ohne Schlüssel ist kein
  -- halber Arm, sondern eine Zeile, die nie funktionieren kann.
  ADD CONSTRAINT docker_host_arm_check
    CHECK (
      kind = 'local'
      OR (tunnel_address IS NOT NULL AND agent_secret IS NOT NULL AND wireguard_public_key IS NOT NULL)
    ),

  -- Wer auf seine Anmeldung wartet, hat ein Token. Ohne wäre die Zeile ein
  -- Arm, der sich nie melden kann und den niemand als kaputt erkennt.
  ADD CONSTRAINT docker_host_pending_token_check
    CHECK (state <> 'pending' OR token_hash IS NOT NULL),

  -- Und wer registriert ist, hat einen Zeitpunkt dafür.
  ADD CONSTRAINT docker_host_registered_at_check
    CHECK (state <> 'registered' OR registered_at IS NOT NULL),

  ADD CONSTRAINT docker_host_failed_attempts_check
    CHECK (failed_attempts >= 0);
