import {
  selfHealingMaintenanceRequestSchema, selfHealingMaintenanceDeleteSchema, selfHealingTargetRequestSchema
} from "contract";
import { actionFailureOf } from "../action-failure.js";
import { selfHealing } from "../runtime/self-healing.js";
import { audit, dockerEvents, selfHealingConfig, selfHealingState } from "../runtime/state.js";
import { send, readJsonBody, parseRequest, InvalidJsonError, type RouteContext } from "../runtime/http.js";

export async function handleSelfHealingStatus(ctx: RouteContext): Promise<void> {
  const observing = dockerEvents.isObserving() && selfHealing.isAvailable();
  let status = observing ? 200 : 503;
  let body: unknown;
  let reason: string | undefined = observing ? undefined : "events-unavailable";
  try { body = selfHealingState.status(selfHealingConfig.read(), observing, Date.now()); }
  catch (error) { const failure = actionFailureOf(error, true); status = failure.status; body = failure.body; reason = failure.auditReason; }
  audit.write({ action: "self-healing-status", containerId: null, containerName: null,
    actor: ctx.actor, outcome: status === 200 ? "allowed" : "error", reason });
  ctx.response.setHeader("cache-control", "no-store");
  send(ctx.response, status, body);
}

async function control(ctx: RouteContext, action: string, operation: () => Promise<Record<string, unknown>>): Promise<void> {
  let status = 200;
  let body: Record<string, unknown>;
  let outcome: "allowed" | "denied" | "error" = "allowed";
  let reason: string | undefined;
  try {
    body = await operation();
    if (body.error) { status = 400; outcome = "denied"; reason = `${String(body.error)}: ${String(body.field ?? "")}`; }
  } catch (error) {
    const failure = error instanceof InvalidJsonError
      ? { status: 400, body: { error: "invalid-json", field: "" }, auditReason: "invalid-json" }
      : actionFailureOf(error, true);
    status = failure.status; body = failure.body; reason = failure.auditReason;
    outcome = error instanceof InvalidJsonError ? "denied" : "error";
  }
  audit.write({ action, containerId: null, containerName: null, actor: ctx.actor, outcome, reason });
  send(ctx.response, status, body);
}

export async function handleSelfHealingMaintenance(ctx: RouteContext): Promise<void> {
  await control(ctx, "self-healing-maintenance", async () => {
    const input = await readJsonBody(ctx.request);
    if (ctx.request.method === "DELETE") {
      const parsed = parseRequest(selfHealingMaintenanceDeleteSchema, input);
      if (!parsed.ok) return parsed.rejection;
      selfHealingState.clearMaintenance(parsed.value.target);
    } else {
      const parsed = parseRequest(selfHealingMaintenanceRequestSchema, input);
      if (!parsed.ok) return parsed.rejection;
      const duration = parsed.value.durationSeconds === undefined
        ? selfHealingConfig.read().maintenanceDurationSeconds : parsed.value.durationSeconds;
      selfHealingState.setMaintenance(parsed.value.target, duration, ctx.actor, Date.now());
    }
    return { ok: true };
  });
}
export async function handleSelfHealingAcknowledge(ctx: RouteContext): Promise<void> {
  await control(ctx, "self-healing-acknowledge", async () => {
    const parsed = parseRequest(selfHealingTargetRequestSchema, await readJsonBody(ctx.request));
    if (!parsed.ok) return parsed.rejection;
    selfHealingState.refill(parsed.value.target, Date.now(), "acknowledged");
    return { ok: true };
  });
}
