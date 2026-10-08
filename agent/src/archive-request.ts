import http from "node:http";
import { EngineError } from "./engine-errors.js";
import type { EngineOptions } from "./engine-model.js";

export function openArchiveStream(options: EngineOptions, containerId: string, target: string, signal?: AbortSignal): Promise<http.IncomingMessage> {
  const query = new URLSearchParams({ path: target });
  return new Promise((resolve, reject) => {
    const request = http.request({ socketPath: options.socketPath, method: "GET",
      path: `/containers/${encodeURIComponent(containerId)}/archive?${query}`, headers: { Host: "docker", Accept: "application/x-tar" },
      signal, timeout: options.timeoutMs ?? 15_000 }, (response) => {
      if (response.statusCode !== 200) {
        response.destroy();
        reject(new EngineError("archive-read-failed", response.statusCode ?? 502));
      } else resolve(response);
    });
    request.on("timeout", () => request.destroy(new Error("archive-timeout")));
    request.on("error", reject);
    request.end();
  });
}
