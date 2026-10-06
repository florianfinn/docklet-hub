import assert from "node:assert/strict";
import test from "node:test";
import { EventEmitter } from "node:events";
import { Router, type RequestHandler } from "express";
import type { LiveEvent } from "contract";
import type { Auth } from "../../platform/auth/auth.js";
import type { LiveEvents } from "../../domain/live-events/index.js";
import { registerLiveEventRoutes } from "./routes.js";

class Answer extends EventEmitter {
  statusCode = 0; ended = false; destroyed = false; writable = true; lines: (LiveEvent | null)[] = [];
  headers: Record<string, string> = {}; body: unknown;
  status(code: number) { this.statusCode = code; return this; }
  set(headers: Record<string, string>) { this.headers = headers; return this; }
  json(body: unknown) { this.body = body; return this; }
  flushHeaders() { return; }
  write(line: string) { this.lines.push(JSON.parse(line)); return this.writable; }
  end() { this.ended = true; this.emit("close"); }
}
async function flush() { await new Promise<void>((resolve) => setImmediate(resolve)); }
function setup(authenticated = true) {
  const listeners = new Set<(event: LiveEvent | null) => void>();
  const router = Router();
  const auth = { api: { getSession: async () => authenticated ? { user: { id: "user-1", name: "Example", email: "user@example.org" } } : null } } as unknown as Auth;
  registerLiveEventRoutes(router, { auth, liveEvents: { subscribe: (listener) => { listeners.add(listener); return () => { listeners.delete(listener); }; } } as LiveEvents });
  const handler = (router as unknown as { stack: { route: { stack: { handle: RequestHandler }[] } }[] }).stack[0].route.stack[0].handle;
  const connect = async (answer = new Answer()) => {
    handler({ headers: {} } as never, answer as never, (error) => { if (error) throw error; });
    await flush(); return answer;
  };
  return { connect, listeners, expire: () => { authenticated = false; }, emit: (event: LiveEvent | null) => { for (const listener of [...listeners]) listener(event); } };
}

test("live route authenticates before subscribing and fans out to both sessions", async () => {
  const denied = setup(false); const answer = await denied.connect();
  assert.equal(answer.statusCode, 401); assert.equal(denied.listeners.size, 0);
  const h = setup(); const first = await h.connect(); const second = await h.connect();
  assert.equal(first.headers["content-type"], "application/x-ndjson; charset=utf-8");
  const event: LiveEvent = { kind: "changed", hostId: "host-1", containerIds: ["a"], action: "start" };
  h.emit(event); assert.deepEqual(first.lines, [event]); assert.deepEqual(second.lines, [event]);
  first.end(); assert.equal(h.listeners.size, 1);
  h.emit(null); assert.equal(second.ended, true); assert.equal(h.listeners.size, 0);
});

test("slow sessions disconnect without buffering or blocking another session", async () => {
  const h = setup(); const slow = await h.connect(); const fast = await h.connect(); slow.writable = false;
  h.emit({ kind: "heartbeat" }); assert.equal(slow.ended, true); assert.equal(fast.ended, false);
  assert.equal(h.listeners.size, 1); fast.end();
});

test("session limit is bounded and a closed connection releases its slot", async () => {
  const h = setup(); const answers: Answer[] = [];
  try {
    for (let i = 0; i < 8; i++) answers.push(await h.connect());
    assert.equal((await h.connect()).statusCode, 429);
    answers[0].end(); answers.push(await h.connect()); assert.equal(answers.at(-1)?.statusCode, 200);
  } finally { for (const answer of answers) answer.end(); }
  assert.equal(h.listeners.size, 0);
});

test("heartbeat and periodic authentication end an expired session", async (context) => {
  context.mock.timers.enable({ apis: ["setInterval"] });
  const h = setup(); const answer = await h.connect();
  try {
    context.mock.timers.tick(15_000); assert.deepEqual(answer.lines, [{ kind: "heartbeat" }]);
    h.expire(); context.mock.timers.tick(15_000); await flush();
    assert.equal(answer.lines.some((event) => event?.kind === "session-expired"), true);
    assert.equal(answer.ended, true); assert.equal(h.listeners.size, 0);
  } finally { answer.end(); }
});

test("a browser that left during authentication never occupies a session slot", async () => {
  const h = setup(); const closed = new Answer(); closed.destroyed = true;
  await h.connect(closed);
  assert.equal(h.listeners.size, 0);
  assert.equal(closed.statusCode, 0);
});
