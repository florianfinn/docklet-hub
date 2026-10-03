import type { Messages } from "use-intl";

import { errorCode } from "../../platform/http/transport";
import { composeErrorKey, errorReason } from "./compose-errors";

/** The sentence for a refused dry run or create; other cases as on the compose surface. */
export function projectErrorKey(error: unknown): keyof Messages {
  if (errorCode(error) === "project-name-missing") return "projectErrorNameInvalid";
  switch (errorReason(error)) {
    case "directory-taken":
      return "projectErrorDirectoryTaken";
    case "name-not-usable-as-directory":
      return "projectErrorNameInvalid";
    case "self-management-locked":
      return "projectErrorLocked";
    default:
      return composeErrorKey(error);
  }
}
