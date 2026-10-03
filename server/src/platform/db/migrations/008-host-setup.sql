-- Die zwei Werte, die der Hub über einen Arm nicht wissen kann — Phase 4a,
-- nachgezogen vor dem ersten echten Arm (#4, B2 in #46).
--
-- Beide gehören dem ZIELHOST und nicht dem Hub: die Gruppen-ID, der sein
-- Docker-Socket gehört, und der Pfad, unterhalb dessen seine Compose-Projekte
-- liegen. Bisher standen sie im erzeugten Archiv als Lücke — `DOCKER_GID=`
-- leer, dazu eine Anleitung, sie von Hand zu füllen — und ein Vorgabepfad,
-- der auf einem fremden Host schlicht nicht existiert.
--
-- ⚠️ Warum sie in der TABELLE stehen und nicht nur im Archiv: `GET
-- /hosts/:id/archive` erzeugt das Paket jedes Mal neu und rotiert dabei
-- Schlüssel, Secret und Token (enrollment.ts §4). Läge die Eingabe nur im
-- ersten Paket, käme das zweite wieder mit leerer Zeile heraus — und zwar
-- ohne Fehlermeldung, weil beide Wege erlaubt sind.
--
-- ⚠️ Beide Spalten kommen NULLABLE herein, wie schon die von 004. Der lokale
-- Host hat keine (er steht im Compose-Stack des Hubs, seine GID kommt aus
-- dessen .env), und ein Arm, der vor dieser Migration angelegt wurde, hat sie
-- auch nicht. Eine Spalte mit NOT NULL hätte den Start eines bestehenden Hubs
-- angehalten — auf einer frischen Datenbank wäre das nie aufgefallen.
-- Verlangt wird der Wert dort, wo er entsteht: beim Anlegen über die Route.

ALTER TABLE docker_host
  -- Die numerische Gruppen-ID, der `/var/run/docker.sock` auf DEM ZIELHOST
  -- gehört — abgelesen mit `stat -c %g /var/run/docker.sock`, nicht über den
  -- Namen `docker` erfragt: es gibt Hosts ohne eine Gruppe dieses Namens, und
  -- es gibt Hosts, deren Socket einer anderen gehört als der, die so heißt.
  --
  -- ⚠️ `0` ist ein gültiger Wert und kein „nicht gesetzt". Auf Hosts, die
  -- Docker als root fahren, gehört der Socket `root:root` — jede Prüfung, die
  -- auf Wahrheitswert statt auf NULL sieht, verschluckt genau diesen Fall.
  ADD COLUMN docker_gid      integer,
  -- Der Basispfad, unterhalb dessen der Agent Bind-Mounts zulässt. Vorgabe
  -- des Agenten ist `/home/docker`; auf einem unraid liegen die Projekte
  -- unter `/mnt/user/appdata`, auf anderen Hosts wieder woanders.
  ADD COLUMN bind_base_path  text;

ALTER TABLE docker_host
  -- Negative Gruppen-IDs gibt es nicht. Die obere Grenze zieht `integer`
  -- selbst; eine engere hier wäre eine Zahl, die ich mir ausgedacht hätte.
  ADD CONSTRAINT docker_host_docker_gid_check
    CHECK (docker_gid IS NULL OR docker_gid >= 0),

  -- ⚠️ Diese Bedingung ist keine Kosmetik, sondern der Schutz vor einer
  -- Compose-Datei, die auf dem Zielhost zerfällt. Der Pfad wird im erzeugten
  -- Paket UNMASKIERT in eine Volume-Zeile gesetzt:
  --
  --     - ${DOCKER_AGENT_BIND_BASE_PATH}:${DOCKER_AGENT_BIND_BASE_PATH}
  --
  -- Ein Doppelpunkt darin ergibt drei Felder statt zweier, ein Leerzeichen
  -- zerlegt die Zeile. Beides fiele erst auf dem fremden Host auf, beim
  -- `compose up`, und die Meldung spräche von YAML und nicht von diesem Feld.
  -- Ein relativer Pfad wiederum ist gegen das Wurzelverzeichnis des Agenten
  -- gemeint und nie gegen das, was der Betreiber im Sinn hatte.
  ADD CONSTRAINT docker_host_bind_base_path_check
    CHECK (bind_base_path IS NULL OR bind_base_path ~ '^/[^:[:space:]]*$');
