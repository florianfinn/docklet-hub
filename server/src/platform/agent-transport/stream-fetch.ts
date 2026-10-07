import { request as httpRequest, type IncomingMessage } from "node:http";
import { request as httpsRequest } from "node:https";
import { Readable } from "node:stream";

const CONNECTION_FAILURE_CODES = new Set(["ECONNREFUSED", "ENOTFOUND", "EAI_AGAIN", "EHOSTUNREACH", "ENETUNREACH"]);

// node:http has no implicit header or body deadline. Callers own the timeout
// and cancellation, including synchronous runtime actions with long queues.
// Supports the string bodies and headers used by the agent protocol.
export class StreamFetchError extends Error {
  constructor(cause: Error, readonly requestSent: boolean) {
    super(cause.message, { cause });
    this.name = cause.name;
  }
}

export const streamFetch = ((input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) =>
  new Promise<Response>((resolve, reject) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    const send = url.protocol === "https:" ? httpsRequest : httpRequest;
    const outgoing = send(
      url,
      {
        method: init?.method ?? "GET",
        headers: Object.fromEntries(new Headers(init?.headers)),
        // Abort rejects before headers and destroys the body after headers.
        signal: init?.signal ?? undefined
      },
      (incoming) => resolve(toResponse(incoming))
    );
    let socket: import("node:net").Socket | undefined;
    let initialBytes = 0;
    let connected = false;
    outgoing.on("socket", (assigned) => {
      socket = assigned;
      initialBytes = assigned.bytesWritten;
      connected = !assigned.connecting;
      if (!connected) assigned.once("connect", () => { connected = true; });
    });
    outgoing.on("error", (error: NodeJS.ErrnoException) => {
      // bytesWritten includes buffers; require a connection and exclude bytes still queued.
      // Keep connection evidence after destruction, including ECONNRESET after sending.
      const requestSent = connected && !CONNECTION_FAILURE_CODES.has(error.code ?? "") &&
        (outgoing.writableFinished ||
          (socket ? socket.bytesWritten - socket.writableLength : 0) > initialBytes);
      reject(new StreamFetchError(error, requestSent));
    });
    if (typeof init?.body === "string") outgoing.end(init.body);
    else outgoing.end();
  })) as typeof fetch;

function toResponse(incoming: IncomingMessage): Response {
  const headers = new Headers();
  for (const [name, value] of Object.entries(incoming.headers)) {
    if (value === undefined) continue;
    for (const single of Array.isArray(value) ? value : [value]) headers.append(name, single);
  }
  const status = incoming.statusCode ?? 502;
  // Response forbids bodies for these statuses.
  const body =
    status === 204 || status === 304 ? null : (Readable.toWeb(incoming) as unknown as ReadableStream<Uint8Array>);
  if (body === null) incoming.resume();
  return new Response(body, { status, statusText: incoming.statusMessage, headers });
}
