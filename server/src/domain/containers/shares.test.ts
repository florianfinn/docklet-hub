import test from "node:test";
import assert from "node:assert/strict";
import type { Pool } from "pg";

import { normalizeSharePath, readShare, readShares, removeShare, setShare } from "./shares.js";

// Geprüft wird gegen einen erfundenen Pool: kein Postgres, keine Umgebung
// (AGENTS.md, „Tests"). Dieselbe Bauart wie `domain/hosts/host-store.test.ts`.
//
// ⚠️ Was hier festgehalten ist: dass ein leerer Pfad NIE gespeichert wird —
// weder über `normalizeSharePath` allein noch über `setShare`, das intern
// dieselbe Prüfung anwendet —, und dass jede Abfrage nach `hostId` UND
// `containerName` filtert, nie nach einer Container-Id (011-container-shares.sql,
// Entscheidung des Leitstands: Freigaben hängen am Namen, nicht an der Id).

type Call = { text: string; values: unknown[] };
type Reply = { rows: unknown[]; rowCount?: number };

function fakePool(replies: Reply[]): { pool: Pool; calls: Call[] } {
  const calls: Call[] = [];
  const pool = {
    query(text: string, values: unknown[] = []) {
      const index = calls.length;
      calls.push({ text, values });
      const reply = replies[index] ?? { rows: [] };
      return Promise.resolve({ rows: reply.rows, rowCount: reply.rowCount ?? reply.rows.length });
    }
  } as unknown as Pool;
  return { pool, calls };
}

// ---------------------------------------------------------------------------
// normalizeSharePath — reine Funktion, jeder Grenzfall einzeln
// ---------------------------------------------------------------------------

test("ein nicht leerer Pfad wird angenommen", () => {
  assert.deepEqual(normalizeSharePath("media/downloads"), { ok: true, value: "media/downloads" });
});

test("ein leerer Pfad wird abgelehnt", () => {
  assert.deepEqual(normalizeSharePath(""), { ok: false });
});

test("eine Zahl wird abgelehnt", () => {
  assert.deepEqual(normalizeSharePath(42), { ok: false });
});

test("null wird abgelehnt", () => {
  assert.deepEqual(normalizeSharePath(null), { ok: false });
});

test("undefined wird abgelehnt", () => {
  assert.deepEqual(normalizeSharePath(undefined), { ok: false });
});

test("ein Array wird abgelehnt", () => {
  assert.deepEqual(normalizeSharePath(["media"]), { ok: false });
});

// ---------------------------------------------------------------------------
// readShares — alle Freigaben eines Arms
// ---------------------------------------------------------------------------

test("readShares liefert alle Zeilen eines Arms als Liste", async () => {
  const { pool, calls } = fakePool([
    { rows: [{ container_name: "media-jellyfin", share_path: "downloads" }, { container_name: "db-postgres", share_path: "backups" }] }
  ]);
  const shares = await readShares(pool, "host-1");
  assert.deepEqual(shares, [
    { containerName: "media-jellyfin", path: "downloads" },
    { containerName: "db-postgres", path: "backups" }
  ]);
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].values, ["host-1"]);
  assert.match(calls[0].text, /WHERE host_id = \$1/);
});

test("readShares liefert eine leere Liste für einen Arm ohne Freigaben", async () => {
  const { pool } = fakePool([{ rows: [] }]);
  assert.deepEqual(await readShares(pool, "host-1"), []);
});

// ---------------------------------------------------------------------------
// readShare — eine einzelne
// ---------------------------------------------------------------------------

test("readShare liefert den Pfad eines einzelnen Containers", async () => {
  const { pool, calls } = fakePool([{ rows: [{ container_name: "media-jellyfin", share_path: "downloads" }] }]);
  const path = await readShare(pool, "host-1", "media-jellyfin");
  assert.equal(path, "downloads");
  assert.deepEqual(calls[0].values, ["host-1", "media-jellyfin"]);
});

test("readShare liefert null ohne eingetragene Freigabe", async () => {
  const { pool } = fakePool([{ rows: [] }]);
  assert.equal(await readShare(pool, "host-1", "media-jellyfin"), null);
});

// ---------------------------------------------------------------------------
// setShare — setzen, mit Ablehnung eines leeren Pfads
// ---------------------------------------------------------------------------

test("setShare speichert einen nicht leeren Pfad über ON CONFLICT", async () => {
  const { pool, calls } = fakePool([{ rows: [{ container_name: "media-jellyfin", share_path: "downloads" }] }]);
  const result = await setShare(pool, "host-1", "media-jellyfin", "downloads");
  assert.deepEqual(result, { containerName: "media-jellyfin", path: "downloads" });
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].values, ["host-1", "media-jellyfin", "downloads"]);
  assert.match(calls[0].text, /ON CONFLICT \(host_id, container_name\) DO UPDATE/);
});

test("setShare lehnt einen leeren Pfad ab und schreibt nichts", async () => {
  const { pool, calls } = fakePool([]);
  await assert.rejects(setShare(pool, "host-1", "media-jellyfin", ""), /leer/);
  // Der entscheidende Teil des Falls: kein einziger Aufruf gegen den Pool.
  assert.equal(calls.length, 0);
});

// ---------------------------------------------------------------------------
// removeShare — entfernen
// ---------------------------------------------------------------------------

test("removeShare löscht nach Arm und Containername", async () => {
  const { pool, calls } = fakePool([{ rows: [] }]);
  await removeShare(pool, "host-1", "media-jellyfin");
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].values, ["host-1", "media-jellyfin"]);
  assert.match(calls[0].text, /DELETE FROM container_share/);
});
