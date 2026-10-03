-- Ob Übersicht und Container-Fläche die Container des Leitstands selbst
-- zeigen — den Hub mit seinen Begleitern und auf jedem Arm Agent, WireGuard
-- und Watcher. Welche das sind, entscheidet
-- `server/src/containers/system-containers.ts`.
--
-- Die Vorgabe ist AUSGEBLENDET (Entscheidung des Betreibers vom 2026-09-29):
-- diese Container sind auf jedem Arm dieselben und beantworten die Frage
-- „läuft mein Haus" nicht. Sie bleiben im Reiter „Hub & Agenten" der
-- Einstellungen erreichbar, mit allen Funktionen der Container-Fläche.
--
-- Eine Zeile für den ganzen Hub, nach demselben Muster wie `log_settings`
-- (010): eine Vorliebe der Bedienoberfläche, die ein Administrator setzt und
-- alle lesen. Eine EIGENE Tabelle, weil sie mit der Logansicht nichts zu tun
-- hat.
CREATE TABLE container_view_settings (
  singleton   boolean PRIMARY KEY DEFAULT true CHECK (singleton),
  show_system boolean NOT NULL DEFAULT false,
  updated_at  timestamptz NOT NULL DEFAULT now()
);

-- Die Zeile entsteht hier und nicht beim ersten Schreiben — wie in 006, 009
-- und 010.
INSERT INTO container_view_settings (singleton) VALUES (true);
