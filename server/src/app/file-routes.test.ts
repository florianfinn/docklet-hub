import test from "node:test";
import assert from "node:assert/strict";

import { MAX_TEXT_BYTES, MAX_UPLOAD_BYTES } from "../features/files/index.js";
import {
  ANCIENT,
  call,
  ENDLESS_BLOCK_BYTES,
  CONTAINER_NAME,
  GONE,
  ROW_SECRET,
  SHARE,
  startAgent,
  startHub,
  url,
  withContainer
} from "./file-routes-test-support.js";

// Die Datei-Fläche über den ganzen Weg: echter Router, echter Express, ein
// kleiner Zuhörer auf 127.0.0.1 als Agent (dasselbe Muster wie
// `container-routes.test.ts`). Kein Postgres, kein docker.sock, kein laufender
// Agent — AGENTS.md verlangt Tests ohne echte Dienste.
//
// ⚠️ WAS DIESE DATEI VOR ALLEM PRÜFT, und warum sie dafür einen echten Server
// fährt: die STELLUNG der Zwischenschichten. Ein Textwächter
// (`web/tests/api-read-only.test.mjs`) liest, dass `requireAdmin` unmittelbar
// hinter dem Pfad steht; er kann aber nicht sagen, was passiert, wenn es
// woanders steht. Genau dafür stehen unten VERHALTENSFÄLLE: ein Benutzer ohne
// Adminrechte bekommt `403`, und zwar an einer schreibenden UND an einer
// lesenden Route. Verrutscht die Schicht, meldet der Fall `204 !== 403` statt
// eines Textbefunds.

// ── 1. Die Rolle: Admin, auch lesend ────────────────────────────────────────

test("eine schreibende Route weist einen Benutzer ohne Adminrechte ab", async () => {
  // ⚠️ DER VERHALTENSFALL ZUR STELLUNG VON `requireAdmin`. Steht die
  // Zwischenschicht nicht an erster Stelle, läuft der Handler an — und
  // `DELETE …/share` antwortet dann `204` statt `403`. Der Textwächter
  // `web/tests/api-read-only.test.mjs` prüft dieselbe Zusage im Quelltext;
  // dieser Fall prüft sie am laufenden Server.
  const agent = await startAgent();
  withContainer(agent);
  const hub = await startHub({ agent, share: SHARE });
  try {
    const denied = await call(url(hub, "share"), { role: "user", method: "DELETE" });
    assert.equal(denied.status, 403);
    assert.deepEqual(await denied.json(), { error: "admin-required" });
    assert.deepEqual(hub.store.writes, [], "die Ablage wurde trotz Ablehnung angefasst");

    const allowed = await call(url(hub, "share"), { role: "admin", method: "DELETE" });
    assert.equal(allowed.status, 204);
    assert.deepEqual(hub.store.writes, [`remove:${CONTAINER_NAME}`]);
  } finally {
    await hub.close();
    await agent.close();
  }
});

test("auch eine LESENDE Route dieser Fläche verlangt Admin", async () => {
  // §4, Tabelle „Fähigkeit / Rolle": „Dateien lesen und schreiben | Admin |
  // Schreibend ohnehin; lesend, weil eine Freigabe eine Betreiberentscheidung
  // ist." Anders als beim Log-Strom gibt es hier keine Ausnahme.
  const agent = await startAgent();
  withContainer(agent);
  const hub = await startHub({ agent, share: SHARE });
  try {
    const denied = await call(url(hub, "files"), { role: "user" });
    assert.equal(denied.status, 403);
    assert.deepEqual(await denied.json(), { error: "admin-required" });
    assert.deepEqual(agent.seen, [], "der Arm wurde trotz fehlender Rechte angesprochen");
  } finally {
    await hub.close();
    await agent.close();
  }
});

// ── 2. Die Herkunft: der Eintrag in GET_ROUTES_WITH_EFFECT ──────────────────

test("eine lesende Route ohne Browser-Kopfzeilen wird abgewiesen", async () => {
  // ⚠️ DER VERHALTENSFALL ZUM EINTRAG IN `GET_ROUTES_WITH_EFFECT`. Ohne ihn
  // greift `hasEffect` für diesen GET nicht, die Herkunftsprüfung lässt jede
  // Herkunft durch — und die Anfrage erreicht den Arm mit dem Namen des
  // angemeldeten Menschen im Kopf `x-docker-agent-actor`. Fällt dieser Fall
  // weg, ist genau das wieder möglich.
  const agent = await startAgent();
  withContainer(agent);
  const hub = await startHub({ agent, share: SHARE });
  try {
    for (const tail of ["files", "file?path=a.txt", "file-text?path=a.txt", "share-candidates"]) {
      const response = await call(url(hub, tail), { origin: false });
      assert.equal(response.status, 403, `${tail} ließ eine Anfrage ohne Herkunft durch`);
      assert.deepEqual(await response.json(), { error: "forbidden-origin" });
    }
    assert.deepEqual(agent.seen, [], "der Arm wurde trotz fremder Herkunft angesprochen");
  } finally {
    await hub.close();
    await agent.close();
  }
});

// ── 3. Die Kette vor dem Agenten ────────────────────────────────────────────

test("ein unbekannter Arm ist ein 404 und keine Anfrage", async () => {
  const hub = await startHub({ host: null });
  try {
    const response = await call(url(hub, "files"));
    assert.equal(response.status, 404);
    assert.equal((await response.json()).error, "host-unknown");
  } finally {
    await hub.close();
  }
});

test("ein Arm, der nicht antwortet, ist ein 503", async () => {
  const agent = await startAgent();
  withContainer(agent);
  const hub = await startHub({ agent, health: GONE, share: SHARE });
  try {
    const response = await call(url(hub, "files"));
    assert.equal(response.status, 503);
    assert.equal((await response.json()).error, "host-unreachable");
    assert.deepEqual(agent.seen, []);
  } finally {
    await hub.close();
    await agent.close();
  }
});

test("ein zu alter Agent sperrt das Schreiben, nicht das Lesen", async () => {
  // ⚠️ Die Schreibsperre (`domain/hosts/version.ts`) greift VOR dem Agentenaufruf und
  // gilt für die Routen mit WIRKUNG. Sie ist nicht dasselbe wie
  // `GET_ROUTES_WITH_EFFECT`: jene Liste beantwortet die Frage der Herkunft,
  // diese Sperre die Frage, ob der Hub gegen diese Fassung noch schreiben darf.
  // Ein Arm mit zu altem Agenten bleibt deshalb lesbar.
  const agent = await startAgent();
  withContainer(agent);
  agent.replies.set("GET /containers/c0ffee/files", {
    status: 200,
    body: { share: SHARE, path: "", entries: [], truncated: false, diagnostics: null }
  });
  const hub = await startHub({ agent, health: ANCIENT, share: SHARE });
  try {
    const blocked = await call(url(hub, "files"), { method: "POST", body: { action: "delete", path: "a.txt" } });
    assert.equal(blocked.status, 409);
    assert.equal((await blocked.json()).error, "agent-outdated");
    assert.deepEqual(agent.seen, [], "die Sperre griff erst nach dem Agentenaufruf");

    const reading = await call(url(hub, "files"));
    assert.equal(reading.status, 200, "die Schreibsperre hat auch das Lesen gesperrt");
  } finally {
    await hub.close();
    await agent.close();
  }
});

test("ein Container, den dieser Arm nicht führt, ist ein 404", async () => {
  const agent = await startAgent();
  withContainer(agent);
  const hub = await startHub({ agent, share: SHARE });
  try {
    const response = await call(url(hub, "files", "fremde-id"));
    assert.equal(response.status, 404);
    assert.equal((await response.json()).error, "container-unknown");
  } finally {
    await hub.close();
    await agent.close();
  }
});

test("ohne gewählte Freigabe antwortet der Hub selbst, ohne den Arm zu fragen", async () => {
  // Der Hub weiß es aus seiner eigenen Ablage. Ein Umweg über den Agenten
  // (dessen `no-share`) kostete eine Verbindung für dieselbe Auskunft und
  // reichte eine fremde Fehlerkennung in den Hub-Vertrag durch.
  const agent = await startAgent();
  withContainer(agent);
  const hub = await startHub({ agent, share: null });
  try {
    const response = await call(url(hub, "files"));
    assert.equal(response.status, 409);
    assert.equal((await response.json()).error, "share-unset");
    assert.deepEqual(
      agent.seen.map((entry) => entry.url),
      ["/containers"],
      "der Arm wurde nach der Freigabe gefragt, obwohl der Hub sie selbst kennt"
    );
  } finally {
    await hub.close();
    await agent.close();
  }
});

// ── 4. Die Wahl der Freigabe ────────────────────────────────────────────────

test("die gewählte Freigabe ist eine eigene Auskunft und „keine“ kein Fehler", async () => {
  // ⚠️ DER FALL ZU `GET …/share` (Etappe E5b). Bis dahin erfuhr die Oberfläche
  // die gewählte Freigabe nur aus dem SCHEITERN von `GET …/files` — einer
  // `409` mit `share-unset`. Der wichtigere der beiden Zweige ist deshalb der
  // LEERE: „für diesen Container hat noch niemand gewählt" ist der
  // Normalzustand und muss ein `200` mit `null` sein. Wer ihn als `404` oder
  // `409` baut, hat den Umweg über den Fehlercode nur umbenannt.
  const agent = await startAgent();
  withContainer(agent);
  const empty = await startHub({ agent, share: null });
  try {
    const response = await call(url(empty, "share"));
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { share: null });
    assert.deepEqual(empty.store.writes, [], "eine lesende Auskunft hat an der Ablage geschrieben");
  } finally {
    await empty.close();
  }

  const set = await startHub({ agent, share: SHARE });
  try {
    const response = await call(url(set, "share"));
    assert.equal(response.status, 200);
    // Der CONTAINERNAME und nicht die Id: die Ablage liegt je Name, und dieser
    // Name kommt aus der Container-Liste des Arms.
    assert.deepEqual(await response.json(), { share: { containerName: CONTAINER_NAME, path: SHARE } });
  } finally {
    await set.close();
    await agent.close();
  }
});

test("die gewählte Freigabe zu lesen verlangt Admin und einen erreichbaren Arm", async () => {
  // Zwei Zusagen in einem Fall, weil beide an derselben Route hängen:
  //
  //   1. `requireAdmin` als ERSTE Zwischenschicht — verrutscht sie, antwortet
  //      der Handler `200` mit der Freigabe statt `403`.
  //   2. Der Arm MUSS erreichbar sein, obwohl die Auskunft in der eigenen
  //      Datenbank steht. Das ist kein Versehen, sondern die Bauart der Ablage:
  //      `container_share` liegt je CONTAINERNAME, der Pfad trägt eine
  //      Container-ID, und die Zuordnung Id → Name gibt es nur beim Arm. Der
  //      Fall hält den Preis fest, damit ihn niemand für einen Fehler hält.
  const agent = await startAgent();
  withContainer(agent);
  const hub = await startHub({ agent, share: SHARE });
  try {
    const denied = await call(url(hub, "share"), { role: "user" });
    assert.equal(denied.status, 403);
    assert.deepEqual(await denied.json(), { error: "admin-required" });
  } finally {
    await hub.close();
    await agent.close();
  }

  const offline = await startHub({ health: GONE, share: SHARE });
  try {
    const response = await call(url(offline, "share"));
    assert.equal(response.status, 503, "ein unerreichbarer Arm gibt hier eine Auskunft, die er nicht geben kann");
    assert.equal((await response.json()).error, "host-unreachable");
  } finally {
    await offline.close();
  }
});

test("ein Pfad, den die Kandidatenliste nicht führt, wird nicht gespeichert", async () => {
  // ⚠️ DER VERHALTENSFALL ZUR KANDIDATENPRÜFUNG. Ohne sie wäre die Ablage der
  // Weg, dem Agenten über den Registry-Abgleich eine Freigabe unterzuschieben,
  // die der Betreiber nie gesehen hat.
  const agent = await startAgent();
  withContainer(agent);
  agent.replies.set("GET /containers/c0ffee/share-candidates", {
    status: 200,
    body: { candidates: [{ relative: SHARE, destination: "/usr/src/app/upload", writable: true }] }
  });
  const hub = await startHub({ agent });
  try {
    const refused = await call(url(hub, "share"), { method: "PUT", body: { path: "../../etc" } });
    assert.equal(refused.status, 409);
    assert.equal((await refused.json()).error, "share-unknown");
    assert.deepEqual(hub.store.writes, [], "ein unbekannter Pfad ging trotzdem in die Ablage");

    const accepted = await call(url(hub, "share"), { method: "PUT", body: { path: SHARE } });
    assert.equal(accepted.status, 200);
    assert.deepEqual(await accepted.json(), { share: { containerName: CONTAINER_NAME, path: SHARE } });
    assert.deepEqual(hub.store.writes, [`set:${CONTAINER_NAME}=${SHARE}`]);
  } finally {
    await hub.close();
    await agent.close();
  }
});

test("ein leerer Freigabepfad wird abgelehnt, ohne den Arm anzufassen", async () => {
  // Ein leerer Pfad sähe aus wie eine Angabe und bedeutete beim Agenten das
  // ganze Projektverzeichnis (`domain/containers/shares.ts`).
  const agent = await startAgent();
  withContainer(agent);
  const hub = await startHub({ agent });
  try {
    const response = await call(url(hub, "share"), { method: "PUT", body: { path: "" } });
    assert.equal(response.status, 400);
    assert.equal((await response.json()).error, "invalid-input");
    assert.deepEqual(agent.seen, []);
    assert.deepEqual(hub.store.writes, []);
  } finally {
    await hub.close();
    await agent.close();
  }
});

test("die Kandidatenliste geht mit dem Aufrufer der Sitzung hinaus", async () => {
  const agent = await startAgent();
  withContainer(agent);
  agent.replies.set("GET /containers/c0ffee/share-candidates", {
    status: 200,
    body: { candidates: [{ relative: SHARE, destination: "/data", writable: false }] }
  });
  const hub = await startHub({ agent });
  try {
    const response = await call(url(hub, "share-candidates"));
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), {
      candidates: [{ relative: SHARE, destination: "/data", writable: false }]
    });
    // ⚠️ Der Aufrufer ist im Audit-Log des Arms die einzige Spur, die auf einen
    // Menschen zeigt. Ein konstantes `system:hub` machte jeden Zugriff anonym.
    assert.deepEqual(
      agent.seen.map((entry) => entry.actor),
      ["user:admin-1", "user:admin-1"]
    );
    assert.deepEqual(
      agent.seen.map((entry) => entry.secret),
      [ROW_SECRET, ROW_SECRET]
    );
  } finally {
    await hub.close();
    await agent.close();
  }
});

// ── 5. Der Zugriff auf die Dateien ──────────────────────────────────────────

test("die Freigabe kommt aus der Ablage und reist als share zum Agenten", async () => {
  const agent = await startAgent();
  withContainer(agent);
  agent.replies.set("GET /containers/c0ffee/files", {
    status: 200,
    body: {
      share: SHARE,
      path: "fotos",
      entries: [{ name: "a.jpg", kind: "file", size: 12, changedAt: 1_757_240_000_000, uid: 99, gid: 100 }],
      truncated: true,
      diagnostics: { readable: true, deletable: false, uid: 99, gid: 100, uploadable: true }
    }
  });
  const hub = await startHub({ agent, share: SHARE });
  try {
    const response = await call(url(hub, "files?path=fotos"));
    assert.equal(response.status, 200);
    const answer = (await response.json()) as {
      listing: { truncated: boolean; entries: unknown[] };
      maxUploadBytes: number;
    };
    // `truncated` und die Diagnose gehen MIT hinaus: eine gekürzte Liste, die
    // vollständig aussieht, ist schlimmer als eine kurze.
    assert.equal(answer.listing.truncated, true);
    assert.equal(answer.listing.entries.length, 1);
    // ⚠️ DIE GRENZE REIST IM UMSCHLAG MIT (#136). Ohne sie prüft die Oberfläche
    // die Größe nicht vor dem Senden, und eine 500-MB-Datei geht vollständig
    // hinaus, bevor die `413` kommt. Verglichen wird gegen die Vertragsdatei
    // und nicht gegen eine hier hingeschriebene Zahl — eine zweite Zahl wäre
    // genau die zweite Wahrheit, gegen die der Vertrag steht.
    assert.equal(answer.maxUploadBytes, MAX_UPLOAD_BYTES);
    const asked = agent.seen.at(-1);
    assert.ok(asked, "der Arm wurde gar nicht gefragt");
    assert.ok(asked.url.includes(`share=${encodeURIComponent(SHARE)}`), `Abfrageteil ohne Freigabe: ${asked.url}`);
    assert.ok(asked.url.includes("path=fotos"));
  } finally {
    await hub.close();
    await agent.close();
  }
});

test("der Download wird durchgereicht, mit der Länge des Agenten", async () => {
  const agent = await startAgent();
  withContainer(agent);
  agent.replies.set("GET /containers/c0ffee/file", { status: 200, raw: "eine kleine Datei" });
  const hub = await startHub({ agent, share: SHARE });
  try {
    const response = await call(url(hub, "file?path=fotos/a.txt"));
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("content-type"), "application/octet-stream");
    assert.equal(response.headers.get("content-length"), String(Buffer.byteLength("eine kleine Datei")));
    // Der Name kommt aus dem Dateisystem eines fremden Hosts und darf in der
    // Kopfzeile keine eigene Anweisung beginnen.
    assert.equal(response.headers.get("content-disposition"), `attachment; filename="a.txt"; filename*=UTF-8''a.txt`);
    assert.equal(await response.text(), "eine kleine Datei");
  } finally {
    await hub.close();
    await agent.close();
  }
});

test("ein Download bricht beim Abbruch des Browsers unter vollem Puffer ab und gibt den Platz des Agenten frei", async () => {
  // The agent sends without end and does not cap this direction. The browser
  // reads one block and then stops: the output buffer of the hub fills, the
  // relay waits for `drain`, and the agent's connection backs up. Then the tab
  // closes — the hub has to let go of the agent's stream, or it keeps one of
  // the agent's slots (`MAX_OPEN_STREAMS`) for a file nobody receives.
  const agent = await startAgent();
  withContainer(agent);
  agent.replies.set("GET /containers/c0ffee/file", { status: 200, endless: true });
  const hub = await startHub({ agent, share: SHARE });
  try {
    const browser = new AbortController();
    const response = await call(url(hub, "file?path=large.bin"), { signal: browser.signal });
    assert.equal(response.status, 200);
    const reader = (response.body as ReadableStream<Uint8Array>).getReader();
    const first = await reader.read();
    assert.ok(first.value && first.value.length > 0);

    // Wait until the agent has stopped writing: the back-pressure has reached
    // it. A hub that collected or ignored `drain` would let it run on.
    let before = -1;
    for (let waited = 0; waited < 5_000 && agent.endless.blocks !== before; waited += 200) {
      before = agent.endless.blocks;
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
    assert.equal(agent.endless.blocks, before, "der Agent schreibt weiter, obwohl der Browser nichts nimmt");
    assert.ok(
      agent.endless.blocks * ENDLESS_BLOCK_BYTES < 64 * 1024 * 1024,
      `der Hub hat ${agent.endless.blocks} Blöcke vom Agenten genommen, ohne dass der Browser sie las`
    );
    assert.equal(agent.endless.closed, false, "der Agentenstrom ist schon vor dem Abbruch zu");

    browser.abort();
    await reader.cancel().catch(() => undefined);
    for (let waited = 0; waited < 3_000 && !agent.endless.closed; waited += 50) {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    assert.equal(agent.endless.closed, true, "der Hub hat den Agentenstrom nach dem Abbruch nicht freigegeben");
  } finally {
    await hub.close();
    await agent.close();
  }
});

test("benannte Antworten des Agenten behalten ihren Grund, an jeder Route der Fläche", async () => {
  const cases = [
    { agentStatus: 429, agentBody: undefined, status: 429, error: "too-many-streams", reason: undefined },
    { agentStatus: 503, agentBody: { error: "agent-read-only" }, status: 503, error: "agent-read-only", reason: "agent-read-only" },
    { agentStatus: 404, agentBody: { error: "not-allowlisted" }, status: 403, error: "agent-forbidden", reason: "not-allowlisted" },
    { agentStatus: 400, agentBody: { error: "path-traversal" }, status: 400, error: "agent-rejected", reason: "path-traversal" }
  ];
  const routes: { method: string; tail: string; agentPath: string; body?: unknown; text?: string }[] = [
    { method: "GET", tail: "files", agentPath: "GET /containers/c0ffee/files" },
    { method: "GET", tail: "file-text?path=a.txt", agentPath: "GET /containers/c0ffee/file-text" },
    { method: "GET", tail: "file?path=a.txt", agentPath: "GET /containers/c0ffee/file" },
    { method: "PUT", tail: "file-text?path=a.txt&expectedHash=h", agentPath: "PUT /containers/c0ffee/file-text", text: "x" },
    { method: "POST", tail: "files", agentPath: "POST /containers/c0ffee/files", body: { action: "delete", path: "a.txt" } },
    { method: "GET", tail: "share-candidates", agentPath: "GET /containers/c0ffee/share-candidates" }
  ];
  for (const route of routes) {
    for (const named of cases) {
      const agent = await startAgent();
      withContainer(agent);
      agent.replies.set(route.agentPath, { status: named.agentStatus, ...(named.agentBody ? { body: named.agentBody } : {}) });
      const hub = await startHub({ agent, share: SHARE });
      try {
        const response = await call(url(hub, route.tail), {
          method: route.method,
          ...(route.body ? { body: route.body } : {}),
          ...(route.text !== undefined ? { text: route.text } : {})
        });
        const label = `${route.method} ${route.tail} ← ${named.agentStatus}`;
        assert.equal(response.status, named.status, label);
        const answer = (await response.json()) as { error: string; reason?: string };
        assert.equal(answer.error, named.error, label);
        assert.equal(answer.reason, named.reason, label);
      } finally {
        await hub.close();
        await agent.close();
      }
    }
  }
});

test("ein Upload mit leerem Rumpf ist eine leere Datei und kein Fehler", async () => {
  const agent = await startAgent();
  withContainer(agent);
  agent.replies.set("PUT /containers/c0ffee/file", { status: 200, body: { name: "leer.bin", size: 0 } });
  const hub = await startHub({ agent, share: SHARE });
  try {
    const response = await call(url(hub, "file?path=fotos&name=leer.bin"), { method: "PUT", raw: "" });
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { uploaded: { ok: true, name: "leer.bin", size: 0 } });
    assert.ok(agent.seen.at(-1)?.url.includes("name=leer.bin"), "der Agent wurde nicht erreicht");
  } finally {
    await hub.close();
    await agent.close();
  }
});

test("ein leerer Text wird gespeichert, ein fehlender Hash nicht", async () => {
  const agent = await startAgent();
  withContainer(agent);
  agent.replies.set("PUT /containers/c0ffee/file-text", { status: 200, body: { hash: "sha256:leer" } });
  const hub = await startHub({ agent, share: SHARE });
  try {
    const response = await call(url(hub, "file-text?path=a.yml&expectedHash=sha256:damals"), { method: "PUT", text: "" });
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { hash: "sha256:leer" });
    const asked = JSON.parse(agent.seen.at(-1)?.body ?? "{}") as { content?: string; expectedHash?: string };
    assert.equal(asked.content, "", "der leere Text kam nicht als leerer Text an");
    assert.equal(asked.expectedHash, "sha256:damals");
  } finally {
    await hub.close();
    await agent.close();
  }
});

test("ein Download ohne Pfad ist ein Fehler des Aufrufers", async () => {
  const agent = await startAgent();
  withContainer(agent);
  const hub = await startHub({ agent, share: SHARE });
  try {
    const response = await call(url(hub, "file"));
    assert.equal(response.status, 400);
    assert.equal((await response.json()).error, "invalid-input");
  } finally {
    await hub.close();
    await agent.close();
  }
});

test("der Upload reicht die Bytes des Rumpfes weiter", async () => {
  const agent = await startAgent();
  withContainer(agent);
  agent.replies.set("PUT /containers/c0ffee/file", { status: 200, body: { name: "neu.bin", size: 5 } });
  const hub = await startHub({ agent, share: SHARE });
  try {
    const response = await call(url(hub, "file?path=fotos&name=neu.bin"), { method: "PUT", raw: "abcde" });
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { uploaded: { ok: true, name: "neu.bin", size: 5 } });
    const asked = agent.seen.at(-1);
    assert.ok(asked, "der Arm wurde gar nicht gefragt");
    assert.equal(asked.body, "abcde", "der Rumpf kam beim Agenten nicht als Bytes an");
    assert.ok(asked.url.includes("name=neu.bin"));
  } finally {
    await hub.close();
    await agent.close();
  }
});

test("ein Upload als JSON wird genannt und nicht als leere Datei gespeichert", async () => {
  // `express.json` hängt vor dem ganzen Router und hätte den Rumpf gelesen —
  // der Strom wäre leer, und aus dem Upload würde eine Datei mit null Bytes.
  const agent = await startAgent();
  withContainer(agent);
  const hub = await startHub({ agent, share: SHARE });
  try {
    for (const contentType of ["application/json", "Application/JSON"]) {
      const response = await call(url(hub, "file?path=fotos&name=neu.bin"), {
        method: "PUT",
        body: { content: "x" },
        contentType
      });
      assert.equal(response.status, 415, contentType);
      assert.equal((await response.json()).error, "invalid-content-type");
      assert.deepEqual(agent.seen, [], "der Upload darf den Agenten nicht erreichen");
    }
  } finally {
    await hub.close();
    await agent.close();
  }
});

test("der Texteditor bekommt beim Konflikt den JETZIGEN Hash", async () => {
  // ⚠️ DER HASH IST DIE EIGENTLICHE AUSKUNFT DIESES 409. Ohne ihn könnte der
  // Editor dem Betreiber nur „ging nicht" sagen und ihn seine Änderung neu
  // tippen lassen.
  const agent = await startAgent();
  withContainer(agent);
  agent.replies.set("PUT /containers/c0ffee/file-text", {
    status: 409,
    body: { error: "file-changed-externally", hash: "sha256:jetzt" }
  });
  const hub = await startHub({ agent, share: SHARE });
  try {
    const response = await call(url(hub, "file-text?path=a.yml&expectedHash=sha256:damals"), {
      method: "PUT",
      text: "eins: zwei"
    });
    assert.equal(response.status, 409);
    const answer = (await response.json()) as { error: string; hash: string; message: string; reason: string };
    assert.equal(answer.error, "file-changed");
    assert.equal(answer.hash, "sha256:jetzt");
    // Die Kennung ist englisch, der GRUND des Agenten reist im Text mit und
    // wörtlich als `reason`, wie bei jeder anderen Ablehnung.
    assert.ok(answer.message.includes("file-changed-externally"));
    assert.equal(answer.reason, "file-changed-externally");
  } finally {
    await hub.close();
    await agent.close();
  }
});

test("ein Speichern ohne expectedHash wird abgelehnt, ohne den Arm anzufassen", async () => {
  const agent = await startAgent();
  withContainer(agent);
  const hub = await startHub({ agent, share: SHARE });
  try {
    const response = await call(url(hub, "file-text?path=a.yml"), { method: "PUT", text: "x" });
    assert.equal(response.status, 400);
    assert.equal((await response.json()).error, "invalid-input");
    assert.deepEqual(agent.seen, []);
  } finally {
    await hub.close();
    await agent.close();
  }
});

test("der Texteditor nimmt den Text als rohen Rumpf und reicht ihn unverändert weiter", async () => {
  // ⚠️ ROHER RUMPF UND NICHT JSON, gemessen begründet: `express.json` deckelt
  // in `server/src/index.ts:184` bei 64 kB und hängt vor dem GANZEN
  // `/api`-Router; der Agent nimmt Text bis `MAX_TEXT_BYTES` (1 MiB). Als JSON
  // wäre der Editor für jede Datei dazwischen kaputt.
  const agent = await startAgent();
  withContainer(agent);
  agent.replies.set("PUT /containers/c0ffee/file-text", { status: 200, body: { hash: "sha256:neu" } });
  const hub = await startHub({ agent, share: SHARE });
  try {
    // Mehrbyte-Zeichen: der Weg Bytes → Text → JSON zum Agenten darf sie nicht
    // verändern.
    const text = "schlüssel: „wert“\nzweite Zeile: ß\n";
    const response = await call(url(hub, "file-text?path=a.yml&expectedHash=sha256:damals"), {
      method: "PUT",
      text
    });
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { hash: "sha256:neu" });
    const asked = agent.seen.at(-1);
    assert.ok(asked, "der Arm wurde gar nicht gefragt");
    assert.deepEqual(JSON.parse(asked.body), { content: text, expectedHash: "sha256:damals" });
  } finally {
    await hub.close();
    await agent.close();
  }
});

test("ein Speichern als JSON wird genannt und schreibt keine leere Datei", async () => {
  // Käme der Rumpf als JSON, hätte `express.json` ihn längst verbraucht — der
  // Strom wäre leer, und diese Route schriebe eine LEERE Datei über die des
  // Betreibers. Dieselbe Kennung wie beim Upload.
  const agent = await startAgent();
  withContainer(agent);
  const hub = await startHub({ agent, share: SHARE });
  try {
    for (const contentType of ["application/json", "Application/JSON"]) {
      const response = await call(url(hub, "file-text?path=a.yml&expectedHash=sha256:damals"), {
        method: "PUT",
        body: { content: "eins: zwei" },
        contentType
      });
      assert.equal(response.status, 415, contentType);
      assert.equal((await response.json()).error, "invalid-content-type");
      assert.deepEqual(agent.seen, [], "der Text darf den Agenten nicht erreichen");
    }
  } finally {
    await hub.close();
    await agent.close();
  }
});

test("eine ungültige UTF-8-Folge wird abgelehnt und nicht still ersetzt", async () => {
  // ⚠️ DER FALL, DER SONST NIEMANDEM AUFFÄLLT, BIS JEMAND SEINE DATEI VERLIERT.
  // `Buffer.toString("utf8")` ersetzt eine kaputte Bytefolge STILL durch
  // U+FFFD; ohne den Rückvergleich in der Route ginge genau dieser Ersatztext
  // an den Agenten, würde gespeichert, und die Quittung sagte „gespeichert".
  // Die Antwort wäre ein `200` — deshalb prüft dieser Fall den Status UND dass
  // der Arm gar nicht erst gefragt wurde.
  const agent = await startAgent();
  withContainer(agent);
  agent.replies.set("PUT /containers/c0ffee/file-text", { status: 200, body: { hash: "sha256:neu" } });
  const hub = await startHub({ agent, share: SHARE });
  try {
    // `0x80` ist ein Folgebyte ohne Startbyte davor — allein steht es in
    // keinem gültigen UTF-8.
    const broken = new Uint8Array([0x65, 0x69, 0x6e, 0x73, 0x80, 0x7a, 0x77, 0x65, 0x69]);
    const response = await call(url(hub, "file-text?path=a.yml&expectedHash=sha256:damals"), {
      method: "PUT",
      bytes: broken
    });
    assert.equal(response.status, 400);
    assert.equal((await response.json()).error, "invalid-encoding");
    assert.deepEqual(
      agent.seen.map((entry) => `${entry.method} ${entry.url.split("?")[0]}`),
      ["GET /containers"],
      "der Ersatztext ging trotzdem an den Arm"
    );
  } finally {
    await hub.close();
    await agent.close();
  }
});

test("ein Text über MAX_TEXT_BYTES wird vorgeprüft und geht nicht über den Tunnel", async () => {
  // ⚠️ Gedeckelt wird mit `MAX_TEXT_BYTES` (1 MiB) und NICHT mit
  // `MAX_UPLOAD_BYTES` (64 MiB). Die beiden sind verschiedene Grenzen der
  // Gegenseite: der Text geht durch `readTextFile` des Agenten, der Upload
  // durch den Daemon. Wer hier die größere einsetzt, lässt 64 MiB über den
  // Tunnel gehen, um sie am anderen Ende abzulehnen.
  const agent = await startAgent();
  withContainer(agent);
  agent.replies.set("PUT /containers/c0ffee/file-text", { status: 200, body: { hash: "sha256:neu" } });
  const hub = await startHub({ agent, share: SHARE });
  try {
    const response = await call(url(hub, "file-text?path=a.yml&expectedHash=sha256:damals"), {
      method: "PUT",
      text: "a".repeat(MAX_TEXT_BYTES + 1)
    });
    assert.equal(response.status, 413);
    assert.equal((await response.json()).error, "too-large");
    assert.deepEqual(
      agent.seen.map((entry) => `${entry.method} ${entry.url.split("?")[0]}`),
      ["GET /containers"],
      "der zu große Text ging trotzdem an den Arm"
    );
  } finally {
    await hub.close();
    await agent.close();
  }
});

test("ein Text knapp UNTER der Grenze geht durch", async () => {
  // Die Gegenprobe zum Fall darüber: ein Deckel, der auch das Erlaubte
  // abweist, wäre von einem richtigen nicht zu unterscheiden.
  const agent = await startAgent();
  withContainer(agent);
  agent.replies.set("PUT /containers/c0ffee/file-text", { status: 200, body: { hash: "sha256:neu" } });
  const hub = await startHub({ agent, share: SHARE });
  try {
    const response = await call(url(hub, "file-text?path=a.yml&expectedHash=sha256:damals"), {
      method: "PUT",
      text: "a".repeat(MAX_TEXT_BYTES)
    });
    assert.equal(response.status, 200);
  } finally {
    await hub.close();
    await agent.close();
  }
});

test("die eigenen Aktionsnamen werden auf die Werte des Agenten übersetzt", async () => {
  // ⚠️ The agent's values (`FILE_ACTIONS`) are mirrored, not taken as the
  // hub's: the agent compares them word for word, and this API names the
  // first action `create-directory` where the agent says `create-folder`.
  const agent = await startAgent();
  withContainer(agent);
  agent.replies.set("POST /containers/c0ffee/files", { status: 200, body: { name: "neu", kind: "directory" } });
  const hub = await startHub({ agent, share: SHARE });
  try {
    const response = await call(url(hub, "files"), {
      method: "POST",
      body: { action: "create-directory", path: "", name: "neu" }
    });
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { done: { name: "neu", kind: "directory" } });
    assert.deepEqual(JSON.parse(agent.seen.at(-1)?.body ?? "{}"), { action: "create-folder", path: "", name: "neu" });

    const unknown = await call(url(hub, "files"), { method: "POST", body: { action: "create-folder", path: "", name: "neu" } });
    assert.equal(unknown.status, 400, "ein Wert des Agenten wurde als eigener Aktionsname angenommen");
  } finally {
    await hub.close();
    await agent.close();
  }
});

// ── 6. Die Übersetzung der Agentenfehler ────────────────────────────────────

test("ein 403 des Agenten bleibt ein 403 und nennt die Stelle", async () => {
  const agent = await startAgent();
  withContainer(agent);
  agent.replies.set("GET /containers/c0ffee/files", { status: 403, body: { error: "self-management-locked" } });
  const hub = await startHub({ agent, share: SHARE });
  try {
    const response = await call(url(hub, "files"));
    assert.equal(response.status, 403);
    const answer = (await response.json()) as { error: string; message: string };
    // Die Kennung ist die englische des Hubs; die Meldung nennt die STELLE
    // statt einer geratenen Ursache.
    assert.equal(answer.error, "agent-forbidden");
    assert.ok(answer.message.length > 0);
  } finally {
    await hub.close();
    await agent.close();
  }
});

test("eine benannte Ablehnung des Agenten behält Status und Schlüssel (#122)", async () => {
  const agent = await startAgent();
  withContainer(agent);
  agent.replies.set("GET /containers/c0ffee/files", { status: 400, body: { error: "path-traversal" } });
  const hub = await startHub({ agent, share: SHARE });
  try {
    const response = await call(url(hub, "files"));
    assert.equal(response.status, 400);
    const answer = (await response.json()) as { error: string; reason: string };
    assert.equal(answer.error, "agent-rejected");
    assert.equal(answer.reason, "path-traversal");
  } finally {
    await hub.close();
    await agent.close();
  }
});

test("ein Agent, der nicht bedient werden kann, ist ein 502", async () => {
  const agent = await startAgent();
  withContainer(agent);
  agent.replies.set("GET /containers/c0ffee/files", { status: 401, body: { error: "unauthenticated" } });
  const hub = await startHub({ agent, share: SHARE });
  try {
    const response = await call(url(hub, "files"));
    assert.equal(response.status, 502);
    assert.equal((await response.json()).error, "agent-unreachable");
  } finally {
    await hub.close();
    await agent.close();
  }
});
