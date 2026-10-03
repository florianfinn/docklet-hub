-- Die Hosts, deren Agenten dieser Hub anspricht.
--
-- In dieser Phase gibt es genau einen: den lokalen, der im selben
-- Compose-Stack steht. Er wird nicht registriert, sondern eingetragen — seine
-- Adresse und sein Geheimnis stehen in der Umgebung, und der Hub gleicht die
-- Zeile beim Start dagegen ab (server/src/hosts/local-host.ts). Die
-- Registrierung weiterer Hosts über einen Einmal-Token ist Phase 4; sie füllt
-- dieselbe Tabelle.
--
-- ⚠️ Die Spaltennamen sind hier snake_case und ohne Anführungszeichen, anders
-- als in 002. Das ist kein Versehen: die camelCase-Namen dort gibt better-auth
-- vor, hier gilt die Postgres-Konvention. Wer beide Tabellen nebeneinander
-- sieht, soll den Unterschied als Herkunftsgrenze lesen können.
CREATE TABLE docker_host (
  id         text        PRIMARY KEY,
  -- Der Name, unter dem der Host in der Oberfläche steht. citext, weil er von
  -- Hand eingetragen wird und trotzdem eindeutig bleiben muss.
  name       citext      NOT NULL UNIQUE,
  -- Die Basisadresse des Agenten, ohne Pfad und ohne abschließenden
  -- Schrägstrich.
  agent_url  text        NOT NULL,
  -- Die drei Klassen aus concept-and-plan.md §6. `local` ist der Host, auf dem
  -- der Hub selbst läuft: kein Tunnel, kein veröffentlichter Port, erreichbar
  -- nur über das Compose-Netz.
  --
  -- ⚠️ Die Klasse sagt etwas über den TRANSPORT, nicht über die Rechte. Ein
  -- angebundener Host ist ein voller Arm (SECURITY.md, Grundsatz 1); eine
  -- Nur-Lese-Stufe gibt es bewusst nicht.
  kind       text        NOT NULL CHECK (kind IN ('local', 'internal', 'external')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- Genau ein lokaler Host je Hub. Ein zweiter wäre kein Sonderfall, sondern ein
-- Fehler: der lokale Host ist der, in dessen Compose-Stack dieser Hub steht,
-- und davon gibt es einen.
CREATE UNIQUE INDEX docker_host_single_local_idx ON docker_host (kind) WHERE kind = 'local';
