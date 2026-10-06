import { actionFailureOf, RuntimeActionFailure, type ActionFailure } from "./action-failure.js";

// Read back even after a failed mutation or guard. Preserve both diagnostics
// if recovery fails too; only the handler writes the audit and response.
export async function runtimeReadback<State, Body extends { ok: boolean; error?: string }>(
  execute: () => Promise<void>,
  read: () => Promise<State>,
  unknownState: () => State,
  resultBody: (state: State) => Body,
  additionalFailure?: () => ActionFailure | undefined
): Promise<{ status: number; body: Body }> {
  let failure: ActionFailure | undefined;
  try { await execute(); }
  catch (error) { failure = actionFailureOf(error, true); }
  let state: State;
  try { state = await read(); }
  catch (error) {
    state = unknownState();
    const readFailure = actionFailureOf(error, true);
    failure = failure ? { ...failure, auditReason: `${failure.auditReason}; read-back: ${readFailure.auditReason}` } : readFailure;
  }
  const additional = additionalFailure?.();
  if (additional) failure = failure ? { ...failure, auditReason: `${failure.auditReason}; observation: ${additional.auditReason}` } : additional;
  const body = resultBody(state);
  if (failure) throw new RuntimeActionFailure({ ...failure, body: { ...failure.body, ...body, ok: false, error: failure.body.error } });
  return { status: body.ok ? 200 : 409, body };
}
