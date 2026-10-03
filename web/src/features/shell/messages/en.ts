// English texts of the feature `shell` (#261). The reasons stand next to the
// German texts (`de.ts`); here is only the translation.
//
// ⚠️ `satisfies typeof deShell` is on the literal because only an object
// literal is checked by TypeScript for EXCESS properties: without it this part
// could silently carry a key that does not exist in German.

import type { deShell } from "./de";

export const enShell = {
  containerTabShell: "Shell",

  shellLoading: "Loading the terminal …",
  shellLoadFailed: "The terminal could not be loaded. The tab fetches it on open; reloading usually helps.",
  shellTerminalLabel: "Container terminal",

  shellConnecting: "Connecting …",
  shellConnected: "Connected to {container}",
  shellEnded: "Exited with code {code}. A new shell opens through the button.",
  shellBroken: "The connection ended without a reason known here. Why, is in the audit log of the arm.",
  shellReconnect: "Reconnect",

  shellFailureRevoked: "The right to this shell was revoked while it was running. The connection therefore ended.",
  shellFailureClosed: "This shell was closed. A new one opens through the button.",
  shellFailureAgentBroken: "The connection to the arm broke off without a closing line.",
  shellFailureUnknown: "The connection ended ({reason}).",

  shellErrorUnauthenticated: "This session is no longer signed in. The shell opens after signing in again.",
  shellErrorAdminRequired: "Only an administrator opens a shell. This sign-in has the role user.",
  shellErrorHostUnknown: "The hub no longer keeps this arm.",
  shellErrorHostUnreachable: "This arm does not answer. Without it there is no shell.",
  shellErrorAgentOutdated:
    "The agent of this arm is too old for a shell. Reading still works; this needs a newer version.",
  shellErrorContainerUnknown: "This arm does not keep this container.",
  shellErrorContainerNotRunning: "This container is not running. A shell needs a running process.",
  shellErrorNoShell: "This image has neither bash nor sh. Without a shell inside there is no terminal to open.",
  shellErrorTooManySessions:
    "This arm already runs as many shells as it allows. As soon as someone closes one, a slot frees up.",
  shellErrorOwnSessionLimit:
    "As many of your own shells are open on this arm as are allowed. Close one of them, then the next one opens.",
  shellErrorAgentReadOnly: "This arm is set to read only. It does not open a shell while the kill switch is down.",
  shellErrorAgentForbidden: "The arm does not keep this container in its allowlist.",
  shellErrorContainerObserveOnly:
    "This container is released for observing only. The arm opens no shell there and takes no input.",
  shellErrorAgentUnreachable: "The arm could not create the shell.",
  shellErrorSessionUnknown:
    "This shell session no longer exists. It was closed, it expired, or it belongs to another container.",
  shellErrorInvalidInput: "The hub did not accept this input. That is a fault of this interface.",
  shellErrorInputTooLarge: "This input is too large for the arm. It takes about 48 KiB of raw bytes per request.",
  shellErrorUnknown: "The shell was rejected ({reason}).",
  shellErrorWithoutReason: "The shell was rejected without a readable reason."
} satisfies typeof deShell;
