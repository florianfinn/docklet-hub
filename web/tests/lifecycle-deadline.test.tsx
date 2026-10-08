import assert from "node:assert/strict";
import test from "node:test";
import { fixture, host, container, button, click, waitFor } from "./lifecycle-test-support.js";

const points = ["before-reservation", "during-reservation", "before-call", "after-call"] as const;
const paths = ["container", "stack-sync", "stack-stream"] as const;
const forms = ["bare-error", "structured-error", "structured-result"] as const;
for (const path of paths) for (const point of points) for (const form of forms) {
  for (const error of ["runtime-deadline-exceeded", "runtime-outcome-unknown"]) {
    test(`unknown boundary outcome: ${path} / ${point} / ${form} / ${error}`, async () => {
      const state = { containerId: "demo-web-id", status: "exited", startedAt: null, exitCode: 1, health: null };
      const result = { ok: false, action: "start", outcome: point === "before-call" ? "ok" : "failed", error,
        ...(path === "container" ? { state } : { applyDefinition: true,
          services: [{ ...state, serviceName: "web", outcome: "failed" }], containerIds: { web: state.containerId } }),
        stderr: "synthetic-private-detail", engineMessage: "synthetic-private-detail" };
      const f = await fixture({ kind: path === "container" ? "container" : "stack", current: host([container("created")]),
        action: () => {
          if (path !== "stack-stream") return Response.json(form === "bare-error" ? { error } : result,
            { status: form === "structured-result" ? 200 : 504 });
          const terminal = form === "structured-result" ? { kind: "result", status: 504, body: result }
            : { kind: "error", status: 504, reason: error, ...(form === "structured-error" ? { body: result } : {}) };
          return new Response(JSON.stringify(terminal) + "\n", { headers: { "content-type": "application/x-ndjson" } });
        }
      });
      try {
        await click(button("start"));
        assert.equal(await waitFor(() => f.calls.some((call) => call.path.endsWith("/overview"))), true);
        assert.equal(await waitFor(() => button("start").getAttribute("aria-disabled") === "false"), true);
        const text = document.body.textContent ?? "";
        assert.equal(text.includes("Ergebnis unbekannt, Vorgang kann auf dem Host weiterlaufen"), true);
        assert.equal(text.includes("Aktion fehlgeschlagen"), false);
        assert.equal(text.includes("Die Aktion wurde abgelehnt"), false);
        assert.equal(text.includes("synthetic-private-detail"), false);
        if (form !== "bare-error") assert.equal(text.includes(`${path === "container" ? "demo-web" : "web"}: exited`), true);
        assert.equal(f.calls.filter((call) => call.method === "POST").length, 1);
        assert.equal(document.querySelector('[role="status"][aria-live="polite"]') !== null, true);
      } finally { await f.close(); }
    });
  }
}
