import { clearEditorDrafts } from "../editor/useEditorDocument";
import { postJson, request } from "../http/transport";
import type { SessionUser } from "./session-user";

// The calls of the own session: whether the first sign-up is still open, who
// is signed in, and signing out. Until #271 they stood in
// `web/src/api/client.ts`. They live in `platform/` because the app root
// (`App.tsx`) and the shell (`app/shell/AppShell.tsx`) call them, and the
// feature `account` shows the session they read; signing in and the first
// sign-up stay in `features/account/api.ts`.
//
// The session travels in the cookie better-auth sets; `request` sends it with
// every call (`credentials: "include"`, see `platform/http/transport.ts`).

export function fetchSetupState(): Promise<{ open: boolean }> {
  return request("/api/setup");
}

export function fetchSession(): Promise<{ user: SessionUser }> {
  return request("/api/session");
}

// Signing out lives at better-auth under /api/auth, like signing in and the
// first sign-up (`features/account/api.ts`). It stays here because the shell
// calls it, and a shell imports no feature.
export function signOut(): Promise<unknown> {
  clearEditorDrafts();
  return postJson("/api/auth/sign-out", {});
}
