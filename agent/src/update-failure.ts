import { updateFailureSchema, type UpdateResult } from "contract";
import { UpdateFailure } from "./update-budget.js";
import { StackEndpointError } from "./stack-control.js";

export function updateFailureCode(error: unknown): NonNullable<UpdateResult["updateError"]> {
  if (error instanceof UpdateFailure) return error.code;
  if (error instanceof StackEndpointError) {
    const parsed = updateFailureSchema.safeParse(error.code);
    // Authorization keys outside the result vocabulary indicate changed eligibility.
    return parsed.success ? parsed.data : "state-changed";
  }
  return error instanceof Error && error.message === "action-queue-timeout" ? "action-queue-timeout" : "update-exchange-failed";
}
