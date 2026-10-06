import type http from "node:http";
import type { RuntimeAction, RuntimeServiceResult, StackActionStreamLine, StackRuntimeResult } from "contract";
import { sendLine } from "../ndjson-line.js";

export function stackRuntimeResponder(response: http.ServerResponse, action: RuntimeAction, projectName: string, streaming: boolean) {
  return {
    onStart: (applyDefinition: boolean) => {
      if (!streaming || response.destroyed) return;
      response.writeHead(200, { "content-type": "application/x-ndjson; charset=utf-8", "cache-control": "no-store, no-transform" });
      sendLine(response, { kind: "start", action, projectName, applyDefinition } satisfies StackActionStreamLine);
    },
    onProgress: (service: RuntimeServiceResult) => {
      if (streaming && response.headersSent) sendLine(response, { kind: "progress", service } satisfies StackActionStreamLine);
    },
    finish: (result: { status: number; body: StackRuntimeResult }) => {
      if (response.destroyed || response.writableEnded) return;
      if (response.headersSent) {
        sendLine(response, { kind: "result", status: result.status, body: result.body } satisfies StackActionStreamLine);
        response.end();
      } else {
        response.writeHead(result.status, { "content-type": "application/json; charset=utf-8" });
        response.end(JSON.stringify(result.body));
      }
    }
  };
}
