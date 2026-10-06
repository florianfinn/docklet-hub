import assert from "node:assert/strict";
import test, { mock } from "node:test";

import { MAX_COMPOSE_BYTES } from "contract";
import { AgentError } from "../../platform/agent-transport/protocol.js";
import {
  applyCompose,
  applyComposeStreaming,
  COMPOSE_APPLY_TIMEOUT_MS,
  readComposeFile
} from "./agent-client.js";
import { previewCompose } from "./local-preview.js";
import type { ComposeFile } from "./types.js";

// Der Client der Compose-Fläche. Gemessen wird hier DREIERLEI, und jedes davon
// fällt sonst nirgends auf:
//
//   DIE RECHNUNG    gegen die laufenden Container und nicht gegen die Datei.
//                   Nimmt jemand die falsche Liste, ist alles grün und ein
//                   Container entsteht ohne Rechteentscheidung.
//   DIE FRAGEN      der `409` trägt die richtige Liste mit. Wer ihn als
//                   blanken Fehler wegwirft, macht aus einer beantwortbaren
//                   Frage einen Fehlschlag.
//   DIE FRIST       ohne eigene Frist bricht der Hub jeden Versuch nach 10 s
//                   ab, während der Agent weiterläuft und schreibt.
//
// Jeder Fall unten ist so gebaut, dass er OHNE den zugehoerigen Code falsch
// wäre — nicht so, dass er ohnehin gewinnt.

const TARGET = { baseUrl: "http://docker-agent:8099", secret: "s".repeat(32) };
const ACTOR = { kind: "user" as const, id: "u-7" };

type Seen = { url: string; method: string | undefined; headers: Record<string, string>; body: unknown };

/** Faengt die Anfrage ab und antwortet mit `body` unter `status`. */
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

/** Ein gelesener Stand, aus dem die Vorschau rechnet. */
function file(overrides: Partial<ComposeFile> = {}): ComposeFile {
  return {
    projectDir: "/opt/stacks/medien",
    composeFileName: "compose.yaml",
    stackName: "medien",
    content: "services:\n  sonarr:\n    image: sonarr:1\n",
    composeHash: "h1",
    services: ["sonarr"],
    servicesInFile: ["sonarr"],
    fileReadable: true,
    containerIds: { sonarr: "c-sonarr" },
    inventoryViolations: [],
    ...overrides
  };
}

const APPLY_INPUT = {
  content: "services:\n  sonarr:\n    image: sonarr:2\n",
  expectedComposeHash: "h1",
  stackName: "medien",
  confirmNew: [],
  confirmRemoved: [],
  acknowledgeImagePull: [],
  acknowledgeHardening: []
};

// ── Die Rechnung ────────────────────────────────────────────────────────────

test("ein Service, den nur die DATEI kennt, gilt als neu", () => {
  // ⚠️ DER FALL, FÜR DEN ES DIESES MODUL GIBT. `radarr` steht in der Datei,
  // hat aber keinen Container — `docker compose up` erzeugt ihn also. Wer die
  // Vorschau gegen `servicesInFile` rechnet, sieht ihn als unveraendert, und
  // es entstuende ein Container, über dessen Rechte nie jemand entschieden
  // hat. Nur dieser Fall trennt die beiden Listen; bei gleichem Stand sind sie
  // ununterscheidbar.
  const current = file({ services: ["sonarr"], servicesInFile: ["sonarr", "radarr"] });
  const draft = "services:\n  sonarr:\n    image: sonarr:1\n  radarr:\n    image: radarr:1\n";

  const preview = previewCompose(current, draft);

  assert.deepEqual(preview.services.added, ["radarr"]);
  assert.deepEqual(preview.services.remaining, ["sonarr"]);
  assert.deepEqual(preview.services.removed, []);
});

test("ein Service ohne Eintrag im Entwurf gilt als entfernt", () => {
  const current = file({ services: ["sonarr", "radarr"] });
  const draft = "services:\n  sonarr:\n    image: sonarr:1\n";

  const preview = previewCompose(current, draft);

  assert.deepEqual(preview.services.removed, ["radarr"]);
  assert.deepEqual(preview.services.added, []);
});

test("die Vorschau nennt die BESTEHENDEN Befunde und verspricht keine neuen", () => {
  const current = file({ inventoryViolations: ["web:dangerous-capability", "api:privileged"] });

  const preview = previewCompose(current, current.content);

  assert.deepEqual(preview.existingViolations, ["api:privileged", "web:dangerous-capability"]);
  // Kein Feld für neue Verstöße: der Hub kann sie nicht rechnen, und ein
  // leeres Feld beruhigte falsch.
  assert.equal("newViolations" in preview, false);
});

// ── Die Grenzen ─────────────────────────────────────────────────────────────

test("die Groessengrenze zählt BYTES und nicht Zeichen", () => {
  // ⚠️ Ein Entwurf aus Umlauten liegt unter der Grenze, wenn man Zeichen
  // zählt, und darüber, wenn man Bytes zählt — der Agent zählt Bytes.
  // Eine Prüfung über `length` ließe ihn durch, und die Ablehnung kaeme
  // erst, nachdem der Betreiber seine Arbeit abgeschickt hat.
  const characters = Math.floor(MAX_COMPOSE_BYTES / 2) + 10;
  const draft = "ä".repeat(characters);

  assert.ok(draft.length < MAX_COMPOSE_BYTES, "in Zeichen unter der Grenze");
  assert.ok(Buffer.byteLength(draft, "utf8") > MAX_COMPOSE_BYTES, "in Bytes darüber");

  const blockers = previewCompose(file(), draft).blockers;
  assert.ok(
    blockers.some((blocker) => blocker.reason === "too-large"),
    "der Entwurf muss als zu groß gelten"
  );
});

test("ein kaputter Entwurf wird gemeldet und nicht geworfen", () => {
  // Die Vorschau läuft, während jemand tippt. Ein geworfener Fehler wäre
  // eine Flaeche, die beim Bearbeiten zusammenbricht.
  const preview = previewCompose(file(), "services:\n  sonarr:\n   - kaputt: [\n");

  assert.ok(
    preview.blockers.some((blocker) => blocker.reason === "invalid-yaml"),
    "der Parse-Fehler muss als Befund erscheinen"
  );
});

// ── Die Unsicherheitsmarke ──────────────────────────────────────────────────

test("die Marke greift bei extends, include und profiles", () => {
  const withExtends = previewCompose(file(), "services:\n  sonarr:\n    extends:\n      service: basis\n");
  assert.deepEqual(withExtends.uncertainties, ["extends"]);

  const withInclude = previewCompose(file(), "include:\n  - andere.yaml\nservices:\n  sonarr:\n    image: s:1\n");
  assert.deepEqual(withInclude.uncertainties, ["include"]);

  const withProfiles = previewCompose(file(), "services:\n  sonarr:\n    profiles:\n      - selten\n");
  assert.deepEqual(withProfiles.uncertainties, ["profiles"]);
});

test("die Marke greift NICHT bei gewoehnlicher Interpolation", () => {
  // ⚠️ Der Fall, der die Marke brauchbar haelt. `${TZ}` steht in fast jeder
  // echten Datei und verschiebt die Service-MENGE nicht. Meldete die Marke
  // auch ihn, wäre sie Rauschen — und Rauschen liest niemand.
  const draft = "services:\n  sonarr:\n    image: sonarr:1\n    environment:\n      TZ: ${TZ}\n";

  assert.deepEqual(previewCompose(file(), draft).uncertainties, []);
});

// ── Was hinausgeht ──────────────────────────────────────────────────────────

test("der Hub setzt confirmName selbst ein", async () => {
  // Der Mensch tippt den Stacknamen nicht ab; seine Bestaetigung hängt am
  // gezeigten Diff. Die Prüfung des Agenten bleibt unberuehrt.
  const call = stub({ ok: true });
  await applyCompose(TARGET, "abc", APPLY_INPUT, { actor: ACTOR, fetchImpl: call.fetchImpl });

  const sent = JSON.parse(String(call.seen().body)) as Record<string, unknown>;
  assert.equal(sent.confirmName, "medien");
  assert.equal(sent.expectedComposeHash, "h1");
  assert.deepEqual(sent.acknowledgeImagePull, []);
});

// ── Was ankommt: die Fragen ─────────────────────────────────────────────────

test("der 409 zu den Services kommt als Frage mit beiden Listen an", async () => {
  const call = stub(
    { error: "service-confirmation-missing", new: ["radarr"], removed: ["alt"], diff: {} },
    409
  );

  const result = await applyCompose(TARGET, "abc", APPLY_INPUT, { actor: ACTOR, fetchImpl: call.fetchImpl });

  assert.equal(result.ok, false);
  assert.deepEqual(result.ok === false ? result.question : null, {
    kind: "services",
    added: ["radarr"],
    removed: ["alt"]
  });
});

test("der 409 zu fehlenden Images trägt die Bildnamen", async () => {
  // ⚠️ Diese Liste kann der Hub NICHT selbst bilden — welche Images auf dem
  // Host fehlen, weiß nur der Agent. Sie kommt aus seiner Antwort und geht
  // unveraendert wieder hinaus. Fällt sie hier weg, ist die Frage
  // unbeantwortbar.
  const call = stub({ error: "image-not-local", missingImages: ["sonarr:2"], pull: true }, 409);

  const result = await applyCompose(TARGET, "abc", APPLY_INPUT, { actor: ACTOR, fetchImpl: call.fetchImpl });

  assert.deepEqual(result.ok === false ? result.question : null, { kind: "images", missing: ["sonarr:2"] });
});

test("der 409 zur Haertung trägt rolledBack mit", async () => {
  // ⚠️ `rolledBack: false` heißt, dass die Datei geschrieben ist und der Host
  // in einem Zustand steht, den niemand gewollt hat. Wer das Feld verliert,
  // meldet dem Betreiber einen folgenlosen Fehlschlag.
  const call = stub(
    { error: "hardening-newly-violated", newViolations: ["sonarr:privileged"], rolledBack: false },
    409
  );

  const result = await applyCompose(TARGET, "abc", APPLY_INPUT, { actor: ACTOR, fetchImpl: call.fetchImpl });

  assert.deepEqual(result.ok === false ? result.question : null, {
    kind: "hardening",
    newViolations: ["sonarr:privileged"],
    rolledBack: false
  });
});

test("der 409 des fremden Standes trägt den echten Hash", async () => {
  const call = stub({ error: "file-changed-externally", actualHash: "h2" }, 409);

  const result = await applyCompose(TARGET, "abc", APPLY_INPUT, { actor: ACTOR, fetchImpl: call.fetchImpl });

  assert.deepEqual(result.ok === false ? result.question : null, { kind: "changed-elsewhere", actualHash: "h2" });
});

// ⚠️ DIE ZWEI FÄLLE DER PRÜFPHASE. Beide fallen, bevor der Agent etwas
// schreibt: der Anker fehlt schon vor dem ersten Schreibschritt, die
// Image-Angabe wird vor dem Ziehen gelesen. Sie haben keine Antwort — kein
// Knopf hilft — und tragen deshalb kein `rolledBack`.
test("der 409 des veralteten Ankers wird eine Rückfrage ohne Antwort", async () => {
  const call = stub({ error: "stack-anchor-stale" }, 409);

  const result = await applyCompose(TARGET, "abc", APPLY_INPUT, { actor: ACTOR, fetchImpl: call.fetchImpl });

  assert.deepEqual(result.ok === false ? result.question : null, { kind: "anchor-stale" });
});

test("der 400 der unlesbaren Image-Angabe trägt die Angabe mit", async () => {
  const call = stub({ error: "image-ref-unreadable", ref: "sonarr::2" }, 400);

  const result = await applyCompose(TARGET, "abc", APPLY_INPUT, { actor: ACTOR, fetchImpl: call.fetchImpl });

  assert.deepEqual(result.ok === false ? result.question : null, {
    kind: "image-ref-unreadable",
    ref: "sonarr::2"
  });
});

test("was keine Frage ist, bleibt ein Fehler", async () => {
  // ⚠️ Ein `403` der Allowlist ist keine Frage an den Betreiber, sondern ein
  // Zustand des Systems. Wer ihn hier einfinge, boete einen Knopf an, der
  // nichts ändern kann.
  const call = stub({ error: "not-allowlisted" }, 403);

  await assert.rejects(
    () => applyCompose(TARGET, "abc", APPLY_INPUT, { actor: ACTOR, fetchImpl: call.fetchImpl }),
    (error: unknown) => error instanceof AgentError && error.status === 403
  );
});

// ── Die Ablehnung des Stroms ────────────────────────────────────────────────

test("eine Ablehnung des Anwende-Stroms trägt Status UND Schlüssel", async () => {
  // ⚠️ WORAN EINE ENTSCHEIDUNG HÄNGT UND NICHT NUR EINE MELDUNG (#129).
  // `agentStreamPost` lässt den Fehlerrumpf ABSICHTLICH ungelesen — bei einem
  // stehenden Strom gehört er dem Aufrufer. Bei einer Ablehnung gibt es keinen
  // Strom, und ohne den Rumpf sieht ein `404 not-allowlisted` des Arms genauso
  // aus wie ein Arm unter v0.22.0, der diese Route nicht kennt; der Aufrufer
  // fiele auf den synchronen Weg zurück.
  const call = stub({ error: "not-allowlisted" }, 404);

  await assert.rejects(
    () =>
      applyComposeStreaming(TARGET, "abc", APPLY_INPUT, {
        actor: ACTOR,
        fetchImpl: call.fetchImpl,
        signal: new AbortController().signal
      }),
    (error: unknown) => {
      assert.ok(error instanceof AgentError);
      assert.equal(error.status, 404);
      assert.deepEqual(error.detail, { error: "not-allowlisted" });
      return true;
    }
  );
});

// ── Die Frist ───────────────────────────────────────────────────────────────

test("das Anwenden bricht nach 10 Sekunden NICHT ab", async (t) => {
  // ⚠️ DER FALL, DER OHNE DIE EIGENE FRIST FALSCH WÄRE. Die Vorgabe des Hubs
  // sind 10 s; der Agent darf 300 s für `up` und noch einmal so lange für
  // den Rollback brauchen. Ohne eigene Frist braeche der Hub hier ab —
  // während der Agent weiterläuft und die Datei schreibt.
  t.mock.timers.enable({ apis: ["setTimeout"] });

  // Ein Halter statt zweier Variablen: `tsc` verengt eine Variable, die nur im
  // Rueckruf gesetzt wird, sonst auf `never`.
  const held: { signal: AbortSignal | null; release: ((response: Response) => void) | null } = {
    signal: null,
    release: null
  };
  const pending = new Promise<Response>((resolve) => {
    held.release = resolve;
  });
  const fetchImpl = ((_input: unknown, init?: RequestInit) => {
    held.signal = init?.signal ?? null;
    return pending;
  }) as unknown as typeof fetch;

  const call = applyCompose(TARGET, "abc", APPLY_INPUT, { actor: ACTOR, fetchImpl });

  t.mock.timers.tick(10_001);
  assert.equal(held.signal?.aborted, false, "nach 10 s darf nichts abgebrochen sein");

  t.mock.timers.tick(COMPOSE_APPLY_TIMEOUT_MS);
  assert.equal(held.signal?.aborted, true, "die eigene Frist muss trotzdem greifen");

  // Die Attrappe achtet nicht auf das Signal und antwortet trotzdem — geprueft
  // ist hier die FRIST und nicht, was ein echter `fetch` nach dem Abbruch tut.
  held.release?.(new Response("{}", { status: 200, headers: { "content-type": "application/json" } }));
  await call;
});

test("die Frist deckt den schlechtesten gemessenen Fall des Agenten", () => {
  // 300 s `docker compose up` (`src/compose-cli.ts:216`, verankert) plus
  // 300 s Rollback, der `up` und `down` mit denselben Fristen noch einmal
  // faehrt. Sinkt die Zahl unter diese Summe, bricht der Hub genau die
  // Anwendungen ab, die am laengsten gebraucht haben — und das sind die, bei
  // denen am meisten passiert ist.
  assert.ok(COMPOSE_APPLY_TIMEOUT_MS >= 300_000 + 300_000, "unter der Summe der beiden Agentenfristen");
});

// ── Lesen ───────────────────────────────────────────────────────────────────

test("der Leseaufruf trägt die Kopfzeilen und liest jedes Feld", async () => {
  const call = stub({
    projectDir: "/opt/stacks/medien",
    composeFileName: "compose.yaml",
    stackName: "medien",
    content: "services: {}\n",
    composeHash: "h9",
    services: ["sonarr"],
    servicesInFile: ["sonarr", "radarr"],
    fileReadable: true,
    containerIds: { sonarr: "c-1" },
    inventoryViolations: ["sonarr:privileged"]
  });

  const read = await readComposeFile(TARGET, "abc", { actor: ACTOR, fetchImpl: call.fetchImpl });

  assert.equal(call.seen().url, "http://docker-agent:8099/containers/abc/compose-raw");
  assert.equal(read.stackName, "medien");
  assert.equal(read.composeHash, "h9");
  assert.deepEqual(read.services, ["sonarr"]);
  assert.deepEqual(read.servicesInFile, ["sonarr", "radarr"]);
  assert.deepEqual(read.containerIds, { sonarr: "c-1" });
  assert.deepEqual(read.inventoryViolations, ["sonarr:privileged"]);
});

test("eine Antwort ohne die Listen ergibt leere Listen und keinen Absturz", () => {
  // Der Agent ist eine fremde Seite; eine Antwort, der ein Feld fehlt, darf
  // die Route nicht mit einem Typfehler beenden.
  const call = stub({ stackName: "medien", content: "", composeHash: "h1" });
  return readComposeFile(TARGET, "abc", { actor: ACTOR, fetchImpl: call.fetchImpl }).then((read) => {
    assert.deepEqual(read.services, []);
    assert.deepEqual(read.inventoryViolations, []);
    assert.deepEqual(read.containerIds, {});
    assert.equal(read.fileReadable, false);
  });
});

// `mock` ist importiert, damit die Zeitsteuerung auch dann verfügbar ist,
// wenn ein Fall sie außerhalb von `t` braucht.
void mock;
