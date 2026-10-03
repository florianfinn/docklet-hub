import test from "node:test";
import assert from "node:assert/strict";

import { ACTOR_HEADER, HUB_TIER, SECRET_HEADER, TIER_HEADER } from "contract";
import { AgentError } from "../../platform/agent-transport/protocol.js";
import {
  buildRegistryEntries,
  REGISTRY_SYNC_ACTOR,
  syncRegistry,
  toRegistryRequestBody,
  type ContainerShareInput,
  type DiscoveredStack,
  type HostInventoryContainer
} from "./registry-sync.js";

// Die Rechnung hinter dem Registry-Abgleich, geprüft ohne Netz und ohne
// Agenten — AGENTS.md verlangt Tests ohne echte Dienste.
//
// ⚠️ Diese Datei ist die einzige Stelle, an der die vier gemessenen Fallen des
// Vertrags festgehalten sind: der wörtlich geprüfte Wert `"adopted"`, der halbe
// Anker, der fremdverwaltete Container (ohne Eintrag oder mit `externallyManaged`) und die Vollständigkeit der
// Liste. Jede davon fällt beim Lesen nicht auf — der Agent antwortet auf einen
// Formfehler mit `200` und einer Liste, aus der er den fehlerhaften Eintrag
// stillschweigend entfernt hat.

const JELLYFIN: HostInventoryContainer = {
  id: "3f1c2b",
  name: "media-jellyfin",
  image: "ghcr.io/example/jellyfin:10.9.0",
  externalManagement: null
};

const MEDIA_STACK: DiscoveredStack = {
  projectDir: "/srv/stacks/media",
  projectName: "media",
  composeFileName: "docker-compose.yml",
  services: [{ serviceName: "jellyfin", containerId: "3f1c2b" }]
};

test("ein Container mit vollständigem Anker bekommt ihn mit origin „adopted“", () => {
  // ⚠️ The agent compares the value LITERALLY: its registry schema
  // (`contract/src/agent/`) only lets `"dashboard"` and `"adopted"` through.
  // Any other wording, like the `"adoptiert"` that stood here until v0.23.0,
  // invalidated the WHOLE anchor, and the entry silently lost its compose.
  const [entry] = buildRegistryEntries([JELLYFIN], [MEDIA_STACK]);
  assert.deepEqual(entry, {
    containerId: "3f1c2b",
    containerName: "media-jellyfin",
    imageRef: "ghcr.io/example/jellyfin:10.9.0",
    allowed: true,
    compose: {
      projectDir: "/srv/stacks/media",
      projectName: "media",
      serviceName: "jellyfin",
      composeFileName: "docker-compose.yml",
      origin: "adopted"
    },
    sharePath: null
  });
});

test("ein Container, den die Erhebung nicht führt, bekommt allowed und kein compose-Feld", () => {
  // ⚠️ „kein Feld" und nicht „ein Feld mit leeren Werten": `isRegistryEntry`
  // lehnt einen Eintrag mit unbrauchbarem `compose` ab, und `replaceAll` lässt
  // den abgelehnten Eintrag stillschweigend weg. Der Container verlöre so
  // seinen ganzen Platz in der Allowlist, statt nur seinen Compose-Zugriff.
  const [entry] = buildRegistryEntries([JELLYFIN], []);
  assert.equal(entry.allowed, true);
  assert.equal(entry.compose, null);

  const [wire] = toRegistryRequestBody([entry]).entries;
  assert.equal("compose" in wire, false);
  assert.deepEqual(Object.keys(wire), ["containerId", "containerName", "imageRef", "allowed"]);
});

test("ein halber Anker aus der Erhebung wird ganz verworfen", () => {
  // `isRegistryCompose` verlangt projectDir, serviceName und composeFileName
  // GEMEINSAM. Ein Stack ohne Verzeichnis oder ohne Dateinamen ergibt deshalb
  // keinen halben Anker, sondern gar keinen.
  const withoutDirectory: DiscoveredStack = { ...MEDIA_STACK, projectDir: "" };
  const withoutFileName: DiscoveredStack = { ...MEDIA_STACK, composeFileName: "" };
  const withoutService: DiscoveredStack = {
    ...MEDIA_STACK,
    services: [{ serviceName: "", containerId: "3f1c2b" }]
  };
  for (const stack of [withoutDirectory, withoutFileName, withoutService]) {
    assert.equal(buildRegistryEntries([JELLYFIN], [stack])[0].compose, null);
  }
});

test("ein fehlender Projektname lässt das Feld weg statt es leer zu setzen", () => {
  // `projectName` ist im Vertrag optional; ohne ihn lehnt der Agent
  // STACK-Aktionen ab. Ein leerer Wert brächte sie nicht zurück, sondern wäre
  // eine Angabe ohne Inhalt.
  const [entry] = buildRegistryEntries([JELLYFIN], [{ ...MEDIA_STACK, projectName: "" }]);
  assert.ok(entry.compose);
  assert.equal("projectName" in entry.compose, false);
  assert.equal(entry.compose.projectDir, "/srv/stacks/media");
});

const UNRAID_PLEX: HostInventoryContainer = {
  id: "aa11bb",
  name: "unraid-plex",
  image: "lscr.io/linuxserver/plex:latest",
  externalManagement: { manager: "unraid" }
};

test("ohne Zusage des Agenten bekommt ein fremdverwalteter Container gar keinen Eintrag", () => {
  // ⚠️ Die Vorgabe ist der Stand aus #20: ein Agent vor v0.31.0 kennt
  // `externallyManaged` nicht, legte es still ab und öffnete pull, recreate
  // und remove. Ohne ausdrückliche Zusage bleibt der Container draußen.
  const entries = buildRegistryEntries([JELLYFIN, UNRAID_PLEX], [MEDIA_STACK]);
  // Beides prüfen: die Länge fängt den zusätzlichen Eintrag, die Suche nach
  // der Id fängt den Fall, dass er einen anderen verdrängt hat.
  assert.equal(entries.length, 1);
  assert.equal(
    entries.some((entry) => entry.containerId === "aa11bb"),
    false
  );
  assert.equal(JSON.stringify(toRegistryRequestBody(entries)).includes("aa11bb"), false);
});

test("kennt der Agent die Klasse, reist ein fremdverwalteter mit externallyManaged (#124)", () => {
  const entries = buildRegistryEntries([JELLYFIN, UNRAID_PLEX], [MEDIA_STACK], [
    { containerName: "unraid-plex", path: "config" }
  ], { externallyManaged: true });
  assert.equal(entries.length, 2);
  const wire = toRegistryRequestBody(entries).entries;
  const plex = wire.find((entry) => entry.containerId === "aa11bb");
  assert.deepEqual(plex, {
    containerId: "aa11bb",
    containerName: "unraid-plex",
    imageRef: "lscr.io/linuxserver/plex:latest",
    // `allowed: true` und NICHT `false`: der Agent erteilt mit
    // `externallyManaged` allein nichts (fail closed).
    allowed: true,
    // Freigaben wie bei jedem anderen Container — der Verwalter fasst die
    // Dateien nicht an (Entscheidung vom 2026-09-30).
    shares: ["config"],
    externallyManaged: true
  });
  // Ein eigener Container trägt das Feld gar nicht, auch nicht als `false`.
  const own = wire.find((entry) => entry.containerId === JELLYFIN.id);
  assert.equal(own !== undefined && "externallyManaged" in own, false);
});

test("jeder gemeldete Verwalter sperrt die Definition, auch ein unsicherer (#5)", () => {
  for (const manager of ["unraid", "unraid-compose", "unknown"]) {
    const container: HostInventoryContainer = { ...UNRAID_PLEX, externalManagement: { manager } };
    const [entry] = toRegistryRequestBody(buildRegistryEntries([container], [], [], { externallyManaged: true })).entries;
    assert.equal(entry?.externallyManaged, true, manager);
  }
});

test("die Liste ist vollständig und keine Änderungsmenge", () => {
  // `PUT /registry` ersetzt die Liste des Agenten VOLLSTÄNDIG
  // (`registry.replaceAll`). Was im Bestand steht, steht drin — sonst entzieht
  // der Abgleich dem Agenten Container, die niemand angefasst hat.
  const inventory: HostInventoryContainer[] = [
    JELLYFIN,
    { id: "b2", name: "db-postgres", image: "postgres:17", externalManagement: null },
    { id: "c3", name: "proxy-caddy", image: "caddy:2", externalManagement: null }
  ];
  const entries = buildRegistryEntries(inventory, [MEDIA_STACK]);
  assert.equal(entries.length, 3);
  assert.deepEqual(
    entries.map((entry) => entry.containerId),
    ["3f1c2b", "b2", "c3"]
  );
  assert.deepEqual(
    entries.map((entry) => entry.allowed),
    [true, true, true]
  );
});

test("ein Stack ohne zugehörigen Container im Bestand erzeugt keinen Eintrag aus dem Nichts", () => {
  // Die Erhebung kennt Stacks, deren Container nicht (mehr) laufen —
  // `directory-without-container` in ihren `findings`. Ein Eintrag dafür
  // beschriebe einen Container, den es auf dem Host nicht gibt.
  const ghost: DiscoveredStack = {
    projectDir: "/srv/stacks/alt",
    projectName: "alt",
    composeFileName: "compose.yaml",
    services: [{ serviceName: "web", containerId: "gone-99" }]
  };
  const entries = buildRegistryEntries([JELLYFIN], [MEDIA_STACK, ghost]);
  assert.equal(entries.length, 1);
  assert.equal(entries[0].containerId, "3f1c2b");
});

test("imageRef kommt aus dem Bestand und nicht aus der Erhebung", () => {
  // Der Bestand nennt das Image, mit dem der Container GERADE LÄUFT; die
  // Compose-Datei nennt, was beim nächsten Start gälte. `imageRef` bestimmt
  // beim Agenten, worauf ein `pull` ziehen darf — das muss der laufende Stand
  // sein, sonst zöge ein Update auf etwas, das dieser Container nie war.
  const stackWithOtherImage = {
    ...MEDIA_STACK,
    services: [{ serviceName: "jellyfin", containerId: "3f1c2b", image: "ghcr.io/example/jellyfin:11.0.0" }]
  };
  const [entry] = buildRegistryEntries([JELLYFIN], [stackWithOtherImage]);
  assert.equal(entry.imageRef, "ghcr.io/example/jellyfin:10.9.0");
});

test("ein leerer Bestand ergibt eine leere Liste und keinen Fehler", () => {
  // Ein Host ohne Container ist eine gültige Lage. Der Abgleich schickt dann
  // eine leere Liste — und leert damit die Allowlist des Agenten, was richtig
  // ist: der Bestand führt.
  assert.deepEqual(buildRegistryEntries([], []), []);
  assert.deepEqual(toRegistryRequestBody([]), { entries: [] });
});

// ---------------------------------------------------------------------------
// Die Freigabe (Etappe E2, #5, B5)
// ---------------------------------------------------------------------------

test("eine gewählte Freigabe wird über den Namen zugeordnet und als Einerliste verpackt", () => {
  // ⚠️ `shares: [pfad]` und NICHT `shares: [pfad, ...]` — die Ablage
  // (`domain/containers/shares.ts`) hält je (Arm, Containername) genau einen Pfad,
  // auch wenn die Vertragsdatei des Agenten hier grundsätzlich mehrere
  // zuließe.
  const shares: ContainerShareInput[] = [{ containerName: "media-jellyfin", path: "downloads" }];
  const [entry] = buildRegistryEntries([JELLYFIN], [MEDIA_STACK], shares);
  assert.equal(entry.sharePath, "downloads");

  const [wire] = toRegistryRequestBody([entry]).entries;
  assert.deepEqual(wire.shares, ["downloads"]);
});

test("die Zuordnung geht über den Containernamen, nicht über die Id", () => {
  // ⚠️ DER KERN DER ENTSCHEIDUNG DES LEITSTANDS: eine Freigabe, die unter dem
  // NAMEN abgelegt ist, findet ihren Container auch dann, wenn dessen Id sich
  // geändert hat (ein `recreate`) — genau der Fall, für den die Ablage nicht
  // nach Id geführt wird.
  const recreated: HostInventoryContainer = { ...JELLYFIN, id: "neue-id-nach-recreate" };
  const shares: ContainerShareInput[] = [{ containerName: "media-jellyfin", path: "downloads" }];
  const [entry] = buildRegistryEntries([recreated], [], shares);
  assert.equal(entry.containerId, "neue-id-nach-recreate");
  assert.equal(entry.sharePath, "downloads");
});

test("eine Freigabe für einen anderen Containernamen bleibt ohne Wirkung", () => {
  const shares: ContainerShareInput[] = [{ containerName: "media-plex", path: "downloads" }];
  const [entry] = buildRegistryEntries([JELLYFIN], [], shares);
  assert.equal(entry.sharePath, null);
  assert.equal("shares" in toRegistryRequestBody([entry]).entries[0], false);
});

test("ohne gewählte Freigabe bleibt das Feld shares auf der Leitung ganz weg", () => {
  // ⚠️ NIE `shares: []`. Ein leeres Array wäre auf der Leitung zwar gültig,
  // aber eine Zusage ohne Deckung — dieselbe Falle wie bei `compose: null`.
  const [entry] = buildRegistryEntries([JELLYFIN], [MEDIA_STACK]);
  assert.equal(entry.sharePath, null);
  const [wire] = toRegistryRequestBody([entry]).entries;
  assert.equal("shares" in wire, false);
});

// ---------------------------------------------------------------------------
// Der Schreibaufruf
// ---------------------------------------------------------------------------

const TARGET = { baseUrl: "http://docker-agent:8099", secret: "s".repeat(32) };

function replyWith(status: number, body: unknown): typeof fetch {
  return (async () =>
    new Response(JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json" }
    })) as unknown as typeof fetch;
}

test("der Abgleich schickt die vollständige Liste als PUT /registry", async () => {
  let seen: { url: string; method: string | undefined; headers: Record<string, string>; body: unknown } | null = null;
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    seen = {
      url: String(input),
      method: init?.method,
      headers: init?.headers as Record<string, string>,
      body: init?.body
    };
    return new Response(JSON.stringify({ ok: true, entries: 1 }), {
      status: 200,
      headers: { "content-type": "application/json" }
    });
  }) as unknown as typeof fetch;

  const entries = buildRegistryEntries([JELLYFIN], [MEDIA_STACK]);
  await syncRegistry(TARGET, entries, { actor: REGISTRY_SYNC_ACTOR, fetchImpl });

  assert.ok(seen);
  const request = seen as unknown as {
    url: string;
    method: string | undefined;
    headers: Record<string, string>;
    body: unknown;
  };
  assert.equal(request.url, "http://docker-agent:8099/registry");
  assert.equal(request.method, "PUT");
  assert.equal(request.headers[SECRET_HEADER], "s".repeat(32));
  assert.equal(request.headers[TIER_HEADER], HUB_TIER);
  // ⚠️ `system:hub` und kein Benutzerkonto. Der Agent schreibt diesen Wert in
  // sein Audit-Log; ein `user:<id>` behauptete, ein Mensch habe den Abgleich
  // ausgelöst, und wer das Log später liest, suchte nach einer Entscheidung,
  // die niemand getroffen hat.
  assert.equal(request.headers[ACTOR_HEADER], "system:hub");
  assert.deepEqual(JSON.parse(String(request.body)), toRegistryRequestBody(entries));
});

test("meldet der Agent weniger Einträge als geschickt, ist das ein Fehler", async () => {
  // ⚠️ DER SCHLIMMSTE FALL DIESER ETAPPE. `replaceAll` (v0.19.1,
  // `src/registry.ts`) lässt jeden Eintrag, den `isRegistryEntry` ablehnt,
  // stillschweigend weg und antwortet trotzdem mit 200 und `{ ok: true }`.
  // Ohne diesen Vergleich meldete der Abgleich „hat geklappt" und hätte
  // nichts eingetragen — und jeder fehlende Container wäre beim Agenten für
  // jede Aktion gesperrt, ohne dass jemand sähe, warum.
  const entries = buildRegistryEntries(
    [JELLYFIN, { id: "b2", name: "db-postgres", image: "postgres:17", externalManagement: null }],
    [MEDIA_STACK]
  );
  assert.equal(entries.length, 2);
  await assert.rejects(
    syncRegistry(TARGET, entries, {
      actor: REGISTRY_SYNC_ACTOR,
      fetchImpl: replyWith(200, { ok: true, entries: 1 })
    }),
    (error: unknown) =>
      error instanceof AgentError && /1 von 2/.test((error as Error).message) && /Audit-Log/.test((error as Error).message)
  );
});

test("meldet der Agent mehr Einträge als geschickt, ist das ebenfalls ein Fehler", async () => {
  // Ein Agent, der mehr quittiert als er bekommen hat, hat entweder nicht
  // ersetzt, sondern ergänzt, oder er meint eine andere Zahl. Beides trifft
  // die Zusage „die Liste ist vollständig und ersetzt" und darf nicht als
  // Erfolg durchgehen.
  await assert.rejects(
    syncRegistry(TARGET, buildRegistryEntries([JELLYFIN], []), {
      actor: REGISTRY_SYNC_ACTOR,
      fetchImpl: replyWith(200, { ok: true, entries: 5 })
    }),
    (error: unknown) => error instanceof AgentError && /5 von 1/.test((error as Error).message)
  );
});

test("eine Quittung ohne Zahl gilt nicht als Beleg", async () => {
  // Die Zahl ist die einzige Rückmeldung über das, was angekommen ist. Fehlt
  // sie, ist der Abgleich nicht bestätigt — auch wenn `ok: true` dasteht.
  for (const body of [{ ok: true }, { ok: true, entries: "1" }, { ok: true, entries: -1 }, { ok: true, entries: 1.5 }, []]) {
    await assert.rejects(
      syncRegistry(TARGET, buildRegistryEntries([JELLYFIN], []), {
        actor: REGISTRY_SYNC_ACTOR,
        fetchImpl: replyWith(200, body)
      }),
      AgentError,
      `${JSON.stringify(body)} hätte als Quittung nicht genügen dürfen`
    );
  }
});

test("eine passende Quittung geht ohne Fehler durch", async () => {
  await syncRegistry(TARGET, buildRegistryEntries([JELLYFIN], [MEDIA_STACK]), {
    actor: REGISTRY_SYNC_ACTOR,
    fetchImpl: replyWith(200, { ok: true, entries: 1 })
  });
  // Auch der leere Fall: null gesendet, null quittiert.
  await syncRegistry(TARGET, [], { actor: REGISTRY_SYNC_ACTOR, fetchImpl: replyWith(200, { ok: true, entries: 0 }) });
});

test("ein 403 und ein 401 auf PUT /registry werden auseinandergehalten", async () => {
  const entries = buildRegistryEntries([JELLYFIN], [MEDIA_STACK]);
  await assert.rejects(
    syncRegistry(TARGET, entries, { actor: REGISTRY_SYNC_ACTOR, fetchImpl: replyWith(403, {}) }),
    (error: unknown) =>
      error instanceof AgentError && error.status === 403 && /Audit-Log/.test((error as Error).message)
  );
  await assert.rejects(
    syncRegistry(TARGET, entries, { actor: REGISTRY_SYNC_ACTOR, fetchImpl: replyWith(401, {}) }),
    (error: unknown) =>
      error instanceof AgentError && error.status === 401 && /DOCKER_AGENT_SECRET/.test((error as Error).message)
  );
});
