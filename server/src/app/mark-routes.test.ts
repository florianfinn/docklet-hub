import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import type { AddressInfo } from "node:net";

import express from "express";
import type { Pool } from "pg";

import type { Auth } from "../platform/auth/auth.js";
import type { HostRecord, HostRepository } from "../domain/hosts/index.js";
import { DEFAULT_HOST_THEME, DEFAULT_MARK_THEME, DEFAULT_STACK_DISPLAY } from "contract";
import { createApiRouter } from "./router.js";
import { listenOnFetchablePort } from "../platform/testing/port-test-support.js";

// Die sechs Routen der eigenen Marken — über echte Anfragen durch den echten
// Router (D7b, #62). Muster: `theme-routes.test.ts`.
//
// ⚠️ WAS OHNE POSTGRES GEPRÜFT WERDEN KANN und hier geprüft wird:
//   - dass die Routen unter den vereinbarten Pfaden ANGEMELDET sind;
//   - die ANTWORTFORM samt Umschlag, gegen die die Etappen B und C parallel
//     gebaut werden;
//   - dass ein unbekannter Wert und ein unbekannter Schlüssel einen 400
//     ergeben und NICHT still zur Vorgabe werden;
//   - dass ein 400 NICHTS schreibt;
//   - dass jede der sechs Adminrechte verlangt;
//   - dass ein Compose-Projekt MIT SCHRÄGSTRICH im Namen die Route erreicht,
//     wenn der Aufrufer ihn kodiert.
//
// ⚠️ DER LETZTE PUNKT IST DER, DEN SONST NICHTS FÄNGT. Der Kommentar an der
// Route behauptet, dass Express den Pfad VOR dem Dekodieren zerlegt und ein
// `%2F` deshalb in einem Segment bleibt. Ein Kommentar hält nichts; dieser
// Fall führt es aus.
//
// ⚠️ DER UMSCHLAG WIRD AUSGEPACKT. D7a fand einen älteren Fehler dieser Art:
// `createHost` versprach `Promise<DockerHost>`, während die Route mit
// `{ host: … }` antwortete, und `request<T>` castet blind. Die Fälle unten
// prüfen deshalb gegen die TATSÄCHLICHE Form der Antwort und nicht gegen einen
// Typ.
//
// ⚠️ WAS OHNE POSTGRES UNGEPRÜFT BLEIBT und hier nicht behauptet wird: dass
// das SQL selbst richtig ist. Der erfundene Pool nimmt jede Anweisung an, die
// er wiedererkennt; ob die `WITH`-Anweisung in `features/marks/assignment-store.ts` auf einer
// echten Datenbank die richtigen Zeilen trifft, ob `ON CONFLICT` greift und ob
// die Fremdschlüsselschranken so heißen, wie der Übersetzer dort annimmt,
// zeigt erst ein Postgres.

type Listener = { port: number; close: () => Promise<void> };

async function listen(server: http.Server): Promise<Listener> {
  await listenOnFetchablePort(server);
  return {
    port: (server.address() as AddressInfo).port,
    close: async () => {
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
    }
  };
}

function record(id: string, name: string): HostRecord {
  return {
    id,
    name,
    agentUrl: "http://127.0.0.1:9/agent",
    kind: "internal",
    state: "pending",
    tunnelAddress: null,
    wireguardPublicKey: null,
    endpointOverride: null,
    failedAttempts: 0,
    dockerGid: null,
    bindBasePath: null,
    display: DEFAULT_HOST_THEME,
    createdAt: new Date("2026-01-01T00:00:00Z"),
    registeredAt: null,
    lastSeenAt: null
  };
}

type StoredMark = { id: string; name: string; hue: string; style: string };

/** Der Bestand, den der erfundene Pool führt — genau das, was diese Routen anfassen. */
type Memory = {
  marks: StoredMark[];
  /** Die Zuordnungen, als `<host>|<target>|<key>` auf eine Liste von Kennungen. */
  assignments: Map<string, string[]>;
  /** Die Einrückung, als `<host>|<project>` auf die Stufe. */
  indents: Map<string, string>;
  /** Das Ausblenden, als `<host>|<project>` auf den Wahrheitswert (015). */
  hidden: Map<string, boolean>;
};

/**
 * Ein erfundener Pool mit genau dem Gedächtnis dieser sieben Routen.
 *
 * ⚠️ Jede Anweisung, die er nicht wiedererkennt, ist hier ein Fehler und soll
 * einer bleiben. Ein Pool, der auf alles mit einer leeren Antwort reagiert,
 * machte einen Test grün, der die falsche Tabelle anspricht.
 *
 * ⚠️ Er bildet die `WITH`-Anweisung aus `features/marks/assignment-store.ts` NICHT nach — er
 * erkennt sie und führt ihre WIRKUNG aus. Das ist der Unterschied zwischen
 * „die Route ruft die Ablage richtig auf" (das steht hier zur Prüfung) und
 * „das SQL ist richtig" (das steht hier nicht zur Prüfung und kann es ohne
 * Postgres auch nicht).
 */
function fakePool(memory: Memory): Pool {
  const pool = {
    query(text: string, values: unknown[] = []) {
      if (/^\s*SELECT .* FROM hub_mark ORDER BY name/s.test(text)) {
        const sorted = [...memory.marks].sort((left, right) =>
          left.name.toLowerCase() < right.name.toLowerCase() ? -1 : 1
        );
        return Promise.resolve({ rows: sorted, rowCount: sorted.length });
      }
      if (/^\s*INSERT INTO hub_mark/s.test(text)) {
        const [id, name, hue, style] = values as string[];
        if (memory.marks.some((mark) => mark.name.toLowerCase() === name.toLowerCase())) {
          // Wörtlich das, was Postgres bei einem verletzten eindeutigen Index
          // meldet — sonst prüfte der Test den Übersetzer nicht, sondern eine
          // erfundene Fehlerform.
          throw Object.assign(new Error("duplicate key"), { code: "23505", constraint: "hub_mark_name_key" });
        }
        const mark = { id, name, hue, style };
        memory.marks.push(mark);
        return Promise.resolve({ rows: [mark], rowCount: 1 });
      }
      if (/^\s*UPDATE hub_mark/s.test(text)) {
        const [id, name, hue, style] = values as string[];
        const found = memory.marks.find((mark) => mark.id === id);
        if (!found) return Promise.resolve({ rows: [], rowCount: 0 });
        if (memory.marks.some((mark) => mark.id !== id && mark.name.toLowerCase() === name.toLowerCase())) {
          throw Object.assign(new Error("duplicate key"), { code: "23505", constraint: "hub_mark_name_key" });
        }
        Object.assign(found, { name, hue, style });
        return Promise.resolve({ rows: [found], rowCount: 1 });
      }
      if (/^\s*DELETE FROM hub_mark/s.test(text)) {
        const [id] = values as string[];
        const before = memory.marks.length;
        memory.marks = memory.marks.filter((mark) => mark.id !== id);
        return Promise.resolve({ rows: [], rowCount: before - memory.marks.length });
      }
      if (/mark_assignment/s.test(text)) {
        const [hostId, target, targetKey, markIds] = values as [string, string, string, string[]];
        const unknown = markIds.find((id) => !memory.marks.some((mark) => mark.id === id));
        if (unknown !== undefined) {
          throw Object.assign(new Error("foreign key"), {
            code: "23503",
            constraint: "mark_assignment_mark_id_fkey"
          });
        }
        memory.assignments.set(`${hostId}|${target}|${targetKey}`, [...markIds]);
        const rows = markIds.map((id) => memory.marks.find((mark) => mark.id === id) as StoredMark);
        return Promise.resolve({ rows, rowCount: rows.length });
      }
      // ⚠️ VOR der Einrückung: beide schreiben in `stack_display`, und das
      // Muster darunter träfe auch diese Anweisung.
      if (/^\s*INSERT INTO stack_display \(host_id, project, hidden\)/s.test(text)) {
        const [hostId, project, hidden] = values as [string, string, boolean];
        memory.hidden.set(`${hostId}|${project}`, hidden);
        return Promise.resolve({ rows: [{ hidden }], rowCount: 1 });
      }
      if (/^\s*INSERT INTO stack_display/s.test(text)) {
        const [hostId, project, indent] = values as string[];
        memory.indents.set(`${hostId}|${project}`, indent);
        return Promise.resolve({ rows: [{ project, indent }], rowCount: 1 });
      }
      throw new Error(`Unerwartete Abfrage in diesem Test: ${text}`);
    }
  };
  return pool as unknown as Pool;
}

function fakeAuth(role: "admin" | "user"): Auth {
  return {
    api: {
      getSession: () =>
        Promise.resolve({ user: { id: "admin-1", name: "admin", email: "admin@example.org", role } })
    }
  } as unknown as Auth;
}

type Running = { port: number; memory: Memory; close: () => Promise<void> };

async function start(role: "admin" | "user" = "admin"): Promise<Running> {
  const memory: Memory = { marks: [], assignments: new Map(), indents: new Map(), hidden: new Map() };
  const hosts = [record("host-1", "local-host")];

  const app = express();
  app.use(express.json({ limit: "64kb" }));
  app.use(
    "/api",
    createApiRouter({
      auth: fakeAuth(role),
      pool: fakePool(memory),
      repository: {
        list: () => Promise.resolve(hosts),
        find: (id: string) => Promise.resolve(hosts.find((entry) => entry.id === id) ?? null)
      } as unknown as HostRepository,
      enrollment: {} as never,
      agentSecret: "secret-der-umgebung",
      config: { wireguardEndpoint: "hub.test", wireguardPort: 51821 }
    })
  );
  const api = await listen(http.createServer(app));
  return { port: api.port, memory, close: api.close };
}

async function call(
  port: number,
  method: string,
  path: string,
  body?: unknown
): Promise<{ status: number; body: Record<string, unknown> | null }> {
  const response = await fetch(`http://127.0.0.1:${port}/api${path}`, {
    method,
    headers: {
      // Was der Browser der eigenen Oberfläche bei jeder Anfrage
      // mitschickt. Seit Etappe B1 (#5) hängt die Herkunftsprüfung als
      // erste Zwischenschicht in `createApiRouter`; ohne diese Kopfzeile
      // wäre jede schreibende Anfrage hier ein 403 — richtig so, aber
      // dieser Fall prüft etwas anderes.
      "sec-fetch-site": "same-origin",
      ...(body === undefined ? {} : { "content-type": "application/json" })
    },
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  // 204 trägt keinen Rumpf — `response.json()` wirft darauf.
  if (response.status === 204) return { status: 204, body: null };
  return { status: response.status, body: (await response.json()) as Record<string, unknown> };
}

/** Legt eine Marke an und meldet ihre Kennung. */
async function createMark(port: number, name: string, overrides: Record<string, string> = {}): Promise<string> {
  const { status, body } = await call(port, "POST", "/marks", {
    mark: { name, ...DEFAULT_MARK_THEME, ...overrides }
  });
  assert.equal(status, 201, `POST /marks für „${name}" ergab ${status}`);
  return (body?.mark as Record<string, unknown>).id as string;
}

test("GET /marks gibt den Bestand unter „marks“ heraus, nach Namen geordnet", async () => {
  const running = await start();
  try {
    const empty = await call(running.port, "GET", "/marks");
    assert.equal(empty.status, 200);
    assert.deepEqual(empty.body, { marks: [] });

    await createMark(running.port, "Zwischenlager");
    await createMark(running.port, "Archiv");

    const { status, body } = await call(running.port, "GET", "/marks");
    assert.equal(status, 200);
    const marks = body?.marks as Record<string, unknown>[];
    assert.deepEqual(
      marks.map((mark) => mark.name),
      ["Archiv", "Zwischenlager"]
    );
    // Die Aufzählung der Felder, nicht die Zeile: `created_at` gehört NICHT
    // in die Antwort.
    assert.deepEqual(Object.keys(marks[0]).sort(), ["hue", "id", "name", "style"]);
  } finally {
    await running.close();
  }
});

test("POST /marks antwortet mit 201 und der Marke unter „mark“", async () => {
  const running = await start();
  try {
    const { status, body } = await call(running.port, "POST", "/marks", {
      mark: { name: "  Produktion  ", hue: "teal", style: "fill" }
    });
    assert.equal(status, 201);
    const mark = body?.mark as Record<string, unknown>;
    assert.ok(mark, "die Antwort trägt kein Feld „mark“");
    assert.equal(mark.name, "Produktion", "der Name kommt gekürzt zurück");
    assert.equal(mark.hue, "teal");
    assert.equal(mark.style, "fill");
    assert.equal(typeof mark.id, "string");
    assert.notEqual(mark.id, "");
  } finally {
    await running.close();
  }
});

test("POST /marks lehnt eine unbekannte Stufe und einen leeren Namen ab und schreibt nichts", async () => {
  const running = await start();
  try {
    const unknownStep = await call(running.port, "POST", "/marks", {
      mark: { name: "Produktion", hue: "gold", style: "label" }
    });
    assert.equal(unknownStep.status, 400);
    assert.equal(unknownStep.body?.error, "invalid-input");

    const empty = await call(running.port, "POST", "/marks", {
      mark: { name: "   ", ...DEFAULT_MARK_THEME }
    });
    assert.equal(empty.status, 400);

    assert.deepEqual(running.memory.marks, [], "eine abgelehnte Marke ist trotzdem angelegt worden");
  } finally {
    await running.close();
  }
});

test("ein doppelter Name ist ein 409 und kein Datenbankfehler", async () => {
  const running = await start();
  try {
    await createMark(running.port, "Produktion");
    // ⚠️ Anderer Fall als „gleicher Name": der Index steht über `citext`, und
    // „produktion" ist derselbe Name.
    const { status, body } = await call(running.port, "POST", "/marks", {
      mark: { name: "produktion", ...DEFAULT_MARK_THEME }
    });
    assert.equal(status, 409);
    assert.equal(body?.error, "name-taken");
    assert.ok(String(body?.message).includes("produktion"));
    assert.equal(running.memory.marks.length, 1);
  } finally {
    await running.close();
  }
});

test("PUT /marks/:markId schreibt den vollen Satz und antwortet mit ihm", async () => {
  const running = await start();
  try {
    const id = await createMark(running.port, "Produktion");
    const { status, body } = await call(running.port, "PUT", `/marks/${id}`, {
      mark: { name: "Produktion", hue: "rose", style: "fill" }
    });
    assert.equal(status, 200);
    assert.deepEqual(body?.mark, { id, name: "Produktion", hue: "rose", style: "fill" });
  } finally {
    await running.close();
  }
});

test("PUT und DELETE auf eine Marke, die es nicht gibt, sind ein 404", async () => {
  const running = await start();
  try {
    const updated = await call(running.port, "PUT", "/marks/gibt-es-nicht", {
      mark: { name: "Produktion", ...DEFAULT_MARK_THEME }
    });
    assert.equal(updated.status, 404);
    assert.equal(updated.body?.error, "mark-unknown");

    const removed = await call(running.port, "DELETE", "/marks/gibt-es-nicht");
    assert.equal(removed.status, 404);
    assert.equal(removed.body?.error, "mark-unknown");
  } finally {
    await running.close();
  }
});

test("DELETE /marks/:markId antwortet mit 204 und danach mit 404", async () => {
  const running = await start();
  try {
    const id = await createMark(running.port, "Produktion");
    const firstAnswer = await call(running.port, "DELETE", `/marks/${id}`);
    assert.equal(firstAnswer.status, 204);
    assert.equal(firstAnswer.body, null, "ein 204 trägt keinen Rumpf");
    assert.deepEqual(running.memory.marks, []);

    // ⚠️ Nicht noch einmal 204: ein Editor, der auf eine getippte Kennung ein
    // 204 bekommt, hält sie für richtig.
    assert.equal((await call(running.port, "DELETE", `/marks/${id}`)).status, 404);
  } finally {
    await running.close();
  }
});

test("PUT /hosts/:hostId/stacks/:project/marks setzt die Marken in der geschickten Reihenfolge", async () => {
  const running = await start();
  try {
    const firstMark = await createMark(running.port, "Produktion", { hue: "teal" });
    const secondMark = await createMark(running.port, "Backup", { hue: "amber", style: "fill" });

    const { status, body } = await call(running.port, "PUT", "/hosts/host-1/stacks/nextcloud/marks", {
      markIds: [secondMark, firstMark]
    });
    assert.equal(status, 200);
    const marks = body?.marks as Record<string, unknown>[];
    // ⚠️ Die Reihenfolge des Feldes und NICHT die des Bestands: „Backup" steht
    // in der Liste der Marken vor „Produktion", hier aber nicht, weil der
    // Aufrufer es so geschickt hat.
    assert.deepEqual(
      marks.map((mark) => mark.id),
      [secondMark, firstMark]
    );
    // Name und Farbe reisen mit, damit die Oberfläche ihre Zeile ersetzen kann.
    assert.deepEqual(marks[0], { id: secondMark, name: "Backup", hue: "amber", style: "fill" });
    assert.deepEqual(running.memory.assignments.get("host-1|stack|nextcloud"), [secondMark, firstMark]);
  } finally {
    await running.close();
  }
});

test("die leere Liste zieht die Marken eines Ziels ab", async () => {
  const running = await start();
  try {
    const id = await createMark(running.port, "Produktion");
    await call(running.port, "PUT", "/hosts/host-1/stacks/nextcloud/marks", { markIds: [id] });

    const { status, body } = await call(running.port, "PUT", "/hosts/host-1/stacks/nextcloud/marks", {
      markIds: []
    });
    assert.equal(status, 200);
    assert.deepEqual(body, { marks: [] });
    assert.deepEqual(running.memory.assignments.get("host-1|stack|nextcloud"), []);
  } finally {
    await running.close();
  }
});

test("PUT /hosts/:hostId/containers/:name/marks trifft ein ANDERES Ziel als der gleichnamige Stack", async () => {
  // ⚠️ Der Fall, für den `target` in der Tabelle steht: ein Stack „nextcloud"
  // und ein loser Container „nextcloud" sind zwei Ziele. Ohne die Spalte
  // überschriebe das eine das andere.
  const running = await start();
  try {
    const firstMark = await createMark(running.port, "Produktion");
    const secondMark = await createMark(running.port, "Backup");

    await call(running.port, "PUT", "/hosts/host-1/stacks/nextcloud/marks", { markIds: [firstMark] });
    const { status, body } = await call(running.port, "PUT", "/hosts/host-1/containers/nextcloud/marks", {
      markIds: [secondMark]
    });
    assert.equal(status, 200);
    assert.deepEqual((body?.marks as Record<string, unknown>[]).map((mark) => mark.id), [secondMark]);

    assert.deepEqual(running.memory.assignments.get("host-1|stack|nextcloud"), [firstMark]);
    assert.deepEqual(running.memory.assignments.get("host-1|container|nextcloud"), [secondMark]);
  } finally {
    await running.close();
  }
});

test("eine Marke, die es nicht gibt, ist ein 404 und keine 500", async () => {
  const running = await start();
  try {
    const { status, body } = await call(running.port, "PUT", "/hosts/host-1/stacks/nextcloud/marks", {
      markIds: ["gibt-es-nicht"]
    });
    assert.equal(status, 404);
    assert.equal(body?.error, "mark-unknown");
  } finally {
    await running.close();
  }
});

test("eine Dublette und zu viele Marken sind ein 400 und schreiben nichts", async () => {
  const running = await start();
  try {
    const id = await createMark(running.port, "Produktion");
    const duplicate = await call(running.port, "PUT", "/hosts/host-1/stacks/nextcloud/marks", {
      markIds: [id, id]
    });
    assert.equal(duplicate.status, 400);
    assert.equal(duplicate.body?.error, "invalid-input");

    const tooMany = await call(running.port, "PUT", "/hosts/host-1/stacks/nextcloud/marks", {
      markIds: Array.from({ length: 9 }, (_value, index) => `m-${index}`)
    });
    assert.equal(tooMany.status, 400);

    assert.equal(running.memory.assignments.size, 0, "eine abgelehnte Liste ist trotzdem geschrieben worden");
  } finally {
    await running.close();
  }
});

test("PUT /hosts/:hostId/stacks/:project/display antwortet mit der Einrückung unter „display“", async () => {
  const running = await start();
  try {
    const { status, body } = await call(running.port, "PUT", "/hosts/host-1/stacks/nextcloud/display", {
      display: { indent: "flat" }
    });
    assert.equal(status, 200);
    assert.deepEqual(body, { display: { indent: "flat" } });
    assert.equal(running.memory.indents.get("host-1|nextcloud"), "flat");
  } finally {
    await running.close();
  }
});

test("eine Einrückung, die es nicht gibt, ist ein 400 und schreibt nichts", async () => {
  const running = await start();
  try {
    const { status, body } = await call(running.port, "PUT", "/hosts/host-1/stacks/nextcloud/display", {
      display: { indent: "deep" }
    });
    assert.equal(status, 400);
    assert.equal(body?.error, "invalid-input");
    assert.equal(running.memory.indents.size, 0);
    // Und die Vorgabe steht weiterhin auf „nested".
    assert.equal(DEFAULT_STACK_DISPLAY.indent, "nested");
  } finally {
    await running.close();
  }
});

test("PUT /hosts/:hostId/stacks/:project/hidden blendet aus und wieder ein", async () => {
  const running = await start();
  try {
    const off = await call(running.port, "PUT", "/hosts/host-1/stacks/nextcloud/hidden", { hidden: true });
    assert.equal(off.status, 200);
    assert.deepEqual(off.body, { hidden: true });
    assert.equal(running.memory.hidden.get("host-1|nextcloud"), true);
    // Die Einrückung desselben Stacks bleibt unberührt.
    assert.equal(running.memory.indents.size, 0);

    const on = await call(running.port, "PUT", "/hosts/host-1/stacks/nextcloud/hidden", { hidden: false });
    assert.equal(on.status, 200);
    assert.deepEqual(on.body, { hidden: false });
    assert.equal(running.memory.hidden.get("host-1|nextcloud"), false);
  } finally {
    await running.close();
  }
});

test("ein Ausblenden ohne echten Wahrheitswert ist ein 400 und schreibt nichts", async () => {
  const running = await start();
  try {
    for (const sent of [{ hidden: "false" }, { hidden: 1 }, {}]) {
      const { status, body } = await call(running.port, "PUT", "/hosts/host-1/stacks/nextcloud/hidden", sent);
      assert.equal(status, 400, `${JSON.stringify(sent)} wurde angenommen`);
      assert.equal(body?.error, "invalid-input");
    }
    assert.equal(running.memory.hidden.size, 0);
  } finally {
    await running.close();
  }
});

test("ein Projektname mit Schrägstrich erreicht die Route, wenn er kodiert ist", async () => {
  // ⚠️ DIE PRÜFUNG DER BEHAUPTUNG AN DER ROUTE. Docker und Compose vergeben
  // keinen Schrägstrich (moby `RestrictedNamePattern`, compose-go
  // `NormalizeProjectName`), aber der Hub liest das Projekt aus einem LABEL,
  // und ein Label kann von Hand gesetzt werden. Der Kommentar an der Route
  // sagt, dass Express den Pfad VOR dem Dekodieren zerlegt und ein `%2F`
  // deshalb in EINEM Segment bleibt — hier steht es als Verhalten.
  const running = await start();
  try {
    const project = "team/nextcloud";
    const { status, body } = await call(
      running.port,
      "PUT",
      `/hosts/host-1/stacks/${encodeURIComponent(project)}/display`,
      { display: { indent: "flat" } }
    );
    assert.equal(status, 200, "der Pfad mit %2F hat die Route nicht erreicht");
    assert.deepEqual(body, { display: { indent: "flat" } });
    // Der Schlüssel in der Ablage ist der DEKODIERTE Name und nicht „%2F".
    assert.equal(running.memory.indents.get(`host-1|${project}`), "flat");
  } finally {
    await running.close();
  }
});

test("die sechs Routen der Marken verlangen Adminrechte, das Lesen nicht", async () => {
  // `web/tests/api-read-only.test.mjs` hält das am TEXT des Routers fest; hier
  // steht dieselbe Zusage als Verhalten. Ein Wächter, der nur den Text liest,
  // sagt nichts darüber, ob die Zwischenschicht wirkt.
  const running = await start("user");
  try {
    const writes: [string, string, unknown][] = [
      ["POST", "/marks", { mark: { name: "Produktion", ...DEFAULT_MARK_THEME } }],
      ["PUT", "/marks/m-1", { mark: { name: "Produktion", ...DEFAULT_MARK_THEME } }],
      ["DELETE", "/marks/m-1", undefined],
      ["PUT", "/hosts/host-1/stacks/nextcloud/marks", { markIds: [] }],
      ["PUT", "/hosts/host-1/stacks/nextcloud/display", { display: { indent: "flat" } }],
      ["PUT", "/hosts/host-1/containers/db/marks", { markIds: [] }]
    ];
    for (const [method, path, body] of writes) {
      const { status } = await call(running.port, method, path, body);
      assert.equal(status, 403, `${method} ${path} war für einen Benutzer ohne Adminrechte offen`);
    }

    // Und nichts davon ist angekommen.
    assert.deepEqual(running.memory.marks, []);
    assert.equal(running.memory.assignments.size, 0);
    assert.equal(running.memory.indents.size, 0);

    // Lesen darf er: nach #17 schreibt ein Administrator, lesen alle.
    assert.equal((await call(running.port, "GET", "/marks")).status, 200);
  } finally {
    await running.close();
  }
});

test("ein Rumpf ohne den Umschlag ist überall ein 400", async () => {
  const running = await start();
  try {
    const withoutMarkEnvelope = await call(running.port, "POST", "/marks", { name: "Produktion", ...DEFAULT_MARK_THEME });
    assert.equal(withoutMarkEnvelope.status, 400);

    const withoutDisplayEnvelope = await call(running.port, "PUT", "/hosts/host-1/stacks/nextcloud/display", {
      indent: "flat"
    });
    assert.equal(withoutDisplayEnvelope.status, 400);

    const withoutMarkIds = await call(running.port, "PUT", "/hosts/host-1/stacks/nextcloud/marks", { ids: [] });
    assert.equal(withoutMarkIds.status, 400);

    assert.deepEqual(running.memory.marks, []);
    assert.equal(running.memory.indents.size, 0);
    assert.equal(running.memory.assignments.size, 0);
  } finally {
    await running.close();
  }
});
