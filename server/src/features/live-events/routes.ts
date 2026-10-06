import type { Router } from "express";
import type { LiveEvent } from "contract";

import type { LiveEvents } from "../../domain/live-events/index.js";
import type { Auth } from "../../platform/auth/auth.js";
import { resolveSession, withSession } from "../../platform/auth/session.js";

export function registerLiveEventRoutes(router: Router, options: { auth: Auth; liveEvents?: LiveEvents }): void {
  const sessions = new Map<string, number>();
  let total = 0;
  router.get("/live-events", withSession(options.auth, (request, response, user) => {
    if (response.destroyed || response.writableEnded) return;
    if (!options.liveEvents) { response.status(503).json({ error: "live-events-unavailable" }); return; }
    if (total >= 128 || (sessions.get(user.id) ?? 0) >= 8) {
      response.status(429).json({ error: "too-many-streams" }); return;
    }
    total += 1; sessions.set(user.id, (sessions.get(user.id) ?? 0) + 1);
    response.status(200).set({
      "content-type": "application/x-ndjson; charset=utf-8",
      "cache-control": "no-store, no-transform",
      "x-accel-buffering": "no"
    });
    response.flushHeaders();
    let closed = false;
    let validating = false;
    let unsubscribe = () => undefined as void;
    const cleanup = () => {
      if (closed) return;
      closed = true; clearInterval(heartbeat); clearInterval(sessionCheck); unsubscribe();
      total -= 1;
      const remaining = (sessions.get(user.id) ?? 1) - 1;
      if (remaining === 0) sessions.delete(user.id); else sessions.set(user.id, remaining);
    };
    const send = (event: LiveEvent | null) => {
      if (closed) return;
      if (response.destroyed) { cleanup(); return; }
      // A slow session must reconnect and reread; it cannot back up the shared monitor.
      if (event === null || !response.write(`${JSON.stringify(event)}\n`)) { cleanup(); response.end(); }
    };
    const heartbeat = setInterval(() => send({ kind: "heartbeat" }), 15_000);
    const sessionCheck = setInterval(() => {
      if (validating || closed) return;
      validating = true;
      void resolveSession(options.auth, request).then((currentUser) => {
        if (!currentUser || currentUser.id !== user.id) { send({ kind: "session-expired" }); cleanup(); response.end(); }
      }).catch(() => { cleanup(); response.end(); }).finally(() => { validating = false; });
    }, 30_000);
    heartbeat.unref(); sessionCheck.unref();
    response.once("close", cleanup);
    unsubscribe = options.liveEvents.subscribe(send);
    if (closed) unsubscribe();
  }));
}
