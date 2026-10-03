import test from "node:test";
import assert from "node:assert/strict";

import {
  call,
  CONTAINER_ID,
  execUrl,
  openShell,
  readAll,
  secondArm,
  shortUrl,
  startAgent,
  startHub
} from "./exec-test-support.js";

// DIE WÄCHTER DER SHELL-FLÄCHE, DIE SONST NIEMAND HÄLT (Paket B6, Etappe E3,
// #5).
//
// ⚠️ WARUM SIE IN EINER EIGENEN DATEI STEHEN. Die Fälle in
// `exec-routes.test.ts` und `exec-session-routes.test.ts` prüfen, was eine
// Route TUT. Diese hier prüfen, was über alle vier Routen HINWEG gelten muss —
// und was ein Fall je Route deshalb prinzipiell nicht sieht: dass der Aufrufer
// überall derselbe ist, dass eine Kennung nirgends hinausgeht, dass eine
// Sitzung nur ihrem Menschen und nur ihrem Arm gehört. Wer sie neben die
// Verhaltensfälle legte, prüfte sie an der Route, an der er gerade steht, und
// die fünfte bekäme sie nie.
//
// Alle Fälle hier laufen durch den VOLLEN Router (`createApiRouter`) — mit
// einem einzigen Register, so wie im Betrieb.

// ── 1. Der Aufrufer ist an allen vier Routen derselbe Mensch ───────────────

test("alle vier Routen tragen denselben user:<id> zum Arm, nie leer, nie system", async () => {
  // ⚠️ WARUM DAS EIN WÄCHTER IST UND KEIN DETAIL. Beim Agenten ist der
  // Aufrufer an diesen vier Routen keine Spur im Audit-Log, sondern eine
  // SCHRANKE: er vergleicht `session.actor !== actor` STRIKT gegen
  // `string | null` (`exec-protokoll.md` §3). Zwei Aufrufer mit `null` gälten
  // ihm damit als DERSELBE — ein leerer Aufrufer machte jede offene Shell für
  // jeden zugänglich, der eine Sitzungs-Id in die Hand bekommt.
  //
  // Heute hält das der Typ `ExecActor` und ein Fall auf Client-Ebene. Dieser
  // hier misst es über die FERTIGEN Routen: der Typ sagt nichts darüber, ob
  // eine Route ihn auch wirklich setzt.
  const agent = await startAgent();
  const hub = await startHub({ agent });
  try {
    const shell = await openShell(hub, agent);
    await call(shortUrl(hub, shell.session, "input"), { body: { data: "AA==" } });
    await call(shortUrl(hub, shell.session, "size"), { body: { cols: 100, rows: 30 } });
    await call(shortUrl(hub, shell.session, "close"));

    // Alle vier Wege des Agenten sind gegangen worden — sonst prüfte dieser
    // Fall drei davon und wäre trotzdem grün.
    const paths = agent.seen.map((entry) => entry.url).filter((url) => url.includes("exec"));
    assert.deepEqual(
      paths,
      [
        `/containers/${CONTAINER_ID}/exec`,
        `/exec/${shell.agentSession}/input`,
        `/exec/${shell.agentSession}/size`,
        `/exec/${shell.agentSession}/close`
      ],
      "nicht alle vier Aufrufe sind beim Arm angekommen"
    );

    // Und JEDER Aufruf dieses Laufs — auch die Container-Liste davor — trägt
    // denselben angemeldeten Menschen.
    const actors = [...new Set(agent.seen.map((entry) => entry.actor))];
    assert.deepEqual(actors, ["user:admin-1"], `abweichende Aufrufer: ${JSON.stringify(actors)}`);
    for (const actor of actors) {
      assert.ok(actor !== undefined && actor !== "", "ein Aufruf ging ohne Aufrufer hinaus");
      assert.ok(!String(actor).startsWith("system:"), "ein Aufruf ging als System hinaus");
    }
  } finally {
    await hub.close();
    await agent.close();
  }
});

// ── 2. Die Agent-Sitzungs-Id verlässt den Server nie ───────────────────────

test("die Agent-Sitzungs-Id steckt in nichts, was diese vier Routen hinausgeben", async () => {
  // ⚠️ GEGEN DAS SERIALISIERTE ERGEBNIS UND NICHT FELD FÜR FELD. Ein Vergleich
  // je Feld prüft die Felder, die man sich gerade denkt; er sähe die Id nicht,
  // wenn sie in einem verschachtelten Objekt, in einer Fehlermeldung oder in
  // einer Kopfzeile steht. Die Frage lautet aber „kommt diese Zeichenkette
  // irgendwo heraus?", und die beantwortet nur der ganze Text.
  //
  // Im Hub gibt es ZWEI Sitzungs-Ids. Die des Registers kennt der Browser; die
  // des Agenten ist der Schlüssel zu den drei kurzen Routen — wer sie hat,
  // tippt in die Shell. Was nach draußen geht, baut `clientViewOf`, und dort
  // steht sie nicht.
  const secret = "AGENT-SITZUNG-DIE-NIE-HINAUS-DARF";
  const agent = await startAgent();
  const hub = await startHub({ agent });
  try {
    const shell = await openShell(hub, agent, { agentSession: secret });

    // Alles einsammeln, was die vier Routen an den Browser geben: der Strom
    // samt seiner Kopfzeilen und die Rümpfe aller drei kurzen Routen — die
    // erfolgreichen wie die abgelehnten.
    const collected: string[] = [shell.raw];
    for (const target of [
      shortUrl(hub, shell.session, "input"),
      shortUrl(hub, shell.session, "size"),
      // Auch eine ABGELEHNTE Antwort: eine Fehlermeldung ist der Ort, an dem
      // eine Kennung am ehesten versehentlich mitgeht.
      shortUrl(hub, "eine-id-die-es-nicht-gibt", "input"),
      shortUrl(hub, shell.session, "close")
    ]) {
      const response = await call(target, { body: { data: "AA==", cols: 90, rows: 25 } });
      collected.push([...response.headers].map(([name, value]) => `${name}: ${value}`).join("\n"));
      collected.push(await response.text());
    }
    collected.push(await readAll(shell.reader));

    const everything = collected.join("\n");
    assert.ok(
      !everything.includes(secret),
      `die Agent-Sitzungs-Id steht in der Antwort des Hubs:\n${everything}`
    );
    // Der Wächter darf nicht dadurch grün werden, dass gar nichts gesammelt
    // wurde — und die Id des HUBS muss sehr wohl herauskommen.
    assert.ok(everything.includes(shell.session), "die Sitzungs-Id des Hubs fehlt in dem, was gesammelt wurde");
    // Und der Arm hat sie bekommen: sonst prüfte dieser Fall eine Id, die
    // nirgends im Spiel war.
    assert.ok(
      agent.seen.some((entry) => entry.url.includes(secret)),
      "der Arm wurde nie unter dieser Agent-Sitzungs-Id gerufen"
    );
  } finally {
    await hub.close();
    await agent.close();
  }
});

// ── 3. Eine Sitzung gehört EINEM Menschen ──────────────────────────────────

const SHORT_ROUTES = ["input", "size", "close"] as const;

test("eine Sitzung von Mensch A ist für Mensch B an allen drei kurzen Routen unbekannt", async () => {
  // ⚠️ AN ALLEN DREI und nicht nur an einer. `close` ist die gefährlichste:
  // sie quittiert aus Vorsatz auch dann `200`, wenn der Arm den Aufruf
  // ablehnt — verlöre sie dabei die Sitzungsprüfung, schlösse Mensch B die
  // Shell von Mensch A, sobald er eine Id in die Hand bekommt.
  const agent = await startAgent();
  const hub = await startHub({ agent });
  try {
    const shell = await openShell(hub, agent);
    for (const tail of SHORT_ROUTES) {
      const response = await call(shortUrl(hub, shell.session, tail), {
        // Ein ZWEITER Admin — es geht um die Person und nicht um die Rolle.
        role: "admin-2",
        body: { data: "AA==", cols: 80, rows: 24 }
      });
      assert.equal(response.status, 404, `${tail}: Status`);
      assert.equal(((await response.json()) as { error: string }).error, "session-unknown", `${tail}: Kennung`);
    }
    // Und die Sitzung lebt: der fremde Zugriff hat sie nicht nebenbei zerstört.
    const own = await call(shortUrl(hub, shell.session, "input"), { body: { data: "AA==" } });
    assert.equal(own.status, 200, "die eigene Sitzung überlebte den fremden Zugriff nicht");
    shell.controller.abort();
  } finally {
    await hub.close();
    await agent.close();
  }
});

// ── 4. Eine Sitzung gehört EINEM Arm ───────────────────────────────────────

test("eine Sitzung auf Arm A ist über Arm B unbekannt, auch wenn es Arm B wirklich gibt", async () => {
  // ⚠️ MIT EINEM ZWEITEN, ECHT GEFÜHRTEN ARM. Ein `host-2`, den der Bestand
  // gar nicht kennt, scheiterte schon an der Suche — der Fall wäre grün und
  // hätte den Abgleich nie erreicht. Hier führt der Bestand beide, beide
  // zeigen auf denselben Zuhörer, und das Einzige, was zwischen der Sitzung
  // und dem falschen Arm steht, ist der Vergleich im Register.
  //
  // Ohne ihn genügte eine Sitzung auf Arm A, um mit derselben Container-Id auf
  // Arm B zu tippen: dieselbe kurze Kennung kommt auf zwei Armen vor.
  const agent = await startAgent();
  const hub = await startHub({ agent, others: [secondArm(agent)] });
  try {
    // Der zweite Arm ist wirklich da — sonst prüfte dieser Fall die Suche.
    const reachable = await call(execUrl(hub, "host-2"), { body: {} });
    assert.equal(reachable.status, 200, "Arm B wird vom Bestand nicht geführt — der Fall zeigt dann nichts");
    await reachable.body?.cancel().catch(() => undefined);

    const shell = await openShell(hub, agent);
    for (const tail of SHORT_ROUTES) {
      const response = await call(shortUrl(hub, shell.session, tail, "host-2"), {
        body: { data: "AA==", cols: 80, rows: 24 }
      });
      assert.equal(response.status, 404, `${tail}: Status`);
      assert.equal(((await response.json()) as { error: string }).error, "session-unknown", `${tail}: Kennung`);
    }
    shell.controller.abort();
  } finally {
    await hub.close();
    await agent.close();
  }
});

test("eine Sitzung auf Container A ist über Container B unbekannt", async () => {
  // Dieselbe Frage eine Ebene tiefer: der Container steht im Pfad und wäre
  // ohne den Abgleich ein frei wählbarer Parameter neben einer gültigen
  // Sitzung.
  const agent = await startAgent();
  const hub = await startHub({ agent });
  try {
    const shell = await openShell(hub, agent);
    for (const tail of SHORT_ROUTES) {
      const response = await call(shortUrl(hub, shell.session, tail, "host-1", "ein-anderer-container"), {
        body: { data: "AA==", cols: 80, rows: 24 }
      });
      assert.equal(response.status, 404, `${tail}: Status`);
      assert.equal(((await response.json()) as { error: string }).error, "session-unknown", `${tail}: Kennung`);
    }
    shell.controller.abort();
  } finally {
    await hub.close();
    await agent.close();
  }
});

// ── 5. `requireAdmin` an allen vier Routen ─────────────────────────────────

test("ein Benutzer ohne Adminrechte bekommt an allen VIER Routen 403", async () => {
  // ⚠️ DER VERHALTENSFALL ZUR STELLUNG DER ZWISCHENSCHICHT, über alle vier
  // Routen in EINEM Zug. `web/tests/api-read-only.test.mjs` liest im Text,
  // dass `requireAdmin` unmittelbar hinter dem Pfad steht; er kann nicht
  // sagen, was passiert, wenn es woanders steht. Gemessen am 2026-09-07 in
  // B4a: eine `router.use`-Schranke eine Position nach unten verschoben, und
  // die volle Kette blieb grün. Verrutscht die Schicht hier, meldet dieser
  // Fall `200 !== 403` — bei `close` sogar an einer Route, die aus Vorsatz
  // alles quittiert.
  const agent = await startAgent();
  const hub = await startHub({ agent });
  try {
    const shell = await openShell(hub, agent);
    const targets = [
      execUrl(hub),
      ...SHORT_ROUTES.map((tail) => shortUrl(hub, shell.session, tail))
    ];
    assert.equal(targets.length, 4, "es sind nicht vier Routen — dieser Fall prüft dann die falsche Menge");

    for (const target of targets) {
      const response = await call(target, { role: "user", body: { data: "AA==", cols: 80, rows: 24 } });
      assert.equal(response.status, 403, `${target}: Status`);
      assert.equal(((await response.json()) as { error: string }).error, "admin-required", `${target}: Kennung`);
    }
    shell.controller.abort();
  } finally {
    await hub.close();
    await agent.close();
  }
});

// ── 6. Ein Register, nicht eins je Anfrage ─────────────────────────────────

test("eine Sitzung aus einer Anfrage ist in der nächsten Anfrage noch da", async () => {
  // ⚠️ DIE EINE FRAGE, DIE MAN AN DIESER FLÄCHE STILL FALSCH BEANTWORTEN KANN.
  // Das Register ist Zustand im Speicher und braucht GENAU EINE Instanz. Eine
  // je Anfrage — oder eine je Registrierfunktion, wenn die zweimal gerufen
  // wird — wäre ein Register, das nie etwas wiederfindet: die Stromroute trüge
  // ihre Sitzung ein, und die Eingabe-Route sähe ein leeres Register. Beide
  // Wege wären für sich genommen richtig, und kein Fall, der eine EINZELNE
  // Route prüft, sähe den Unterschied.
  //
  // Der Nachweis ist deshalb genau dieser: zwei getrennte HTTP-Anfragen an
  // denselben Serverprozess, die zweite findet, was die erste eingetragen hat.
  const agent = await startAgent();
  const hub = await startHub({ agent });
  try {
    const shell = await openShell(hub, agent);
    const first = await call(shortUrl(hub, shell.session, "input"), { body: { data: "AA==" } });
    assert.equal(first.status, 200, "die Eingabe fand die Sitzung des Stroms nicht");
    const second = await call(shortUrl(hub, shell.session, "size"), { body: { cols: 100, rows: 30 } });
    assert.equal(second.status, 200, "die zweite Folgeanfrage fand die Sitzung nicht mehr");
    shell.controller.abort();
  } finally {
    await hub.close();
    await agent.close();
  }
});
