// The stand-ins the client tests of the feature `shell` share (#260): an agent
// that streams given chunks and one that answers the short calls, both writing
// down every call. It is a file of its own so that the tests of the stream and
// those of the three short calls each stay under 400 lines; it is no test and
// stays out of the image (`tsconfig.build.json`).

export const TARGET = { baseUrl: "http://docker-agent:8099", secret: "s".repeat(32) };
export const ACTOR = { kind: "user" as const, id: "u-1" };
export const NEVER_ABORTED = new AbortController().signal;
export const ENCODER = new TextEncoder();

/** Die Frist jedes Falls, der auf eine Attrappe wartet. */
export const DEADLINE_MS = 5_000;

export type Call = { url: string; method: string; headers: Record<string, string>; body: string | null };

/** Eine Attrappe, die genau diese Chunks schickt — und jeden Aufruf mitschreibt. */
export function agentSending(chunks: string[], init?: { status?: number; payload?: unknown }): {
  fetchImpl: typeof fetch;
  calls: Call[];
} {
  const calls: Call[] = [];
  const status = init?.status ?? 200;
  const fetchImpl = (async (input: string | URL | Request, options?: RequestInit) => {
    calls.push({
      url: String(input),
      method: String(options?.method ?? "GET"),
      headers: { ...((options?.headers ?? {}) as Record<string, string>) },
      body: typeof options?.body === "string" ? options.body : null
    });
    if (status !== 200) {
      return new Response(JSON.stringify(init?.payload ?? {}), {
        status,
        headers: { "content-type": "application/json" }
      });
    }
    return new Response(
      new ReadableStream<Uint8Array>({
        start(controller) {
          for (const chunk of chunks) controller.enqueue(ENCODER.encode(chunk));
          controller.close();
        }
      }),
      { status, headers: { "content-type": "application/x-ndjson; charset=utf-8" } }
    );
  }) as unknown as typeof fetch;
  return { fetchImpl, calls };
}

/** Eine Attrappe für die drei kurzen Routen: JSON hinein, JSON heraus. */
export function agentAnswering(init?: { status?: number; payload?: unknown }): {
  fetchImpl: typeof fetch;
  calls: Call[];
} {
  const calls: Call[] = [];
  const fetchImpl = (async (input: string | URL | Request, options?: RequestInit) => {
    calls.push({
      url: String(input),
      method: String(options?.method ?? "GET"),
      headers: { ...((options?.headers ?? {}) as Record<string, string>) },
      body: typeof options?.body === "string" ? options.body : null
    });
    return new Response(JSON.stringify(init?.payload ?? { ok: true }), {
      status: init?.status ?? 200,
      headers: { "content-type": "application/json" }
    });
  }) as unknown as typeof fetch;
  return { fetchImpl, calls };
}

export const line = (event: Record<string, unknown>) => `${JSON.stringify(event)}\n`;
