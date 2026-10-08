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

export async function putArchiveStream(options: EngineOptions, containerId: string, target: string,
  input: AsyncIterable<Buffer>, signal?: AbortSignal): Promise<void> {
  const query = new URLSearchParams({ path: target, noOverwriteDirNonDir: "1" });
  await new Promise<void>((resolve, reject) => {
    const request = http.request({ socketPath: options.socketPath, method: "PUT",
      path: `/containers/${encodeURIComponent(containerId)}/archive?${query}`, signal,
      headers: { Host: "docker", "Content-Type": "application/x-tar" }, timeout: options.timeoutMs ?? 15_000 }, (response) => {
      response.resume();
      response.on("end", () => response.statusCode === 200 ? resolve() : reject(new EngineError("archive-write-failed", response.statusCode ?? 502)));
      response.on("error", reject);
    });
    request.on("error", reject);
    request.on("timeout", () => request.destroy(new Error("archive-timeout")));
    void (async () => {
      try {
        for await (const chunk of input) {
          signal?.throwIfAborted();
          if (!request.write(chunk)) await new Promise<void>((ready, failed) => {
            const drained = () => { request.off("error", failed); ready(); };
            request.once("drain", drained); request.once("error", failed);
          });
        }
        request.end();
      } catch (error) { request.destroy(); reject(error); }
    })();
  });
}
