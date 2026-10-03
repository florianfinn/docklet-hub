-- Ein Stack lässt sich auf der Übersicht ausblenden.
--
-- Er verschwindet dabei nicht: er rückt ans Ende seines Arms, in einen
-- zugeklappten Abschnitt. Ein Stack, der ganz wegfiele, sähe aus wie einer,
-- den es nicht mehr gibt.
--
-- ⚠️ An `stack_display` und nicht in einer eigenen Tabelle: es ist eine
-- Angabe über die Darstellung EINES Stacks, am selben Schlüssel (Arm und
-- Compose-Projekt) wie die Einrückung. `readHostDecoration` liest beides mit
-- derselben Abfrage.
--
-- ⚠️ `NOT NULL DEFAULT false`: jede bestehende Zeile ist ein sichtbarer
-- Stack, und eine Zeile, die erst durch das Ausblenden entsteht, trägt für
-- `indent` dessen Vorgabe aus 007 — denselben Wert, den ein Stack ohne Zeile
-- ohnehin hat.

ALTER TABLE stack_display
  ADD COLUMN hidden boolean NOT NULL DEFAULT false;
