-- Eigene Marken und die Gliederung je Stack — Paket D7b (#62).
--
-- Drei Tabellen in EINER Migration, weil sie zusammen eine Zusage sind: der
-- Betreiber vergibt ab hier Namen, Farbton und Darstellungsart an einen Stack
-- oder an einen einzelnen Container, und er stellt je Stack ein, ob dessen
-- Container eingerückt darunter stehen. Getrennt wäre die Marke ein Bestand
-- ohne Zuordnung und die Zuordnung ein Verweis ins Leere.
--
-- Die Vorgabe steht in docs/design/hub-color-and-structure.md §3 (Systemmarke
-- gegen eigene Marke), §4 (die Tabelle der Stellschrauben) und §6 („Was daraus
-- für die Ablage folgt").
--
-- WARUM DIE ZUORDNUNG AM PAAR HÄNGT UND NICHT AN EINEM FREMDSCHLÜSSEL
--
-- Ein Stack und ein Container haben in diesem Hub KEINE gespeicherte Kennung.
-- Sie kommen flüchtig aus der Antwort des Agenten: `ContainerOverviewEntry`
-- (server/src/agent/containers.ts) trägt `name` und
-- `compose: { project, service } | null` und sonst nichts, was bleibt. Die
-- Container-Kennung von Docker (`id`) wechselt bei jedem Neuaufbau — eine
-- Zuordnung daran wäre nach dem nächsten `docker compose up` weg, und der
-- Betreiber sähe seine Marken verschwinden, ohne etwas getan zu haben.
--
-- Was bleibt, ist der NAME: das Compose-Projekt eines Stacks und der Name
-- eines losen Containers. §6 sagt es wörtlich: „Die Zuordnung hängt deshalb am
-- Paar aus Host-Kennung und Compose-Projekt beziehungsweise Containername."
--
-- Die Host-Kennung gehört dazu und ist nicht wegzulassen. Zwei Arme können
-- beide ein Projekt „monitoring" führen, und das sind zwei Stacks
-- (server/src/containers/stacks.ts, Kopf). Ohne `host_id` trüge der zweite Arm
-- die Marken des ersten.
--
-- Deshalb `target` und `target_key` und nicht zwei Spalten `project` und
-- `container_name`: die zwei Arten von Ziel unterscheiden sich in nichts
-- außer dem Namen, und zwei Spalten, von denen immer genau eine NULL ist,
-- wären dieselbe Aussage mit einer Bedingung mehr.
--
-- WAS MIT EINER ZUORDNUNG GESCHIEHT, DEREN STACK VERSCHWINDET
--
-- Nichts. Sie bleibt liegen und wird wieder wirksam, sobald der Stack wieder
-- auftaucht. Es gibt bewusst KEINEN Aufräumlauf:
--
--   - Ein Stack kann vorübergehend fehlen — der Agent ist aus, der Tunnel
--     steht nicht, der Betreiber hat gerade `docker compose down` gesagt. Ein
--     Aufräumlauf machte aus jeder dieser Lagen einen Datenverlust, und zwar
--     einen stillen: die Marken wären beim nächsten Start einfach weg.
--   - Der Hub sieht ohnehin nie „alle Stacks", sondern nur die, die ein
--     erreichbarer Agent gerade meldet. „Nicht in der Antwort" heißt deshalb
--     nicht „gibt es nicht mehr".
--
-- Der Preis ist eine Zeile, die niemand mehr liest, wenn ein Stack endgültig
-- weg ist. Das ist eine Zeile mit vier kurzen Textfeldern; die andere Seite
-- wäre verlorene Handarbeit des Betreibers.
--
-- WARUM `ON DELETE CASCADE` AM HOST UND AN DER MARKE STEHT
--
-- Beide Fremdschlüssel zeigen auf etwas, das in diesem Hub eine KENNUNG hat
-- und dessen Verschwinden eine Entscheidung ist:
--
--   - Wird ein Arm entfernt (`removeHost`, server/src/hosts/hosts.ts), gibt es
--     die Stacks dieses Arms für diesen Hub nicht mehr. Eine Zuordnung, die
--     auf eine gelöschte `host_id` zeigte, wäre kein Bestand, sondern Schutt —
--     und der nächste Arm, der zufällig dieselbe Kennung bekäme, erbte sie.
--     (Er bekäme sie nicht: `randomUUID()`. Aber ein Schema, das sich darauf
--     verlässt, sagt das nicht.)
--   - Wird eine Marke gelöscht, ist das die ausdrückliche Ansage „diese Marke
--     gibt es nicht mehr". Sie überall einzeln abzuziehen wäre dieselbe
--     Wirkung in Handarbeit — und die Zuordnung, die dabei übrig bliebe,
--     zeigte auf einen Namen und eine Farbe, die niemand mehr nachschlagen
--     kann.
--
-- `stack_display` hängt aus demselben Grund am Host. Der Stack selbst hat
-- keinen Fremdschlüssel, denn er hat keine Zeile — siehe oben.
--
-- ⚠️ DIE STUFEN STEHEN DAMIT ZWEIMAL: hier und in
-- `server/src/theme/presets.ts` (`THEME_KNOBS`). Das ist im Haus gelöst und
-- nicht verboten — `server/src/theme/theme-schema.test.ts` hält beide Orte
-- gegeneinander und liest dazu DIESE Datei. Er entfernt vorher die
-- SQL-Kommentare: `--` bis zum Zeilenende, `/* … */`, und ein
-- Anführungszeichen maskiert SQL durch Verdopplung und nicht mit einem
-- Backslash. Ein `CHECK (hue IN ( … ))` in diesem Prosakopf sähe sonst aus wie
-- die Schranke und stünde vor ihr (#70).
--
-- Die Spaltennamen sind snake_case und ohne Anführungszeichen wie in 003 und
-- 006; `citext` steht seit 003 zur Verfügung.

-- ── Die eigenen Marken ──────────────────────────────────────────────────────
--
-- Ein Name, ein Farbton, eine Darstellungsart — §6: „Ein eigener Datensatz."
--
-- ⚠️ Der Name ist `citext` und UNIQUE, aus demselben Grund wie bei
-- `docker_host.name` (003): er wird von Hand eingetragen, und „Backup" neben
-- „backup" wären zwei Marken, die auf dem Schirm dieselbe sind. Der
-- Betreiber ordnet mit ihnen — zwei nicht unterscheidbare Marken ordnen
-- nichts.
--
-- Die Kennung entsteht im Programm mit `randomUUID()` aus `node:crypto`, wie
-- bei `docker_host` (server/src/hosts/hosts.ts). Nicht in der Datenbank: das
-- brauchte `pgcrypto` oder `uuid-ossp`, und die Kennung eines Datensatzes
-- entsteht in diesem Repo dort, wo der Datensatz entsteht.
--
-- Die zwei Stellschrauben sind wörtlich die aus `THEME_KNOBS`, deren `scope`
-- „mark" enthält: `hue` (derselbe Tonvorrat wie beim Arm) und `style`.
CREATE TABLE hub_mark (
  id         text        PRIMARY KEY,
  name       citext      NOT NULL UNIQUE,
  hue        text        NOT NULL DEFAULT 'neutral' CHECK (hue IN ('amber', 'green', 'teal', 'blue', 'violet', 'rose', 'neutral')),
  style      text        NOT NULL DEFAULT 'label'   CHECK (style IN ('label', 'fill')),
  created_at timestamptz NOT NULL DEFAULT now()
);

-- ── Wer welche Marke trägt ──────────────────────────────────────────────────
--
-- ⚠️ EIN ZIEL DARF MEHRERE MARKEN TRAGEN (Entscheidung des Betreibers vom
-- 2026-09-06). Genau deshalb ist das hier eine eigene Tabelle und keine Spalte
-- `mark_id` an irgendetwas: eine Spalte trüge eine Marke, und die zweite
-- verdrängte die erste.
--
-- ⚠️ `position` und nicht die Einfügereihenfolge. Eine Reihenfolge, die aus
-- der physischen Lage der Zeilen entsteht, ist keine — Postgres gibt ohne
-- `ORDER BY` keine Zusage darüber, und eine aktualisierte Zeile wandert. Der
-- Betreiber ordnet seine Marken; die Reihenfolge ist damit seine Angabe und
-- muss dastehen.
--
-- Der Primärschlüssel schließt dieselbe Marke zweimal am selben Ziel aus. Er
-- führt `position` NICHT: zwei Zeilen mit derselben Marke und verschiedener
-- Position wären genau die Dublette, die er verhindern soll.
CREATE TABLE mark_assignment (
  host_id    text    NOT NULL REFERENCES docker_host(id) ON DELETE CASCADE,
  -- Welche Art von Ziel der Name meint. Ohne diese Angabe wäre ein Stack
  -- „nextcloud" dasselbe Ziel wie ein loser Container „nextcloud".
  target     text    NOT NULL CHECK (target IN ('stack', 'container')),
  -- Das Compose-Projekt bei `stack`, der Containername bei `container`.
  target_key text    NOT NULL,
  mark_id    text    NOT NULL REFERENCES hub_mark(id) ON DELETE CASCADE,
  position   integer NOT NULL,
  PRIMARY KEY (host_id, target, target_key, mark_id)
);

-- Der Weg, den das Lesen nimmt: alle Zuordnungen EINES Arms auf einmal, weil
-- die Übersicht sie so braucht (eine Antwort für alle Stacks eines Arms). Der
-- Primärschlüssel führt `host_id` bereits an erster Stelle und bedient diese
-- Abfrage; ein eigener Index wäre eine zweite Kopie derselben Ordnung. Er
-- steht hier deshalb NICHT.

-- ── Die Gliederung je Stack ─────────────────────────────────────────────────
--
-- ⚠️ DIE EINRÜCKUNG HÄNGT JE STACK UND NICHT GLOBAL (Entscheidung des
-- Betreibers vom 2026-09-06, und §4: „je Stack"). Eine globale Stellschraube
-- wäre eine Spalte in `hub_theme` gewesen und stünde in 006; sie ist es
-- ausdrücklich nicht.
--
-- Eine Zeile entsteht erst, wenn der Betreiber etwas einstellt. Ein Stack ohne
-- Zeile steht auf `nested` — dem `fallback` der Stellschraube `indent` und
-- zugleich dem Wert, den `:root` in `web/src/theme/tokens.css` trägt. Ein
-- Vorabsäen wäre nicht möglich: der Hub kennt die Stacks eines Arms nicht,
-- bevor ein Agent sie meldet.
CREATE TABLE stack_display (
  host_id text NOT NULL REFERENCES docker_host(id) ON DELETE CASCADE,
  project text NOT NULL,
  indent  text NOT NULL DEFAULT 'nested' CHECK (indent IN ('nested', 'flat')),
  PRIMARY KEY (host_id, project)
);
