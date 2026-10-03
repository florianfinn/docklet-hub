import test from "node:test";
import assert from "node:assert/strict";

import { ACTOR_HEADER, FILE_ACTIONS, MAX_ENTRIES, SECRET_HEADER, TIER_HEADER } from "contract";
import {
  applyFileAction,
  downloadFile,
  listFiles,
  listShareCandidates,
  readFileText,
  uploadFile,
  writeFileText
} from "./agent-client.js";
import { AgentError } from "../../platform/agent-transport/protocol.js";

// Der Client der Datei-Fläche. Gemessen wird hier ZWEIERLEI, und beides fällt
// sonst nirgends auf:
//
//   WAS HINAUSGEHT   die fünf Schlüssel unter ihrem neuen Namen, der Aufrufer
//                    als Mensch, der Rumpf in der Form der Gegenseite.
//   WAS ANKOMMT      `changedAt` als Zahl, `kind` mit den Werten des Agenten,
//                    `truncated`, und der `409` als Antwort statt als Ausnahme.
//
// Ein falscher Schlüssel ergibt keinen Fehler: der Agent liest den Altnamen
// noch, die Anfrage gelingt, und der Rückfall steht unbemerkt im Bestand.
// Deshalb prüfen die Fälle unten die ABGESETZTE Anfrage und nicht nur, dass
// etwas zurückkam.

const TARGET = { baseUrl: "http://docker-agent:8099", secret: "s".repeat(32) };
const ACTOR = { kind: "user" as const, id: "u-7" };

type Seen = { url: string; method: string | undefined; headers: Record<string, string>; body: unknown };

/** Fängt die Anfrage ab und antwortet mit `body` unter `status`. */
function stub(body: unknown, status = 200): { fetchImpl: typeof fetch; seen: () => Seen } {
  let taken: Seen | null = null;
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    taken = {
      url: String(input),
      method: init?.method,
      headers: init?.headers as Record<string, string>,
      body: init?.body
    };
    return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  }) as unknown as typeof fetch;
  return {
    fetchImpl,
    seen: () => {
      assert.ok(taken, "der Aufruf hat fetch nie erreicht");
      return taken as unknown as Seen;
    }
  };
}

/** Der Abfrageteil einer abgesetzten Anfrage, als Paare. */
function query(seen: Seen): URLSearchParams {
  return new URL(seen.url).searchParams;
}

// ── Die fünf Schlüssel ──────────────────────────────────────────────────────

test("jede Route sendet die Schlüssel unter ihrem NEUEN Namen", async () => {
  // ⚠️ Der Fall, für den es dieses Modul gibt. Der Agent liest die Alt-Formen
  // noch, also gelingt ein Rückfall stillschweigend — er fällt weder beim
  // Bauen noch beim Laufen auf, sondern erst an dem Tag, an dem die Gegenseite
  // sie streicht. Fall 3 des Wächters liest denselben Bestand; hier steht die
  // gefahrene Probe daneben.
  const listing = stub({ share: "daten", path: "", entries: [], truncated: false, diagnostics: null });
  await listFiles(TARGET, "abc", { share: "daten", path: "unterordner" }, { actor: ACTOR, fetchImpl: listing.fetchImpl });
  const listed = query(listing.seen());
  assert.equal(listed.get("share"), "daten");
  assert.equal(listed.get("path"), "unterordner");
  assert.deepEqual([...listed.keys()].sort(), ["path", "share"], "kein weiterer und kein alter Schlüssel");

  const text = stub({ path: "a.conf", content: "x", hash: "h1" });
  await readFileText(TARGET, "abc", { share: "daten", path: "a.conf" }, { actor: ACTOR, fetchImpl: text.fetchImpl });
  assert.deepEqual([...query(text.seen()).keys()].sort(), ["path", "share"]);

  const upload = stub({ ok: true, name: "b.bin", size: 3 });
  await uploadFile(TARGET, "abc", { share: "daten", path: "unter", name: "b.bin" }, new Uint8Array([1, 2, 3]), {
    actor: ACTOR,
    fetchImpl: upload.fetchImpl
  });
  const uploaded = query(upload.seen());
  assert.equal(uploaded.get("share"), "daten");
  assert.equal(uploaded.get("path"), "unter");
  // `name` ist KEIN umbenannter Schlüssel und geht unverändert hinaus.
  assert.equal(uploaded.get("name"), "b.bin");
});

test("der Aufrufer geht als Mensch hinaus und nie als System", async () => {
  // ⚠️ Der Agent schreibt diesen Wert in sein Audit-Log. Ein `system:hub`
  // löschte die einzige Spur, die von diesem Hub auf einen Menschen zeigt —
  // und zwar unbemerkt, weil der Aufruf gelingt. `FileRequestOptions` macht
  // das zum Typfehler; dieser Fall misst, dass es auch ankommt.
  const called = stub({ candidates: [] });
  await listShareCandidates(TARGET, "abc", { actor: ACTOR, fetchImpl: called.fetchImpl });
  const request = called.seen();
  assert.equal(request.headers[ACTOR_HEADER], "user:u-7");
  assert.ok(!request.headers[ACTOR_HEADER].startsWith("system:"), "kein Systemaufrufer auf dieser Fläche");
  assert.equal(request.headers[SECRET_HEADER], "s".repeat(32));
  assert.equal(request.headers[TIER_HEADER], "internal");
});

test("eine Container-Kennung mit Schrägstrich verschiebt die Route nicht", async () => {
  const called = stub({ candidates: [] });
  await listShareCandidates(TARGET, "a/b", { actor: ACTOR, fetchImpl: called.fetchImpl });
  assert.equal(called.seen().url, "http://docker-agent:8099/containers/a%2Fb/share-candidates");
});

// ── Was ankommt ─────────────────────────────────────────────────────────────

test("share-candidates liefert relative Pfade, Ziel und Schreibbarkeit", async () => {
  const called = stub({
    candidates: [
      { relative: "daten", destination: "/data", writable: true },
      { relative: "conf", destination: "/etc/app", writable: false }
    ]
  });
  const candidates = await listShareCandidates(TARGET, "abc", { actor: ACTOR, fetchImpl: called.fetchImpl });
  assert.equal(called.seen().method, "GET");
  assert.deepEqual(candidates, [
    { relative: "daten", destination: "/data", writable: true },
    { relative: "conf", destination: "/etc/app", writable: false }
  ]);
});

test("changedAt kommt als ZAHL an und kind trägt die Werte des Agenten", async () => {
  // ⚠️ GEMESSEN GEGEN 6ffc3c8 (`src/webftp.ts:290` ff.) UND GEGEN DEN ENTWURF:
  // `docs/design/phase-5-write-access.md` §6 nennt `changedAt` als ISO-Text.
  // Das Dokument ist an dieser Stelle falsch. Ein `Date.parse` auf diesem
  // Feld ergibt `NaN`, und das fällt beim Bauen nicht auf.
  //
  // ⚠️ DIE ZAHLEN SIND SEKUNDEN, NICHT MILLISEKUNDEN, und dieser Fall stand
  // vorher mit dem tausendfachen Wert da. Gemessen am 2026-09-07 an
  // `6ffc3c8`: `changedAt: Math.floor(stat.mtimeMs / 1000)`
  // (`src/webftp.ts:352`, ebenso `:272`). Eine Attrappe in der falschen
  // Einheit ist schlimmer als gar keine — sie sieht wie eine Messung aus und
  // lehrt jeden, der sie liest, die falsche Größenordnung. Deshalb steht die
  // Umrechnung `* 1000` unten AUSGESCHRIEBEN und nicht in der Zahl versteckt.
  const called = stub({
    share: "daten",
    path: "unter",
    entries: [
      { name: "welt.txt", kind: "file", size: 12, changedAt: 1_757_000_000, uid: 1000, gid: 1000 },
      { name: "unterordner", kind: "directory", size: 4096, changedAt: 1_756_000_000, uid: 0, gid: 0 }
    ],
    truncated: true,
    diagnostics: { readable: true, deletable: false, uid: 1000, gid: 1000, uploadable: true }
  });

  const listing = await listFiles(
    TARGET,
    "abc",
    { share: "daten", path: "unter" },
    { actor: ACTOR, fetchImpl: called.fetchImpl }
  );

  assert.equal(typeof listing.entries[0].changedAt, "number");
  assert.equal(listing.entries[0].changedAt, 1_757_000_000);
  // Die Umrechnung steht hier und nicht in der Attrappe: `new Date` auf der
  // nackten Sekundenzahl ergäbe 1970 und nicht 2025 — und zwar ohne zu werfen.
  assert.equal(new Date(listing.entries[0].changedAt * 1000).getUTCFullYear(), 2025);
  assert.equal(
    new Date(listing.entries[0].changedAt).getUTCFullYear(),
    1970,
    "die nackte Zahl ist eine SEKUNDENZAHL — wer sie ungerechnet an Date gibt, landet 1970"
  );
  assert.equal(listing.entries[0].kind, "file");
  assert.equal(listing.entries[1].kind, "directory");
  assert.equal(listing.truncated, true, "die Kürzung bei MAX_ENTRIES wird nicht verschwiegen");
  assert.ok(MAX_ENTRIES > 0, "die Grenze kommt aus dem Vertrag und nicht von hier");
  assert.deepEqual(listing.diagnostics, {
    readable: true,
    deletable: false,
    uid: 1000,
    gid: 1000,
    uploadable: true
  });
});

test("eine unbekannte Art wird durchgereicht und nicht verworfen", async () => {
  // Dieselbe Entscheidung wie bei `LogStreamFailure.reason`: ein fünfter Wert
  // der Gegenseite soll ankommen und nicht an einem Parser scheitern.
  const called = stub({
    share: "daten",
    path: "",
    entries: [{ name: "sonderbar", kind: "eine-neue-art", size: 0, changedAt: 0, uid: 0, gid: 0 }],
    truncated: false,
    diagnostics: null
  });
  const listing = await listFiles(TARGET, "abc", { share: "daten", path: "" }, { actor: ACTOR, fetchImpl: called.fetchImpl });
  assert.equal(listing.entries[0].kind, "eine-neue-art");
  assert.equal(listing.diagnostics, null, "fehlende Diagnose ist null und kein leeres Objekt");
});

// ── Die binären Wege ────────────────────────────────────────────────────────

test("der Download wird durchgereicht und nicht gesammelt", async () => {
  let seen: { headers: Record<string, string>; url: string } | null = null;
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    seen = { url: String(input), headers: init?.headers as Record<string, string> };
    return new Response("ROHE-BYTES", {
      status: 200,
      headers: { "content-type": "application/octet-stream", "content-length": "10" }
    });
  }) as unknown as typeof fetch;

  const download = await downloadFile(
    TARGET,
    "abc",
    { share: "daten", path: "large.bin" },
    { actor: ACTOR, fetchImpl }
  );

  assert.equal(download.size, 10, "die angekündigte Größe kommt aus content-length");
  assert.ok(download.stream instanceof ReadableStream, "der Rumpf bleibt ein Strom");
  const request = seen as unknown as { headers: Record<string, string>; url: string };
  assert.equal(request.headers.accept, "application/octet-stream");
  assert.equal(new URL(request.url).searchParams.get("path"), "large.bin");

  // Erst der Aufrufer liest ihn — und zwar vollständig.
  const collected = await new Response(download.stream).text();
  assert.equal(collected, "ROHE-BYTES");
});

test("ein abgelehnter Download trägt den Grund des Agenten", async () => {
  // `agentDownload` leaves the error body to the caller; without it a refused
  // download is a bare status and the hub cannot tell `agent-read-only` or
  // `not-allowlisted` from any other 503 or 404 (#262).
  for (const [status, reason] of [
    [503, "agent-read-only"],
    [404, "not-allowlisted"],
    [400, "path-traversal"]
  ] as const) {
    const { fetchImpl } = stub({ error: reason }, status);
    const refused = await downloadFile(
      TARGET,
      "c1",
      { share: "data", path: "a.txt" },
      { actor: ACTOR, fetchImpl }
    ).then(
      () => null,
      (error: unknown) => error
    );
    assert.ok(refused instanceof AgentError, String(status));
    assert.equal(refused.status, status);
    assert.deepEqual(refused.detail, { error: reason });
  }
});

test("ein Upload schickt die rohen Bytes, keine JSON-Fassung", async () => {
  const bytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47]);
  const called = stub({ ok: true, name: "bild.png", size: 4 });
  const receipt = await uploadFile(TARGET, "abc", { share: "daten", path: "", name: "bild.png" }, bytes, {
    actor: ACTOR,
    fetchImpl: called.fetchImpl
  });

  assert.deepEqual(receipt, { ok: true, name: "bild.png", size: 4 });
  const request = called.seen();
  assert.equal(request.method, "PUT");
  assert.equal(request.headers["content-type"], "application/octet-stream");
  assert.equal(request.body, bytes, "der Rumpf ist dasselbe Uint8Array und keine Abschrift");
});

// ── Der Texteditor und sein Konflikt ────────────────────────────────────────

test("der Text kommt mit seinem Hash, und der Hash geht beim Speichern zurück", async () => {
  const loaded = stub({ path: "app.conf", content: "port=80\n", hash: "h-alt" });
  const text = await readFileText(
    TARGET,
    "abc",
    { share: "conf", path: "app.conf" },
    { actor: ACTOR, fetchImpl: loaded.fetchImpl }
  );
  assert.deepEqual(text, { path: "app.conf", content: "port=80\n", hash: "h-alt" });

  const saved = stub({ ok: true, hash: "h-neu" });
  const written = await writeFileText(
    TARGET,
    "abc",
    { share: "conf", path: "app.conf" },
    { content: "port=8080\n", expectedHash: text.hash },
    { actor: ACTOR, fetchImpl: saved.fetchImpl }
  );

  assert.deepEqual(written, { ok: true, hash: "h-neu" });
  const request = saved.seen();
  assert.equal(request.method, "PUT");
  assert.equal(request.headers["content-type"], "application/json");
  assert.equal(request.body, JSON.stringify({ content: "port=8080\n", expectedHash: "h-alt" }));
});

test("ein 409 ist eine ANTWORT mit dem jetzigen Hash und keine Ausnahme", async () => {
  // ⚠️ Der schärfste Fall dieses Moduls. Würde der Konflikt geworfen, ginge der
  // beigelegte Hash verloren — und der Editor könnte dem Betreiber nur „ging
  // nicht" sagen und ihn seine Änderung neu tippen lassen.
  const conflicted = stub({ error: "file-changed-externally", hash: "h-fremd" }, 409);
  const written = await writeFileText(
    TARGET,
    "abc",
    { share: "conf", path: "app.conf" },
    { content: "port=8080\n", expectedHash: "h-alt" },
    { actor: ACTOR, fetchImpl: conflicted.fetchImpl }
  );

  assert.deepEqual(written, { ok: false, reason: "file-changed-externally", hash: "h-fremd" });
});

test("jeder andere Fehlerstatus des Editors bleibt eine Ausnahme", async () => {
  // Nur der 409 ist eine Antwort. Ein 413 (über MAX_TEXT_BYTES) und ein 403
  // sind Fehler und reisen mit ihrem Status weiter.
  for (const status of [403, 404, 413, 500]) {
    const called = stub({ error: "irgendetwas" }, status);
    await assert.rejects(
      writeFileText(
        TARGET,
        "abc",
        { share: "conf", path: "app.conf" },
        { content: "x", expectedHash: "h" },
        { actor: ACTOR, fetchImpl: called.fetchImpl }
      ),
      (error: unknown) => error instanceof AgentError && error.status === status
    );
  }
});

// ── Anlegen, umbenennen, entfernen ──────────────────────────────────────────

test("die drei Aktionen gehen in der Schreibweise der Gegenseite hinaus", async () => {
  // ⚠️ The agent's values, mirrored word for word: it compares them character
  // by character, and the hub's own name `create-directory` would end in a
  // 400 there.
  const created = stub({ ok: true, name: "neu" });
  const first = await applyFileAction(
    TARGET,
    "abc",
    "daten",
    { action: "create-folder", path: "unter", name: "neu" },
    { actor: ACTOR, fetchImpl: created.fetchImpl }
  );
  assert.deepEqual(first, { name: "neu", kind: null });
  const createRequest = created.seen();
  assert.equal(createRequest.method, "POST");
  assert.deepEqual([...query(createRequest).keys()], ["share"], "der Pfad steht im Rumpf, nicht in der Abfrage");
  assert.equal(createRequest.body, JSON.stringify({ action: "create-folder", path: "unter", name: "neu" }));

  const renamed = stub({ ok: true, name: "anders.txt" });
  await applyFileAction(
    TARGET,
    "abc",
    "daten",
    { action: "rename", path: "unter/alt.txt", name: "anders.txt" },
    { actor: ACTOR, fetchImpl: renamed.fetchImpl }
  );
  assert.equal(renamed.seen().body, JSON.stringify({ action: "rename", path: "unter/alt.txt", name: "anders.txt" }));

  // Die dritte Aktion quittiert mit `kind` statt mit `name` — die einzige
  // Auskunft darüber, WAS entfernt wurde.
  const removed = stub({ ok: true, kind: "directory" });
  const third = await applyFileAction(
    TARGET,
    "abc",
    "daten",
    { action: "delete", path: "unter/weg" },
    { actor: ACTOR, fetchImpl: removed.fetchImpl }
  );
  assert.deepEqual(third, { name: null, kind: "directory" });
  // Ohne Namen geht auch kein `name` hinaus — ein leerer Name ist beim Agenten
  // etwas anderes als kein Name.
  assert.equal(removed.seen().body, JSON.stringify({ action: "delete", path: "unter/weg" }));
});

test("die drei gesendeten Aktionen sind genau die des Vertrags", () => {
  // Ohne diesen Fall bliebe eine vierte, erfundene Aktion unbemerkt — sie
  // schlüge erst beim Agenten fehl, und zwar mit einem nackten 400.
  assert.deepEqual([...FILE_ACTIONS], ["create-folder", "rename", "delete"]);
  assert.equal(FILE_ACTIONS.length, 3);
});

// ── Eine Antwort, die nicht passt ───────────────────────────────────────────

test("eine Antwort in falscher Gestalt wird als solche gemeldet", async () => {
  // Ein Proxy, der mit `200` und einer Liste antwortet, soll hier auffallen und
  // nicht drei Schichten weiter oben als `undefined`.
  const called = stub([1, 2, 3]);
  await assert.rejects(
    listFiles(TARGET, "abc", { share: "daten", path: "" }, { actor: ACTOR, fetchImpl: called.fetchImpl }),
    (error: unknown) => error instanceof AgentError && /kein Objekt/.test(error.message)
  );
});
