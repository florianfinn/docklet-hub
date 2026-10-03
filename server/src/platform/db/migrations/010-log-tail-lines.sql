-- Wie viele Zeilen Vergangenheit die Logansicht des Hubs beim Öffnen zeigt —
-- Phase 5a, Etappe G (#5, B4b).
--
-- WARUM ES DIESE ZEILE GEBEN MUSS
--
-- Die Logansicht fragt bei JEDER Anfrage den Arm nach einem Ausschnitt seines
-- Ringpuffers und schickt dabei `tail` mit — der Agent deckelt seine Antwort
-- unabhängig davon hart auf 2000 Zeilen (`dashboard-docker-agent@6ffc3c8`,
-- `src/engine.ts:672` und `:704`, `Math.min(tail, 2000)`). Die Vorgabe des
-- Agenten (200) kommt deshalb nie zum Zug, weil der Hub sein eigenes `tail`
-- schickt. Wie groß dieses `tail` ist, entscheidet der Betreiber — global,
-- nicht je Arm, denn es ist eine Vorliebe der Bedienoberfläche und keine
-- Eigenschaft eines einzelnen Arms.
--
-- Vier erlaubte Werte und Schluss bei 2000: ein größerer Wert wäre eine
-- Zusage an die Oberfläche, die die Gegenseite (der Agent, s.o.) nicht hält.
-- Die Vorgabe 500 ist die kleinste der vier, die für eine Fehlersuche mehr
-- als einen Bildschirm zeigt.
--
-- KEIN eigener Mitschnitt: was hier steht, ist nur die Größe des
-- Ausschnitts. Weiter zurückblicken als der Ringpuffer des Arms reicht, ist
-- eine eigene Fähigkeit (#65) und nicht Teil dieser Etappe.

-- ── Die Einstellung der Logansicht ─────────────────────────────────────────
--
-- Eine Zeile für den ganzen Hub, nach demselben Muster wie `hub_network`
-- (009) und `hub_theme` (006): der Riegel
-- `singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton)` schließt
-- eine zweite Zeile aus, und `CHECK (singleton)` schließt dabei `false` aus
-- — ein Primärschlüssel über `boolean` ließe sonst genau zwei Werte zu.
--
-- Eine EIGENE Tabelle und keine Spalte in `hub_network` oder `hub_theme`:
-- was hier steht, hat weder mit der Erreichbarkeit des Hubs noch mit seiner
-- Darstellung zu tun, sondern mit dem Verhalten einer einzelnen Fläche.
CREATE TABLE log_settings (
  singleton  boolean PRIMARY KEY DEFAULT true CHECK (singleton),
  -- Nur einer von vier Werten — dieselbe Liste wie `LOG_TAIL_LINE_OPTIONS`
  -- in `server/src/logs/log-settings-store.ts`. Der `CHECK` ist die zweite
  -- Hälfte derselben Zusage: eine Anwendung, die die Prüfung im Anwendungscode
  -- umgeht (ein Werkzeug, ein Rückbau), landet trotzdem nicht auf einer Zeile,
  -- die die Oberfläche nicht anbietet.
  tail_lines integer NOT NULL DEFAULT 500 CHECK (tail_lines IN (200, 500, 1000, 2000)),
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- Die Zeile entsteht hier und nicht beim ersten Schreiben — wie in 006 und
-- 009. Ein Leser findet damit immer etwas vor, und `GET /api/settings`
-- braucht keinen Sonderweg für „noch nie eingestellt".
INSERT INTO log_settings (singleton) VALUES (true);
