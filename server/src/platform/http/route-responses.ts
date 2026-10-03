import type { Request, RequestHandler, Response } from "express";

// Two helpers nearly every route handler needs, whatever surface it serves.
// They stood in `app/router-support.ts` until #254; a feature uses them too
// and imports only `domain`, `platform` and `contract`
// (docs/design/feature-architecture.md, section 3).

// The short error answer nearly every handler sends at the end of a failed
// branch: a code for the surface, a sentence for the person in front of it.
export function failWith(response: Response, status: number, error: string, message: string): void {
  response.status(status).json({ error, message });
}

// A handler that may throw: otherwise the promise bypasses the Express error
// handler, as an answer without a log line or as an unhandled rejection in
// the process, depending on the version.
export function guarded(handler: (request: Request, response: Response) => Promise<void>): RequestHandler {
  return (request, response, next) => {
    handler(request, response).catch(next);
  };
}
