-- Die Freigabepfade für Web-FTP — Phase 5b, Etappe E2 (#5, B5).
--
-- WARUM ES DIESE TABELLE GEBEN MUSS
--
-- Der Agent beantwortet JEDE Web-FTP-Anfrage an einen Container mit `409`,
-- solange für ihn keine Freigabe in seiner Allowlist-Kopie eingetragen ist
-- (`dashboard-docker-agent@6ffc3c8`, `src/index.ts:1143-1225`,
-- `checkWebftpAccess`). Der Registry-Abgleich des Hubs
-- (`server/src/containers/registry-sync.ts`) trägt bislang nichts dazu ein —
-- diese Tabelle ist die Ablage, aus der er es künftig tut.
--
-- JE (ARM, CONTAINERNAME) UND NICHT JE CONTAINER-ID: eine Container-Id
-- wechselt bei jedem `recreate`, der Name überlebt ihn. Eine an die Id
-- gebundene Freigabe wäre nach dem ersten Update des Containers still weg,
-- ohne dass irgendwer etwas geändert hätte. Der Abgleich löst den Namen erst
-- beim Schreiben zur Id des Augenblicks auf, weil die Allowlist des Agenten
-- nach `containerId` geführt wird.
--
-- EIN EINZIGER PFAD JE ZEILE: die Vertragsdatei des Agenten kennt zwar eine
-- Liste (`shares?: string[]`, `src/registry.ts:95`), aber diese Ablage hält
-- die EINE Freigabe, die der Betreiber für einen Container gewählt hat — die
-- Auswahl selbst ist nicht Teil dieser Etappe. Der Abgleich verpackt den
-- einen Pfad beim Schreiben in die Liste, die der Agent erwartet.
--
-- EIN LEERER PFAD IST KEINE GÜLTIGE ANGABE. Gemessen an `src/registry.ts:318`
-- des Agenten: „Ein leerer String wäre die gefährlichste Form — er sieht aus
-- wie eine Angabe und bedeutete das ganze Projektverzeichnis." Der `CHECK`
-- unten ist die zweite Hälfte derselben Zusage wie in `log-settings-store.ts`
-- und `hub-network-store.ts`: eine Anwendung, die die Prüfung im
-- Anwendungscode umgeht, landet trotzdem nicht auf einer Zeile, die ein
-- ganzes Projektverzeichnis freigäbe.
CREATE TABLE container_share (
  -- Der Arm, dem diese Freigabe gehört. `ON DELETE CASCADE`, damit ein
  -- entfernter Arm keine Waisen hinterlässt — dieselbe Sorge, aus der heraus
  -- der Leitstand die Ablage überhaupt an den Arm bindet und nicht an eine
  -- Container-Id.
  host_id        text        NOT NULL REFERENCES docker_host (id) ON DELETE CASCADE,
  -- Der Containername, wie ihn der Bestand des Agenten meldet
  -- (`GET /host-containers`). Exakt, nicht `citext`: anders als der
  -- Hostname (003) trägt niemand diesen Namen von Hand ein, sondern der
  -- Abgleich löst ihn gegen den Bestand auf — und der ist so
  -- großschreibungsempfindlich wie Docker selbst.
  container_name text        NOT NULL,
  -- Relativ zum Projektverzeichnis des Containers, ohne führenden
  -- Schrägstrich — dieselbe Form, in der
  -- `GET /containers/:id/share-candidates` (`src/index.ts:4030-4085` des
  -- Agenten) sein Feld `relative` liefert.
  share_path     text        NOT NULL CHECK (share_path <> ''),
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now(),
  -- Höchstens eine gewählte Freigabe je (Arm, Containername) — nicht mehr,
  -- denn diese Ablage hält genau die eine Auswahl des Betreibers.
  PRIMARY KEY (host_id, container_name)
);
