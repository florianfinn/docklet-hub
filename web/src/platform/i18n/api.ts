import { requestNoContent } from "../http/transport";
import type { Language } from "./languages";

// Sets the language of the own account. Until #271 this stood in
// `web/src/api/client.ts`, which imported `Language` from here while
// `LanguageProvider` imported the call from there: the one import cycle of the
// web (`.dependency-cruiser-known-violations.json`). It lives next to the
// provider that calls it now.
//
// The contract with the server: body `{ "language": "de" | "en" }`, answer 204
// without a body, and for an unusable value 400 with
// `{ "error": "invalid-input", "message": … }`. The error body comes out as an
// `ApiError` like everywhere else and is not shown at the call site: the
// operator reads that the language could not be saved, not the server's key.
//
// `PUT` and not `POST`: the same call twice gives the same state.
export function setLanguage(language: Language): Promise<void> {
  return requestNoContent("/api/session/language", {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ language })
  });
}
