import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { NOTIFICATION_CHANNELS, NOTIFICATION_LIMITS, notificationDeliveryViewSchema, notificationDeliveriesResponseSchema,
  DEFAULT_NOTIFICATION_FORMAT, type NotificationTicketView, type NotificationChannel } from "contract";
import { initialConfig } from "./config.js";
import { createNotificationDeliveries, NOTIFICATION_DELIVERY_LEASE_MS } from "./deliveries.js";
import { createNotificationTickets, notificationBindingDigest } from "./tickets.js";
import type { NotificationDeliveryRow, NotificationDeliverySnapshot } from "./delivery-types.js";
import { targetKey, type NotificationDatabase, type NotificationQuery, type StoredScope, type TicketObservation } from "./types.js";

type Intent = { ticket_id: string; phase: "initial" | "recovery"; channel: NotificationChannel;
  configuration_revision: string; snapshot: NotificationDeliverySnapshot; admitted_at: string | null };
type History = { sequence: number; delivery_id: string; ticket_id: string | null; generation: number;
  state: string; attempts: number; failure: unknown; finished_at: string };
const instant = "2026-01-02T00:00:00.000Z";
const ticket: NotificationTicketView = { id: "ticket-a", episodeKey: "episode-a", event: "connection-lost",
  target: { kind: "host", hostId: "host-a" }, targetLabel: "Synthetischer Host", cause: "Verbindung unterbrochen",
  action: "check-connection", state: "open", openedAt: instant, acknowledgedAt: null, resolvedAt: null,
  affectedContainers: [], affectedContainerCount: 0, pendingDeliveryCount: 0,
  evidence: { logs: { state: "unavailable", reason: "not-collected" } } };
function harness() {
  let rows = new Map<string, NotificationDeliveryRow>();
  let intents = new Map<string, Intent>();
  let history: History[] = [];
  let tickets = new Map<string, { document: NotificationTicketView; observed_at: string; source: string; target_key: string }>();
  let time = new Date(instant);
  let fail: "insert" | "admit" | "commit" | null = null;
  let registered = true;
  let targetExists = true;
  let stack: Parameters<typeof targetKey>[0] | null = null;
  let tickInReader = 0;
  const config = initialConfig();
  config.channels.forEach((channel) => {
    channel.endpoint = "https://example.invalid/notifications";
    if (channel.kind === "gotify") channel.token = "synthetic-token";
    if (channel.kind === "webhook") channel.authorization = "synthetic-authorization";
    if (channel.kind === "smtp") channel.connection = { host: "example.invalid", port: 465, security: "tls",
      username: null, password: null, from: "hub@example.invalid", to: ["receiver@example.invalid"] };
  });
  config.hostRules = NOTIFICATION_CHANNELS.map((channel) => ({ channel, events: ["connection-lost"], overrides: {} }));
  const scopes = new Map<string, { configuration: StoredScope; active: boolean }>();
  const statements: string[] = [];
  const matches = (row: NotificationDeliveryRow, state: string) => row.state === state;
  const query = async (sql: string, values: unknown[] = []) => {
    statements.push(sql);
    const result = (selected: unknown[] = [], count = selected.length) => ({ rows: structuredClone(selected), rowCount: count });
    if (sql.startsWith("INSERT INTO notification_config")) return result();
    if (sql.startsWith("SELECT revision")) return result([{ document: config, revision: String(config.revision) }]);
    if (sql.startsWith("SELECT configuration, active")) return result(scopes.has(String(values[0])) ? [scopes.get(String(values[0]))] : []);
    if (sql.startsWith("SELECT * FROM notification_delivery_intention")) return result([...intents.values()]
      .filter((row) => !row.admitted_at).sort((a,b) => a.ticket_id.localeCompare(b.ticket_id) || a.phase.localeCompare(b.phase) || a.channel.localeCompare(b.channel))
      .slice(0, Number(values[0])));
    if (sql.startsWith("UPDATE notification_delivery_intention")) {
      if (fail === "admit") throw new Error("synthetic-admission-failure");
      const row = intents.get(values.slice(0,3).join("|"));
      if (row && !row.admitted_at) row.admitted_at = String(values[3]);
      return result([], row ? 1 : 0);
    }
    if (sql.startsWith("INSERT INTO notification_delivery_intention")) {
      const key = values.slice(0,3).join("|");
      if (!intents.has(key)) intents.set(key, { ticket_id: String(values[0]), phase: values[1] as Intent["phase"],
        channel: values[2] as NotificationChannel, configuration_revision: String(values[3]), snapshot: JSON.parse(String(values[4])), admitted_at: null });
      return result([], 1);
    }
    if (sql.startsWith("SELECT count(*)::text AS count FROM notification_delivery WHERE")) return result([
      { count: String([...rows.values()].filter((row) => ["queued", "sending", "retrying"].includes(row.state)).length) }]);
    if (sql.startsWith("SELECT id FROM notification_delivery WHERE ticket_id")) return result([...rows.values()]
      .filter((row) => row.ticket_id === values[0] && row.phase === values[1] && row.channel === values[2]).map(({ id }) => ({ id })));
    if (sql.startsWith("INSERT INTO notification_delivery\n")) {
      if (fail === "insert") throw new Error("synthetic-insert-failure");
      if (values[1] && [...rows.values()].some((row) => row.ticket_id === values[1] && row.phase === values[2] && row.channel === values[3])) return result();
      const row: NotificationDeliveryRow = { id: String(values[0]), ticket_id: values[1] as string | null,
        phase: values[2] as NotificationDeliveryRow["phase"], channel: values[3] as NotificationChannel, generation: Number(values[4]),
        state: values[5] as NotificationDeliveryRow["state"], attempts: Number(values[6]), created_at: String(values[7]),
        updated_at: String(values[8]), next_attempt_at: values[9] as string | null, finished_at: values[10] as string | null,
        failure: values[11] as NotificationDeliveryRow["failure"], include_logs: Boolean(values[12]),
        private_snapshot: JSON.parse(String(values[13])), claim_token: null, lease_deadline: null, cancellation_reason: null };
      rows.set(row.id, row); return result([row]);
    }
    if (sql.startsWith("SELECT * FROM notification_delivery WHERE id")) return result(rows.has(String(values[0])) ? [rows.get(String(values[0]))] : []);
    if (sql.startsWith("SELECT * FROM notification_delivery WHERE state")) {
      const expired = sql.includes("lease_deadline <=");
      return result([...rows.values()].filter((row) => expired ? matches(row, "sending") && String(row.lease_deadline) <= String(values[0]) :
        ["queued", "retrying"].includes(row.state) && String(row.next_attempt_at) <= String(values[0]))
        .sort((a,b) => String(expired ? a.lease_deadline : a.next_attempt_at).localeCompare(String(expired ? b.lease_deadline : b.next_attempt_at)) || a.id.localeCompare(b.id))
        .slice(0, Number(values[1])));
    }
    if (sql.startsWith("UPDATE notification_delivery SET")) {
      const old = rows.get(String(values[0]));
      if (!old || old.generation !== values[13] || old.state !== values[14] || old.claim_token !== values[15]) return result();
      const row = { ...old, generation: Number(values[1]), state: values[2] as NotificationDeliveryRow["state"], attempts: Number(values[3]),
        updated_at: String(values[4]), next_attempt_at: values[5] as string | null, finished_at: values[6] as string | null,
        failure: values[7] as NotificationDeliveryRow["failure"], include_logs: Boolean(values[8]), private_snapshot: JSON.parse(String(values[9])),
        claim_token: values[10] as string | null, lease_deadline: values[11] as string | null,
        cancellation_reason: values[12] as NotificationDeliveryRow["cancellation_reason"] };
      rows.set(row.id, row); return result([row]);
    }
    if (sql.startsWith("INSERT INTO notification_delivery_history")) {
      if (!history.some((entry) => entry.delivery_id === values[0] && entry.generation === values[2])) history.push({
        sequence: (history.at(-1)?.sequence ?? 0) + 1, delivery_id: String(values[0]), ticket_id: values[1] as string | null,
        generation: Number(values[2]), state: String(values[3]), attempts: Number(values[4]), failure: values[5], finished_at: String(values[6]) });
      return result([], 1);
    }
    if (sql.startsWith("DELETE FROM notification_delivery_history")) {
      const selected = history.filter((entry) => values[0] ? entry.ticket_id === values[0] : entry.delivery_id === values[1]);
      const remove = new Set(selected.sort((a,b) => b.sequence-a.sequence).slice(Number(values[2])).map((entry) => entry.sequence));
      history = history.filter((entry) => !remove.has(entry.sequence)); return result([], remove.size);
    }
    if (sql.startsWith("DELETE FROM notification_delivery WHERE id IN")) {
      const terminal = [...rows.values()].filter((row) => ["delivered", "failed", "cancelled"].includes(row.state))
        .sort((a,b) => String(b.finished_at).localeCompare(String(a.finished_at)) || b.id.localeCompare(a.id));
      const remove = terminal.filter((row,index) => String(row.finished_at) < String(values[0]) || index >= Number(values[1]));
      remove.forEach((row) => rows.delete(row.id)); history = history.filter((entry) => rows.has(entry.delivery_id));
      return result([], remove.length);
    }
    if (sql.includes("ORDER BY created_at DESC")) return result([...rows.values()].filter((row) =>
      (!values[0] || row.ticket_id === values[0]) && (!values[1] || row.state === values[1]) && (!values[2] || row.channel === values[2]) &&
      (!values[3] || String(row.created_at) < String(values[3]) || row.created_at === values[3] && row.id < String(values[4])))
      .sort((a,b) => String(b.created_at).localeCompare(String(a.created_at)) || b.id.localeCompare(a.id)).slice(0, Number(values[5])));
    if (sql.startsWith("SELECT document, observed_at FROM notification_ticket WHERE id")) return result(tickets.has(String(values[0])) ? [tickets.get(String(values[0]))] : []);
    if (sql.includes("WHERE source = $1")) return result([...tickets.values()].filter((row) => row.source === values[0] && row.target_key === values[1] && row.document.episodeKey === values[2]));
    if (sql.includes("INSERT INTO notification_ticket")) {
      tickets.set(String(values[0]), { document: JSON.parse(String(values[11])), observed_at: String(values[10]), source: String(values[1]), target_key: String(values[2]) });
      return result([], 1);
    }
    if (sql.startsWith("UPDATE notification_ticket")) {
      const row = tickets.get(String(values[0]))!; row.document = JSON.parse(String(values[2]));
      if (sql.includes("observed_at = $2")) row.observed_at = String(values[1]); return result([], 1);
    }
    if (sql.includes("SELECT count(*)::text AS count FROM notification_delivery_intention")) return result([
      { count: String([...intents.values()].filter((row) => row.ticket_id === values[0] && !row.admitted_at).length) }]);
    throw new Error(`unsupported-statement: ${sql}`);
  };
  let tail = Promise.resolve();
  const database = { query, transaction: <T>(operation: (query: NotificationQuery) => Promise<T>) => {
    const result = tail.then(async () => {
      const saved = structuredClone({ rows, intents, history, tickets });
      try { const answer = await operation({ query } as NotificationQuery); if (fail === "commit") throw new Error("synthetic-commit-failure"); return answer; }
      catch (error) { ({ rows, intents, history, tickets } = saved); throw error; }
    });
    tail = result.then(() => undefined, () => undefined); return result;
  } } as NotificationDatabase;
  const dependencies = { now: () => time, cursorSecret: "synthetic-persistent-cursor-secret-at-least-32",
    hostExists: async () => registered, targetReader: async () => {
      if (tickInReader) time = new Date(time.getTime() + tickInReader);
      return { exists: targetExists, stack: stack?.kind === "host" ? null : stack };
    } };
  const snapshot = (channel: NotificationChannel = "webhook"): NotificationDeliverySnapshot => ({ ticket: structuredClone(ticket),
    format: DEFAULT_NOTIFICATION_FORMAT, options: { includeLogs: false, recovery: false, additionalText: "" }, destinationScopeKey: null,
    bindingDigest: notificationBindingDigest({ channel: config.channels.find((item) => item.kind === channel), destination: null }) });
  const intention = (id = "ticket-a", channel: NotificationChannel = "webhook", phase: Intent["phase"] = "initial") => {
    const item: Intent = { ticket_id: id, phase, channel, configuration_revision: "0", snapshot: snapshot(channel), admitted_at: null };
    item.snapshot.ticket.id = id;
    intents.set([id,phase,channel].join("|"), item); return item;
  };
  const service = createNotificationDeliveries(database, dependencies);
  return { database, dependencies, service, config, scopes, statements, intention, snapshot,
    rows: () => rows, intents: () => intents, history: () => history, now: () => time,
    advance: (ms: number) => { time = new Date(time.getTime() + ms); }, fail: (mode: typeof fail) => { fail = mode; },
    registered: (value: boolean) => { registered = value; }, targetExists: (value: boolean) => { targetExists = value; },
    stack: (value: typeof stack) => { stack = value; }, tickInReader: (ms: number) => { tickInReader = ms; } };
}
async function admitted(h: ReturnType<typeof harness>) {
  h.intention(); await h.service.admitPending(); return [...h.rows().values()][0].id;
}
async function terminalFailure(h: ReturnType<typeof harness>, id: string) {
  const claim = (await h.service.claim())[0]; assert.equal(claim.id,id);
  return (await h.service.finish(claim, { status: "failed", failure: "authentication" }))!;
}

test("atomic bounded admission survives rollback, restart and repeated observations", { timeout: 2000 }, async () => {
  for (const mode of ["insert", "admit", "commit"] as const) {
    const h = harness(); h.intention(); h.fail(mode);
    await assert.rejects(h.service.admitPending(), /synthetic-/);
    assert.equal(h.rows().size, 0); assert.equal([...h.intents().values()][0].admitted_at, null);
    h.fail(null); assert.equal((await h.service.admitPending()).admitted, 1);
  }
  const h = harness();
  for (const channel of NOTIFICATION_CHANNELS) h.intention("ticket-a", channel);
  const results = await Promise.all([h.service.admitPending(), h.service.admitPending()]);
  assert.equal(results.reduce((sum,r) => sum+r.admitted,0),4); assert.equal(h.rows().size,4);
  const restart = createNotificationDeliveries(h.database,h.dependencies);
  assert.equal((await restart.admitPending()).admitted,0);
  const sequence = h.statements.findIndex((sql) => sql.includes("SELECT revision") && sql.includes("FOR UPDATE"));
  assert.ok(sequence >= 0 && sequence < h.statements.findIndex((sql) => sql.startsWith("SELECT * FROM notification_delivery_intention")));
  assert.ok(h.statements.some((sql) => sql.includes("LIMIT $1 FOR UPDATE SKIP LOCKED")));
  // Existing durable queue rows reconcile an unmarked intention without another insert.
  [...h.intents().values()][0].admitted_at = null;
  await restart.admitPending(); assert.equal(h.rows().size,4); assert.ok([...h.intents().values()].every((item) => item.admitted_at));
  await assert.rejects(restart.admitPending(101), { code: "invalid-input" });
});

test("queue cap defers durable intentions and rejects tests and manual retry", { timeout: 4000 }, async () => {
  const h = harness(); const id = await admitted(h); await terminalFailure(h,id);
  const failed = structuredClone(h.rows().get(id)!);
  for (let index=0;index<NOTIFICATION_LIMITS.maxQueuedDeliveries;index++) h.rows().set(`active-${index}`, {
    ...failed, id: `active-${index}`, state: index%3 === 0 ? "sending" : index%3 === 1 ? "queued" : "retrying" });
  h.intention("deferred");
  assert.deepEqual(await h.service.admitPending(),{ admitted:0,deferred:1 });
  assert.equal(h.intents().get("deferred|initial|webhook")!.admitted_at,null);
  await assert.rejects(h.service.enqueueSavedChannelTest("webhook"),{ code:"queue-full" });
  await assert.rejects(h.service.retry(id,{ expectedGeneration:0 }),{ code:"queue-full" });
  h.rows().delete("active-0"); assert.equal((await h.service.admitPending()).admitted,1);
});

test("claim increments durable attempts; only transient and timeout retry at 30/120/600 seconds from finish", { timeout: 1000 }, async () => {
  for (const failure of ["transient","timeout"] as const) {
    const h=harness(); const id=await admitted(h);
    for(let attempt=1;attempt<=4;attempt++) {
      const claims=await Promise.all([h.service.claim(),h.service.claim()]);
      assert.equal(claims.flat().length,1); const claim=claims.flat()[0];
      assert.equal((await h.service.read(id)).attempts,attempt);
      h.advance(1000); const finished=await h.service.finish(claim,{ status:"failed",failure });
      assert.equal(finished!.state,attempt<4?"retrying":"failed"); assert.equal(finished!.attempts,attempt);
      if(attempt<4) {
        const delay=NOTIFICATION_LIMITS.retryDelaysMs[attempt-1];
        assert.equal(Date.parse(finished!.nextAttemptAt!)-h.now().getTime(),delay);
        h.advance(delay-1); assert.deepEqual(await h.service.claim(),[]); h.advance(1);
      } else assert.equal(finished!.nextAttemptAt,null);
    }
    assert.equal(h.history().length,1); assert.deepEqual(await h.service.claim(),[]);
  }
});

test("all permanent categories finish once, delivered clears previous failure, and all public states parse", { timeout: 1000 }, async () => {
  for(const failure of ["authentication","validation","destination-rejected","configuration-missing"] as const) {
    const h=harness(); const id=await admitted(h); const claim=(await h.service.claim())[0];
    const result=await h.service.finish(claim,{ status:"failed",failure });
    assert.equal(result!.state,"failed"); assert.equal(result!.attempts,1); assert.equal(result!.failure,failure);
    assert.equal((await h.service.read(id)).nextAttemptAt,null); assert.deepEqual(await h.service.claim(),[]);
  }
  const h=harness(); const id=await admitted(h); notificationDeliveryViewSchema.parse(await h.service.read(id));
  let claim=(await h.service.claim())[0]; notificationDeliveryViewSchema.parse(await h.service.read(id));
  await h.service.finish(claim,{ status:"failed",failure:"transient" }); notificationDeliveryViewSchema.parse(await h.service.read(id));
  h.advance(30000); claim=(await h.service.claim())[0];
  const result=await h.service.finish(claim,{ status:"delivered" });
  assert.equal(result!.state,"delivered"); assert.equal(result!.failure,null); notificationDeliveryViewSchema.parse(result);
  assert.equal(await h.service.finish(claim,{ status:"failed",failure:"timeout" }),null);
  await assert.rejects(h.service.retry(id,{ expectedGeneration:0 }),{ code:"conflict" });
});

test("persisted lease recovery survives restart and stale token/generation cannot overwrite a new claim", { timeout: 1000 }, async () => {
  const h=harness(); const id=await admitted(h); const old=(await h.service.claim())[0];
  const restart=createNotificationDeliveries(h.database,h.dependencies);
  h.advance(NOTIFICATION_DELIVERY_LEASE_MS-1); assert.equal(await restart.recoverExpiredSending(),0);
  assert.equal(await restart.prepareDispatch(old),null);
  h.advance(1); assert.equal(await restart.finish(old,{ status:"delivered" }),null);
  assert.equal(await restart.prepareDispatch(old),null);
  assert.equal(await restart.recoverExpiredSending(),1);
  const result=await restart.read(id); assert.equal(result.attempts,1); assert.equal(result.failure,"timeout");
  assert.equal(Date.parse(result.nextAttemptAt!)-h.now().getTime(),30000);
  assert.equal(await restart.recoverExpiredSending(),0); h.advance(30000);
  const current=(await restart.claim())[0]; assert.notEqual(current.token,old.token);
  assert.equal(await restart.finish(old,{ status:"delivered" }),null);
  assert.equal(await restart.finish({ ...current,generation:1 },{ status:"delivered" }),null);
  assert.equal((await restart.finish(current,{ status:"delivered" }))!.attempts,2);
  assert.equal(NOTIFICATION_DELIVERY_LEASE_MS,20000);
});

test("manual retry CAS preserves id/history, resets attempts and rebuilds current saved configuration", { timeout: 1000 }, async () => {
  const h=harness(); const id=await admitted(h); await terminalFailure(h,id);
  h.config.format="Ziel {target}: {cause}; {time}; {action}";
  h.config.channels.find((c)=>c.kind==="webhook")!.endpoint="https://example.invalid/changed";
  h.config.channels.find((c)=>c.kind==="webhook")!.authorization="changed-synthetic-authorization";
  const results=await Promise.allSettled([h.service.retry(id,{ expectedGeneration:0 }),h.service.retry(id,{ expectedGeneration:0 })]);
  assert.equal(results.filter((r)=>r.status==="fulfilled").length,1);
  assert.equal(results.filter((r)=>r.status==="rejected").length,1);
  const row=await h.service.read(id); assert.equal(row.generation,1); assert.equal(row.attempts,0); assert.equal(row.failure,null);
  assert.equal(row.finishedAt,null); assert.equal(row.id,id); assert.equal(h.history()[0].failure,"authentication");
  const claim=(await h.service.claim())[0]; const dispatch=await h.service.prepareDispatch(claim);
  assert.equal(dispatch!.config.kind,"webhook");
  assert.ok(dispatch!.message.requiredText.startsWith("Ziel"));
  assert.equal(h.rows().get(id)!.private_snapshot.format,h.config.format);
  await assert.rejects(h.service.retry(id,{ expectedGeneration:1 }),{ code:"conflict" });
  await assert.rejects(h.service.retry(id,{ expectedGeneration:1,endpoint:"https://example.invalid" }),{ code:"invalid-input" });
  await h.service.finish(claim,{ status:"failed",failure:"validation" });
  await assert.rejects(h.service.retry(id,{ expectedGeneration:0 }),{ code:"conflict" });
});

test("saved test jobs use all four private channel configs, never logs or caller destinations, and cancelled tests retry", { timeout: 1000 }, async () => {
  const h=harness();
  for(const channel of NOTIFICATION_CHANNELS) {
    h.config.channels.find((c)=>c.kind===channel)!.defaults.includeLogs=true;
    const delivery=await h.service.enqueueSavedChannelTest(channel); assert.equal(delivery.phase,"test"); assert.equal(delivery.ticketId,null); assert.equal(delivery.includeLogs,false);
    const claim=(await h.service.claim())[0]; const prepared=await h.service.prepareDispatch(claim);
    assert.equal(prepared!.config.kind,channel); assert.match(prepared!.message.requiredText,/Testnachricht/u);
    assert.equal(prepared!.message.optionalText,undefined);
    await h.service.finish(claim,{ status:"delivered" });
  }
  await assert.rejects(h.service.enqueueSavedChannelTest({ channel:"webhook",endpoint:"https://example.invalid" }),{ code:"invalid-input" });
  const row=await h.service.enqueueSavedChannelTest("webhook"); const claim=(await h.service.claim())[0];
  h.config.channels.find((c)=>c.kind==="webhook")!.endpoint=null;
  assert.equal(await h.service.prepareDispatch(claim),null); assert.equal((await h.service.read(row.id)).state,"cancelled");
  await assert.rejects(h.service.enqueueSavedChannelTest("webhook"),{ code:"channel-unconfigured" });
  h.config.channels.find((c)=>c.kind==="webhook")!.endpoint="https://example.invalid/new";
  assert.equal((await h.service.retry(row.id,{ expectedGeneration:0 })).generation,1);
  assert.ok(!JSON.stringify(await h.service.list({})).includes("example.invalid"));
  assert.ok(!JSON.stringify(await h.service.list({})).includes("authorization"));
});

test("dispatch revokes changed rules, registration, credentials, destinations and logs with fixed visible categories", { timeout: 1000 }, async () => {
  for(const change of ["rule","host","endpoint","credential","logs"] as const) {
    const h=harness();
    if(change==="logs") { h.config.hostRules[3].overrides.includeLogs=true; }
    const item=h.intention(); if(change==="logs") item.snapshot.options.includeLogs=true;
    await h.service.admitPending(); const claim=(await h.service.claim())[0];
    if(change==="rule") h.config.hostRules=[];
    if(change==="host") h.registered(false);
    if(change==="endpoint") h.config.channels.find((c)=>c.kind==="webhook")!.endpoint="https://example.invalid/replaced";
    if(change==="credential") h.config.channels.find((c)=>c.kind==="webhook")!.authorization="rotated-synthetic";
    if(change==="logs") h.config.hostRules[3].overrides.includeLogs=false;
    assert.equal(await h.service.prepareDispatch(claim),null);
    const result=await h.service.read(claim.id); assert.equal(result.state,"cancelled"); notificationDeliveryViewSchema.parse(result);
    assert.equal(result.failure,change==="rule"||change==="logs"?"validation":"configuration-missing");
    assert.equal(h.history().length,1); assert.ok(!JSON.stringify(h.history()).includes("synthetic"));
  }
});

test("current target inheritance honors entire container override, empty and inactive selection without online dependence", { timeout: 1000 }, async () => {
  const target={ kind:"container" as const,hostId:"host-a",target:{ kind:"container" as const,containerName:"container-a" } };
  const stack={ kind:"stack" as const,hostId:"host-a",projectName:"project-a" };
  for(const mode of ["global","stack","container","empty","inactive","removed"] as const) {
    const h=harness(); h.stack(stack);
    const selection={ channel:"webhook" as const,events:["update-failed" as const],overrides:{ destination:null,includeLogs:false,recovery:false,additionalText:"Local" } };
    h.config.defaults=[selection];
    if(mode!=="global") h.scopes.set(targetKey(stack),{ active:true,configuration:{ mode:"explicit",selections:[{ ...selection,overrides:{ ...selection.overrides,additionalText:"Stack" } }] } });
    if(["container","empty","inactive"].includes(mode)) h.scopes.set(targetKey(target),{ active:mode!=="inactive",configuration:{ mode:"explicit",selections:mode==="empty"?[]:[selection] } });
    const intention=h.intention(); Object.assign(intention.snapshot.ticket,{ target,event:"update-failed",action:"inspect-update" });
    intention.snapshot.destinationScopeKey=mode==="global"?null:mode==="stack"||mode==="removed"?targetKey(stack):targetKey(target);
    await h.service.admitPending(); if(mode==="removed") h.targetExists(false);
    const claim=(await h.service.claim())[0]; const result=await h.service.prepareDispatch(claim);
    if(["empty","inactive","removed"].includes(mode)) { assert.equal(result,null); assert.equal((await h.service.read(claim.id)).state,"cancelled"); }
    else assert.ok(result);
  }
});

test("ack leaves admitted jobs intact; optional recovery admission is independent", { timeout: 1000 }, async () => {
  const h=harness();
  h.config.hostRules=[{ channel:"webhook",events:["connection-lost"],overrides:{ recovery:true } }];
  const tickets=createNotificationTickets(h.database,{ ...h.dependencies,sanitizeText:(value)=>value });
  const observation: TicketObservation={ ...ticket,source:"synthetic-source",observedAt:instant };
  const created=await tickets.observe(observation); assert.equal(created.pendingDeliveryCount,1);
  await h.service.admitPending(); const id=[...h.rows().keys()][0];
  const ack=await tickets.acknowledge(created.id); assert.equal(ack.state,"acknowledged"); assert.equal(h.intents().size,1);
  const claim=(await h.service.claim())[0]; assert.equal(claim.id,id); assert.ok(await h.service.prepareDispatch(claim));
  h.advance(1000); await tickets.recover(created.id,async()=>({ recovered:true,observedAt:h.now().toISOString() }));
  assert.equal((await h.service.admitPending()).admitted,1);
  assert.equal([...h.rows().values()].filter((row)=>row.phase==="recovery").length,1);
  h.config.hostRules[0].overrides.recovery=false;
  const recovery=(await h.service.claim())[0]; assert.equal(await h.service.prepareDispatch(recovery),null);
});

test("lease expiring during target reader yields no dispatch", { timeout: 1000 }, async () => {
  const h=harness(); const item=h.intention(); Object.assign(item.snapshot.ticket,{ target:{ kind:"stack",hostId:"host-a",projectName:"project-a" },event:"update-failed",action:"inspect-update" });
  h.config.defaults=[{ channel:"webhook",events:["update-failed"],overrides:{ destination:null } }];
  await h.service.admitPending(); const claim=(await h.service.claim())[0]; h.tickInReader(20000);
  assert.equal(await h.service.prepareDispatch(claim),null); assert.equal((await h.service.read(claim.id)).state,"sending");
});

test("history stays bounded across manual generations and terminal maintenance runs at admission and finish", { timeout: 4000 }, async () => {
  const h=harness(); const id=await admitted(h);
  for(let generation=0;generation<103;generation++) {
    await terminalFailure(h,id); if(generation<102) await h.service.retry(id,{ expectedGeneration:generation });
  }
  assert.equal(h.history().length,100); assert.equal(h.history()[0].generation,3); assert.equal(h.history().at(-1)!.generation,102);
  h.advance(NOTIFICATION_LIMITS.terminalDeliveryRetentionMs); assert.equal(await h.service.pruneTerminal(),0);
  h.advance(1); assert.equal(await h.service.pruneTerminal(),1); assert.equal(h.history().length,0);
  const fresh=harness(); const active=await admitted(fresh); const prototype=structuredClone(fresh.rows().get(active)!);
  for(let index=0;index<10000;index++) fresh.rows().set(`terminal-${String(index).padStart(5,"0")}`,{ ...prototype,id:`terminal-${String(index).padStart(5,"0")}`,ticket_id:null,phase:"test",state:"failed",attempts:1,
    finished_at:instant,next_attempt_at:null,failure:"authentication" });
  fresh.advance(1); await terminalFailure(fresh,active); assert.equal([...fresh.rows().values()].filter((row)=>row.state==="failed").length,10000);
  assert.equal(fresh.rows().has("terminal-00000"),false);
  const activeTest=await fresh.service.enqueueSavedChannelTest("webhook");
  fresh.advance(NOTIFICATION_LIMITS.terminalDeliveryRetentionMs+1); await fresh.service.enqueueSavedChannelTest("webhook");
  assert.equal(fresh.rows().size,2); assert.ok(fresh.rows().has(activeTest.id));
});

test("history cap aggregates the ticket across channels and test history is bounded per delivery", { timeout: 3000 }, async () => {
  const h=harness(); for(const channel of ["webhook","gotify"] as const) h.intention("ticket-a",channel);
  await h.service.admitPending(); const ids=[...h.rows().keys()];
  for(let generation=0;generation<51;generation++) {
    const claims=await h.service.claim(); for(const claim of claims) await h.service.finish(claim,{ status:"failed",failure:"validation" });
    if(generation<50) for(const id of ids) await h.service.retry(id,{ expectedGeneration:generation });
  }
  assert.equal(h.history().length,100);
  const job=await h.service.enqueueSavedChannelTest("webhook");
  for(let generation=0;generation<102;generation++) {
    await terminalFailure(h,job.id); if(generation<101) await h.service.retry(job.id,{ expectedGeneration:generation });
  }
  assert.equal(h.history().filter((entry)=>entry.ticket_id===null).length,100);
  assert.equal(h.history().filter((entry)=>entry.ticket_id==="ticket-a").length,100);
});

test("filter-bound HMAC keyset pagination is stable on restart and rejects malformed inputs", { timeout: 1000 }, async () => {
  const h=harness(); for(let i=0;i<3;i++) await h.service.enqueueSavedChannelTest("webhook");
  const page=await h.service.list({ limit:1,channel:"webhook",state:"queued" }); notificationDeliveriesResponseSchema.parse(page);
  assert.ok(page.nextCursor); assert.ok(page.nextCursor.length<=200);
  const restart=createNotificationDeliveries(h.database,h.dependencies);
  const next=await restart.list({ limit:1,channel:"webhook",state:"queued",cursor:page.nextCursor });
  assert.notEqual(page.deliveries[0].id,next.deliveries[0].id); assert.equal(next.deliveries.length,1);
  for(const input of [{ limit:101 },{ limit:1.5 },{ channel:"unknown" },{ ticketId:"x".repeat(201) },{ cursor:"bad" },
    { limit:2,channel:"webhook",state:"queued",cursor:page.nextCursor },
    { limit:1,channel:"gotify",state:"queued",cursor:page.nextCursor },
    { limit:1,channel:"webhook",state:"failed",cursor:page.nextCursor },
    { limit:1,channel:"webhook",state:"queued",cursor:page.nextCursor.slice(0,-3)+"xxx" }]) await assert.rejects(restart.list(input),{ code:"invalid-input" });
  await assert.rejects(restart.read("x".repeat(201)),{ code:"invalid-input" });
  await assert.rejects(restart.read("missing"),{ code:"delivery-unknown" });
  assert.throws(()=>createNotificationDeliveries(h.database,{ ...h.dependencies,cursorSecret:"short" }));
  assert.equal((await restart.list({ ticketId:"missing" })).deliveries.length,0);
});

test("immutable queue migration protects active ticket ownership and checks state/lease/index invariants", () => {
  const sql=readFileSync(new URL("../../platform/db/migrations/020-notification-deliveries.sql",import.meta.url),"utf8");
  assert.match(sql,/ticket_id text REFERENCES notification_ticket\(id\) ON DELETE RESTRICT/);
  assert.match(sql,/UNIQUE \(ticket_id, phase, channel\)/);
  assert.match(sql,/attempts BETWEEN 0 AND 4/);
  assert.match(sql,/lease_deadline > updated_at/);
  assert.match(sql,/notification_delivery_due/); assert.match(sql,/notification_delivery_lease/);
});

test("revocation and credential rotation cover four channels in queued/sending/retrying/failed paths", { timeout: 3000 }, async () => {
  for(const channel of NOTIFICATION_CHANNELS) for(const state of ["queued","sending","retrying","failed"] as const) {
    const h=harness(); h.intention("ticket-a",channel); await h.service.admitPending(); const id=[...h.rows().keys()][0];
    let claim=state==="queued"?null:(await h.service.claim())[0];
    if(state==="retrying") {
      await h.service.finish(claim!,{ status:"failed",failure:"transient" }); h.advance(30000);
    }
    if(state==="failed") await h.service.finish(claim!,{ status:"failed",failure:"authentication" });
    const saved=h.config.channels.find((item)=>item.kind===channel)!;
    if(channel==="smtp") saved.connection={ ...saved.connection!,password:"rotated-synthetic",username:"synthetic-user" };
    else if(channel==="gotify") saved.token="rotated-synthetic";
    else if(channel==="webhook") saved.authorization="rotated-synthetic";
    else saved.endpoint="https://example.invalid/rotated-discord";
    if(state==="failed") {
      const retried=await h.service.retry(id,{ expectedGeneration:0 }); assert.equal(retried.generation,1);
      claim=(await h.service.claim())[0]; assert.ok(await h.service.prepareDispatch(claim));
    } else {
      if(state!=="sending") claim=(await h.service.claim())[0];
      assert.equal(await h.service.prepareDispatch(claim!),null); assert.equal((await h.service.read(id)).state,"cancelled");
      assert.equal(h.rows().get(id)!.cancellation_reason,"binding-changed");
      assert.equal((await h.service.retry(id,{ expectedGeneration:0 })).generation,1);
    }
    const fresh=(await h.service.claim())[0];
    if(fresh) {
      if(channel==="smtp") saved.connection=null; else saved.endpoint=null;
      assert.equal(await h.service.prepareDispatch(fresh),null); assert.equal(h.rows().get(id)!.cancellation_reason,"channel-unconfigured");
    }
    assert.ok(!JSON.stringify(await h.service.read(id)).includes("rotated-synthetic"));
    assert.ok(!JSON.stringify(h.history()).includes("rotated-synthetic"));
  }
});

test("B1 intentions preserve 2001 combined options and explicit false; default saved configuration admits nothing", { timeout: 1000 }, async () => {
  const h=harness(); h.config.hostRules=[]; h.config.defaults=[];
  const tickets=createNotificationTickets(h.database,{ ...h.dependencies,sanitizeText:(value)=>value,
    sanitizeEvidence:(evidence)=>evidence });
  const observation: TicketObservation={ ...ticket,source:"synthetic-source",observedAt:instant };
  const off=await tickets.observe(observation); assert.equal(off.pendingDeliveryCount,0);
  assert.equal((await h.service.admitPending()).admitted,0);
  const channel=h.config.channels.find((item)=>item.kind==="webhook")!;
  channel.defaults={ includeLogs:true,recovery:true,additionalText:"G".repeat(1000) };
  h.config.defaults=[{ channel:"webhook",events:["update-failed"],overrides:{ includeLogs:false,recovery:false,
    additionalText:"L".repeat(1000),destination:null } }];
  const next: TicketObservation={ ...observation,episodeKey:"episode-next",event:"update-failed",action:"inspect-update",
    target:{ kind:"container",hostId:"host-a",target:{ kind:"container",containerName:"container-a" } },
    evidence:{ logs:{ state:"available",text:"Bereinigter Logauszug",truncated:false } } };
  const created=await tickets.observe(next); assert.equal(created.pendingDeliveryCount,1); await h.service.admitPending();
  const row=[...h.rows().values()][0]; assert.equal(row.private_snapshot.options.additionalText.length,2001);
  assert.equal(row.private_snapshot.options.includeLogs,false); assert.equal(row.private_snapshot.options.recovery,false);
  assert.equal(row.private_snapshot.ticket.evidence.logs.state,"unavailable");
  const claim=(await h.service.claim())[0]; const prepared=await h.service.prepareDispatch(claim);
  assert.equal(prepared!.message.optionalText!.length,2001);
  assert.ok(!prepared!.message.optionalText!.includes("Logauszug"));
});

test("render validation is a visible permanent queue failure and claim/CAS writes roll back on commit errors", { timeout: 1000 }, async () => {
  const h=harness(); const item=h.intention();
  item.snapshot.ticket.cause="*_".repeat(500); item.channel="discord";
  h.intents().delete("ticket-a|initial|webhook"); item.snapshot.bindingDigest=h.snapshot("discord").bindingDigest;
  h.intents().set("ticket-a|initial|discord",item);
  await h.service.admitPending(); const id=[...h.rows().keys()][0];
  h.fail("commit"); await assert.rejects(h.service.claim(),/synthetic-commit/);
  assert.equal((await h.service.read(id)).state,"queued"); assert.equal((await h.service.read(id)).attempts,0);
  h.fail(null); const claim=(await h.service.claim())[0];
  assert.equal(await h.service.prepareDispatch(claim),null);
  assert.equal((await h.service.read(id)).state,"failed"); assert.equal((await h.service.read(id)).failure,"validation");
  assert.equal((await h.service.read(id)).attempts,1);
  await h.service.retry(id,{ expectedGeneration:0 }); const fresh=(await h.service.claim())[0];
  h.fail("commit"); await assert.rejects(h.service.finish(fresh,{ status:"delivered" }),/synthetic-commit/);
  assert.equal((await h.service.read(id)).state,"sending"); assert.equal(h.history().length,1);
  h.fail(null); assert.equal((await h.service.finish(fresh,{ status:"delivered" }))!.state,"delivered");
});


test("dispatch requires the full send deadline plus buffer inside the persisted lease", { timeout: 1000 }, async () => {
  const h=harness(); await admitted(h); const claim=(await h.service.claim())[0];
  const deadline=h.rows().get(claim.id)!.lease_deadline;
  h.advance(4000); assert.ok(await h.service.prepareDispatch(claim));
  assert.equal(h.rows().get(claim.id)!.lease_deadline,deadline);
  h.advance(1); assert.equal(await h.service.prepareDispatch(claim),null);
  assert.equal((await h.service.read(claim.id)).state,"sending");
  h.advance(15999); assert.equal(await h.service.recoverExpiredSending(),1);
  assert.equal((await h.service.read(claim.id)).attempts,1);
});
