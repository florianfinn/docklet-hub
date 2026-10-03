-- Das Schema der Anmeldung (better-auth) und der Riegel der Erstanmeldung.
--
-- Warum von Hand geschrieben und nicht vom `better-auth`-Werkzeug erzeugt:
-- AGENTS.md, Abschnitt Datenbank, nennt die Migrationsfolge als Ort der
-- Wahrheit. Ein Werkzeug, das das Schema aus einer Konfiguration ableitet und
-- gegen die laufende Datenbank abgleicht, wäre ein zweiter solcher Ort — und
-- der gewinnt im Zweifel, weil er beim Start mitläuft.
--
-- Die Felder stammen trotzdem nicht aus der Erinnerung: sie sind am
-- 2026-09-04 aus `getAuthTables()` der eingebauten Fassung 1.7.2 ausgelesen
-- worden, also aus derselben Beschreibung, aus der das Werkzeug seine
-- Migrationen erzeugt. `web/tests/auth-schema.test.mjs` liest sie erneut aus
-- und vergleicht sie mit dieser Datei — eine Fassung, die ein Feld ergänzt,
-- fällt damit im Test auf und nicht erst beim ersten Anmeldeversuch.
--
-- ⚠️ Die Spaltennamen stehen in Anführungszeichen und in camelCase. Das ist
-- keine Vorliebe: better-auth spricht die Datenbank über Kysely an und zitiert
-- seine Bezeichner. Ohne Anführungszeichen legte Postgres `emailverified` an,
-- und jede Abfrage von better-auth liefe danach ins Leere.

-- `user` ist in Postgres ein Schlüsselwort. Der Name kommt von better-auth und
-- wird deshalb nicht umbenannt — jede Stelle, die ihn benutzt, zitiert ihn.
CREATE TABLE "user" (
  "id"            text        PRIMARY KEY,
  "name"          text        NOT NULL,
  -- citext aus 001: zwei Konten auf dieselbe Adresse mit verschiedener
  -- Schreibweise wären sonst möglich, und der Unterschied ist beim Anmelden
  -- unsichtbar.
  "email"         citext      NOT NULL UNIQUE,
  "emailVerified" boolean     NOT NULL DEFAULT false,
  "image"         text,
  -- Die Rolle. Zwei Werte, keine Scope-Tabelle (concept-and-plan.md §2).
  -- Der CHECK ist die Schranke: eine dritte Rolle entsteht nicht durch einen
  -- Tippfehler in einer Zuweisung, sondern nur durch eine Migration.
  "role"          text        NOT NULL DEFAULT 'user' CHECK ("role" IN ('admin', 'user')),
  "createdAt"     timestamptz NOT NULL DEFAULT now(),
  "updatedAt"     timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE "session" (
  "id"        text        PRIMARY KEY,
  "expiresAt" timestamptz NOT NULL,
  "token"     text        NOT NULL UNIQUE,
  "createdAt" timestamptz NOT NULL DEFAULT now(),
  "updatedAt" timestamptz NOT NULL DEFAULT now(),
  "ipAddress" text,
  "userAgent" text,
  -- `on delete cascade` statt einer Aufräumroutine: ein gelöschtes Konto
  -- hinterlässt sonst gültige Sitzungen, mit denen weitergearbeitet werden
  -- kann. Derselbe Befund wie im Quellsystem (dashboard-homelab#459), nur
  -- eine Tabelle früher.
  "userId"    text        NOT NULL REFERENCES "user"("id") ON DELETE CASCADE
);

-- Ohne diesen Index liest jede Abmeldung „alle Sitzungen dieses Nutzers" als
-- vollen Tabellendurchlauf. Das fällt bei drei Nutzern nicht auf und ist
-- trotzdem der Index, den man nachträglich nie nachträgt.
CREATE INDEX "session_userId_idx" ON "session" ("userId");

CREATE TABLE "account" (
  "id"                     text        PRIMARY KEY,
  -- Seit better-auth 1.7 ist die Kontokennung nach Aussteller getrennt. Für
  -- die Anmeldung mit Passwort steht hier der lokale Aussteller; ein späterer
  -- Authentik-Proxy (Phase 9) brächte einen zweiten.
  "issuer"                 text        NOT NULL,
  "accountId"              text        NOT NULL,
  "providerId"             text        NOT NULL,
  "userId"                 text        NOT NULL REFERENCES "user"("id") ON DELETE CASCADE,
  "accessToken"            text,
  "refreshToken"           text,
  "idToken"                text,
  "accessTokenExpiresAt"   timestamptz,
  "refreshTokenExpiresAt"  timestamptz,
  "scope"                  text,
  -- Der Passwort-Hash. Er heißt bei better-auth so und wird deshalb nicht
  -- umbenannt; was darin steht, ist ein scrypt-Hash und kein Passwort.
  "password"               text,
  "createdAt"              timestamptz NOT NULL DEFAULT now(),
  "updatedAt"              timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX "account_userId_idx" ON "account" ("userId");

CREATE TABLE "verification" (
  "id"         text        PRIMARY KEY,
  "identifier" text        NOT NULL,
  "value"      text        NOT NULL,
  "expiresAt"  timestamptz NOT NULL,
  "createdAt"  timestamptz NOT NULL DEFAULT now(),
  "updatedAt"  timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX "verification_identifier_idx" ON "verification" ("identifier");

-- Der Riegel der Erstanmeldung.
--
-- Die Erstanmeldung steht offen, solange kein Konto existiert — und nur so
-- lange. Ohne diese Tabelle wäre „solange kein Konto existiert" eine Abfrage
-- vor dem Anlegen, also zwei Schritte: zwei gleichzeitige Anfragen auf einem
-- frischen Betrieb sähen beide eine leere Tabelle und legten beide einen
-- Admin an. Das Fenster ist klein, aber es liegt genau dort, wo das System
-- noch niemandem gehört.
--
-- Deshalb wird der Platz BELEGT, bevor angelegt wird, und zwar in einer
-- einzigen Anweisung. Genau eine Zeile ist möglich: der Primärschlüssel ist
-- ein boolean, und der CHECK lässt nur `true` zu.
--
-- Ein belegter Platz, dem kein Konto folgte (die Anmeldung scheiterte an einem
-- zu kurzen Passwort), verfällt nach einer Frist — sonst sperrte ein
-- Fehlversuch den Betreiber aus einem System aus, in dem es noch nichts zu
-- schützen gibt. Die Frist steht im Code (server/src/auth/setup-gate.ts),
-- nicht hier: sie ist eine Entscheidung, kein Schema.
CREATE TABLE setup_claim (
  claimed    boolean     PRIMARY KEY DEFAULT true CHECK (claimed),
  claimed_at timestamptz NOT NULL DEFAULT now()
);
