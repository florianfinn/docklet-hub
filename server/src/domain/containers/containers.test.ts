import test from "node:test";
import assert from "node:assert/strict";

import {
  fetchContainers,
  fetchContainerStats,
  parseContainerList,
  parseContainerStats,
  withoutHistory
} from "./containers.js";
import { ACTOR_HEADER, SECRET_HEADER } from "contract";
import { AgentError } from "../../platform/agent-transport/protocol.js";

// Der Nachweis dieser Phase steht und fällt mit dieser Auswertung: was der
// Agent schickt, ist die einzige Auskunft über den Host, die dieser Hub hat.
//
// Geprüft wird gegen die Form, die der Agent v0.18.1 unter GET /containers
// liefert (`src/redact.ts`, `ContainerSummary`) — der Fassung, auf die der Pin
// in docker-compose.yml zeigt. Kein laufender Agent nötig — AGENTS.md verlangt
// Tests ohne echte Dienste.
//
// Gegengelesen am 2026-09-04 an v0.18.1: `ContainerSummary` und
// `ContainerStats` tragen dieselben Felder wie in v0.17.0. Der eine
// Leitungsschlüssel, den v0.18.0 umbenennt (`bootstrap.versuche` →
// `bootstrap.attempts` in `/health`), wird von diesem Hub nicht gelesen;
// v0.18.1 fasst die Leitung gar nicht an.

// Ein Datensatz, wie der Agent ihn schickt. Bewusst mit den Feldern, die der
// Hub NICHT nimmt (envKeys, hardening, imageMutability): sie sollen
// durchfallen, nicht mitwandern.
//
// ⚠️ `externalManagement` gehörte bis D6b in diese Aufzählung und tut es nicht
// mehr: die Fläche „Container" führt fremdverwaltete Container als eigene
// Gruppe und nennt, wer sie verwaltet (#20, Entscheidung vom 2026-09-06). Das
// Feld wandert seitdem MIT.
const SUMMARY = {
  id: "3f1c2b",
  name: "media-jellyfin",
  image: "ghcr.io/example/jellyfin:10.9.0",
  status: "running",
  running: true,
  startedAt: "2026-09-01T08:00:00.000Z",
  health: "healthy",
  envKeys: ["PUID", "TZ"],
  hardening: { delegationLock: [], warning: [], hint: [] },
  stats: { cpuPercent: 3.5, memUsageBytes: 1024, memLimitBytes: 4096, sampledAt: null, samples: [] },
  compose: { project: "media", service: "jellyfin" },
  externalManagement: null,
  imageMutability: "floating"
};

test("ein vollständiger Datensatz wird auf die Felder der Übersicht verkürzt", () => {
  const [entry] = parseContainerList({ containers: [SUMMARY] });
  assert.deepEqual(entry, {
    id: "3f1c2b",
    name: "media-jellyfin",
    image: "ghcr.io/example/jellyfin:10.9.0",
    status: "running",
    running: true,
    exitCode: null,
    startedAt: "2026-09-01T08:00:00.000Z",
    health: "healthy",
    compose: { project: "media", service: "jellyfin" },
    stats: { cpuPercent: 3.5, memUsageBytes: 1024, memLimitBytes: 4096, sampledAt: null, samples: [] },
    externalManagement: null
  });
});

test("eine gemeldete Fremdverwaltung kommt an", () => {
  // Die Form ist gemessen und nicht geraten: `florianfinn/dashboard-docker-agent`
  // @6ffc3c8 (v0.19.1), `src/redact.ts:59` — `{ manager: "unraid" } | null`,
  // gefüllt aus dem Label `net.unraid.docker.managed` (`foreignManagementOf`,
  // Z. 163-169).
  const [entry] = parseContainerList({
    containers: [{ ...SUMMARY, externalManagement: { manager: "unraid" } }]
  });
  assert.deepEqual(entry.externalManagement, { manager: "unraid" });
});

test("ein zweiter Verwalter scheitert nicht am Parser", () => {
  // `manager` ist eine Zeichenkette und keine Aufzählung. Ein Agent, der
  // morgen einen weiteren Verwalter meldet, soll in der Oberfläche mit seinem
  // Namen erscheinen — eine Aufzählung machte daraus einen Abbruch der ganzen
  // Liste, denn `parseContainerList` kürzt nicht, sondern bricht ab.
  const [entry] = parseContainerList({
    containers: [{ ...SUMMARY, externalManagement: { manager: "portainer" } }]
  });
  assert.deepEqual(entry.externalManagement, { manager: "portainer" });
});

test("ein Agent ohne dieses Feld wirft die Fläche nicht um", () => {
  // The pin stands on v0.32.0 and so does the mark (`MIN_AGENT_VERSION`); both
  // send `externalManagement`, but an arm does not have to know the field —
  // it is no promise of the wire. Its absence is therefore no error but the
  // default `null`, and so is an unusable value: the external management is a
  // hint on the row and not the row itself.
  const { externalManagement: _gone, ...withoutField } = SUMMARY;
  assert.equal(parseContainerList({ containers: [withoutField] })[0].externalManagement, null);
  assert.equal(parseContainerList({ containers: [{ ...SUMMARY, externalManagement: {} }] })[0].externalManagement, null);
  assert.equal(
    parseContainerList({ containers: [{ ...SUMMARY, externalManagement: { manager: "  " } }] })[0].externalManagement,
    null
  );
  assert.equal(
    parseContainerList({ containers: [{ ...SUMMARY, externalManagement: "unraid" }] })[0].externalManagement,
    null
  );
});

test("eine leere Liste ist eine gültige Antwort", () => {
  // Ein frisch aufgesetzter Agent hat eine leere Allowlist. Das ist der
  // Normalfall beim ersten Start und kein Fehler.
  assert.deepEqual(parseContainerList({ containers: [] }), []);
});

test("fehlende Stats bleiben null und werden nicht zu Nullwerten", () => {
  // „gerade nicht ermittelbar" und „null Prozent" sind verschiedene Aussagen.
  // Wer sie zusammenzieht, zeigt einen ruhigen Container, wo keine Messung ist.
  const [entry] = parseContainerList({ containers: [{ ...SUMMARY, stats: null }] });
  assert.equal(entry.stats, null);
});

test("einzelne fehlende Stats-Werte bleiben null", () => {
  const [entry] = parseContainerList({
    containers: [{ ...SUMMARY, stats: { cpuPercent: null, memUsageBytes: 512, memLimitBytes: null } }]
  });
  assert.deepEqual(entry.stats, {
    cpuPercent: null,
    memUsageBytes: 512,
    memLimitBytes: null,
    sampledAt: null,
    samples: []
  });
});

// Der Verlauf in der Form des Agenten: `StatsRingBuffer.snapshot` in
// `src/stats.ts` von `dashboard-docker-agent` — älteste Messung zuerst,
// `sampledAt` als ISO-Zeitpunkt, jede Zahl einzeln `null`-fähig (#213).
const SAMPLES = [
  { sampledAt: "2026-09-30T10:00:00.000Z", cpuPercent: null, memUsageBytes: 900, memLimitBytes: 4096 },
  { sampledAt: "2026-09-30T10:00:10.000Z", cpuPercent: 3.5, memUsageBytes: 1024, memLimitBytes: 4096 }
];

test("der Verlauf wird durchgereicht, samt Zeitpunkt der letzten Messung", () => {
  const [entry] = parseContainerList({
    containers: [{ ...SUMMARY, stats: { ...SUMMARY.stats, sampledAt: "2026-09-30T10:00:10.000Z", samples: SAMPLES } }]
  });
  assert.equal(entry.stats?.sampledAt, "2026-09-30T10:00:10.000Z");
  assert.deepEqual(entry.stats?.samples, SAMPLES);
});

test("ein Messpunkt ohne lesbaren Zeitpunkt fällt heraus, die Zeile bleibt", () => {
  // Kürzen statt abbrechen: ein kaputter Messpunkt nimmt dem Verlauf einen
  // Wert und nicht dem Container seine Zeile. Die `null` im ersten Punkt
  // bleibt dabei `null` — eine Lücke, keine Null.
  const [entry] = parseContainerList({
    containers: [
      {
        ...SUMMARY,
        stats: {
          ...SUMMARY.stats,
          samples: [SAMPLES[0], { cpuPercent: 1 }, { sampledAt: "gestern", cpuPercent: 1 }, "x", SAMPLES[1]]
        }
      }
    ]
  });
  assert.deepEqual(entry.stats?.samples, SAMPLES);
  assert.equal(entry.stats?.samples[0].cpuPercent, null);
});

test("ein Agent ohne Verlauf liefert einen leeren Verlauf und keinen Fehler", () => {
  const [entry] = parseContainerList({
    containers: [{ ...SUMMARY, stats: { cpuPercent: 1, memUsageBytes: 2, memLimitBytes: null, samples: "nein" } }]
  });
  assert.deepEqual(entry.stats?.samples, []);
  assert.equal(entry.stats?.sampledAt, null);
});

test("ohne Verlauf bleibt der letzte Wert stehen und nur der Verlauf geht", () => {
  const [entry] = parseContainerList({
    containers: [{ ...SUMMARY, stats: { ...SUMMARY.stats, samples: SAMPLES } }]
  });
  const trimmed = withoutHistory(entry);
  assert.deepEqual(trimmed.stats?.samples, []);
  assert.equal(trimmed.stats?.cpuPercent, 3.5);
  assert.equal(entry.stats?.samples.length, 2, "das Original bleibt unberührt");
  const [stopped] = parseContainerList({ containers: [{ ...SUMMARY, stats: null }] });
  assert.equal(withoutHistory(stopped).stats, null);
});

test("die Einzelansicht liefert die Messwerte eines Containers", () => {
  assert.deepEqual(parseContainerStats({ ...SUMMARY, stats: { ...SUMMARY.stats, samples: SAMPLES } })?.samples, SAMPLES);
  assert.equal(parseContainerStats({ ...SUMMARY, stats: null }), null);
  assert.throws(() => parseContainerStats([]), AgentError);
});

test("eine unvollständige Compose-Angabe wird zu null statt zu einem halben Objekt", () => {
  const [entry] = parseContainerList({ containers: [{ ...SUMMARY, compose: { project: "media" } }] });
  assert.equal(entry.compose, null);
});

test("ein Container ohne Id hält die ganze Antwort an", () => {
  // ⚠️ Der wichtigste Fall dieser Datei. Eine Übersicht, die einen Container
  // stillschweigend weglässt, sieht vollständig aus — und genau darauf schaut
  // jemand, der wissen will, ob alles läuft.
  assert.throws(
    () => parseContainerList({ containers: [SUMMARY, { ...SUMMARY, id: "" }] }),
    (error: unknown) => error instanceof AgentError && /Container 2/.test((error as Error).message)
  );
});

test("eine Antwort ohne containers-Feld hält an", () => {
  for (const body of [{}, { containers: null }, { containers: "keine" }, [], null, "text"]) {
    assert.throws(() => parseContainerList(body), AgentError, `${JSON.stringify(body)} hätte anhalten müssen`);
  }
});

test("die Anfrage trägt Geheimnis und Aufrufer, aber keine Netzstufe", () => {
  // Without the actor the agent's audit log has no trace back to a person.
  let seen: { url: string; headers: Record<string, string> } | null = null;
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    seen = { url: String(input), headers: init?.headers as Record<string, string> };
    return new Response(JSON.stringify({ containers: [] }), {
      status: 200,
      headers: { "content-type": "application/json" }
    });
  }) as unknown as typeof fetch;

  return fetchContainers(
    { baseUrl: "http://docker-agent:8099", secret: "s".repeat(32) },
    { actor: { kind: "user", id: "u-1" }, fetchImpl }
  ).then((containers) => {
    assert.deepEqual(containers, []);
    assert.ok(seen);
    const request = seen as unknown as { url: string; headers: Record<string, string> };
    assert.equal(request.url, "http://docker-agent:8099/containers");
    assert.equal(request.headers[SECRET_HEADER], "s".repeat(32));
    assert.equal(request.headers[ACTOR_HEADER], "user:u-1");
    assert.equal(request.headers["x-docker-agent-tier"], undefined);
  });
});

test("die Einzelansicht fragt den Container unter seiner kodierten Kennung", async () => {
  let url = "";
  const fetchImpl = (async (input: string | URL | Request) => {
    url = String(input);
    return new Response(JSON.stringify({ ...SUMMARY, stats: { ...SUMMARY.stats, samples: SAMPLES } }), {
      status: 200,
      headers: { "content-type": "application/json" }
    });
  }) as unknown as typeof fetch;

  const stats = await fetchContainerStats(
    { baseUrl: "http://docker-agent:8099", secret: "s".repeat(32) },
    "a/b",
    { actor: { kind: "user", id: "u-1" }, fetchImpl }
  );
  assert.equal(url, "http://docker-agent:8099/containers/a%2Fb");
  assert.deepEqual(stats?.samples, SAMPLES);
});

test("runtime eligibility and exit code travel without registry or self-management diagnostics", () => {
  const [entry] = parseContainerList({ containers: [{ ...SUMMARY, exitCode: 1,
    runtimeAccess: { blocker: "observe-only", privateDirectory: "/private" } }] });
  assert.equal(entry.exitCode, 1); assert.deepEqual(entry.runtimeAccess, { blocker: "observe-only" });
  assert.equal(parseContainerList({ containers: [{ ...SUMMARY, runtimeAccess: { blocker: "private" } }] })[0].runtimeAccess, undefined);
});

test("explicit one-shot evidence is preserved but absent or malformed evidence is not inferred", () => {
  for (const value of [true, false, undefined, "true"]) {
    const [entry] = parseContainerList({ containers: [{ ...SUMMARY, exitCode: 0, oneShot: value }] });
    assert.equal(entry.oneShot, typeof value === "boolean" ? value : undefined);
  }
});
