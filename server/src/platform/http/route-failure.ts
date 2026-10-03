import type { Response } from "express";

import type { AgentError } from "../agent-transport/protocol.js";
import { translateAgentError } from "./agent-error-translation.js";
import { failWith } from "./route-responses.js";

// A refusal that a layer below the route decides and the route only writes
// (#260). `domain/` and the services of a feature have no `Response`; they
// return one of these, and the route turns it into the answer.
//
// - `problem`: the hub decided. Status, code for the surface and sentence for
//   the person, as `failWith` takes them.
// - `agent-error`: the agent refused or could not be reached. Which status and
//   code that becomes is the route's call, because a surface may keep its own
//   table (the shell does, see `features/shell/rejections.ts`); the default is
//   `translateAgentError`.
export type RouteFailure =
  | { kind: "problem"; status: number; error: string; message: string }
  | { kind: "agent-error"; error: AgentError };

export function respondWithFailure(
  response: Response,
  failure: RouteFailure,
  translateError: (error: AgentError, response: Response) => void = translateAgentError
): void {
  if (failure.kind === "agent-error") {
    translateError(failure.error, response);
    return;
  }
  failWith(response, failure.status, failure.error, failure.message);
}
