// Raw Compose editor (stage 7).
//
// Up to this point every Compose file the dashboard wrote came from a
// validated spec (compose.ts/emitComposeYaml). That is why the attack surface
// never came into existence: there is no field for `privileged`, none for
// devices, none for capabilities. Stage 7 reverses that for ONE gated path —
// the operator writes the text himself.
//
// Why this path must exist anyway: since 5d, adopted files are never
// regenerated from the spec (none of the seven inventory files checked would
// have survived it). That makes the raw editor the ONLY way to edit an
// inventory stack at all.
//
// This module is deliberately pure: no file system, no process start, no
// engine. It answers only the questions that decide between running and
// refusing — and those are therefore testable without Docker.
//
// ⚠️ The load-bearing lesson from 5d applies twice here:
//
//   > If the granularity of a unit of work changes, EVERY check written for
//   > the old granularity has to be re-evaluated.
//
// The permission model is per container. A file, however, describes a STACK,
// and an edit can add services that do not exist yet — for which there CAN
// therefore be neither an allowlist entry nor a grant. Exactly this case is
// the reason for `ServiceDiff` and the confirmation lists further down: no
// container comes into being unless the decision about it is in the request
// that creates it.

import { MAX_COMPOSE_BYTES } from "contract";

// A Compose file larger than this is no longer a Compose file. The limit is
// here mainly so that a request does not fill the agent's memory before any
// check kicks in.
export const MAX_RAW_CONTENT_BYTES = MAX_COMPOSE_BYTES;

// The name under which a draft is stored for CHECKING before anything real is
// written.
//
// ⚠️ Deliberately NONE of the names Compose itself accepts as a project file
// (compose.yaml, compose.yml, docker-compose.yaml, docker-compose.yml).
// Otherwise the stack discovery from 5d would report a leftover candidate file
// as a stack of its own — and, worse, a `docker compose up` by hand could pick
// it up. The leading dot additionally keeps it out of the normal directory
// listing.
export const CANDIDATE_FILE_NAME = ".dashboard-raw-candidate.yaml";

// --- Input check of the raw text ------------------------------------------

// Deliberately narrow: `docker compose config` answers everything about the
// content better than an own pre-check could (and a second, slightly different
// interpretation of the same file is the worst option for a security
// question — the same reasoning as in compose.ts). Only what does not belong
// in a file in the first place is checked here.
export function validateRawContent(content: unknown): string[] {
  const errors: string[] = [];
  if (typeof content !== "string") {
    return ["content: must be text"];
  }
  if (content.trim().length === 0) {
    errors.push("content: must not be empty");
  }
  if (Buffer.byteLength(content, "utf8") > MAX_RAW_CONTENT_BYTES) {
    errors.push(`content: größer als ${MAX_RAW_CONTENT_BYTES} Bytes`);
  }
  // A NUL byte cannot occur in YAML, but it can in an attempt to cut off a
  // path or name check somewhere behind it.
  if (content.includes("\0")) {
    errors.push("content: contains a NUL byte");
  }
  return errors;
}

// --- Service sets ---------------------------------------------------------

// The service names from the normalized Compose output.
//
// Separate from servicesFromComposeConfig (compose.ts), because here it
// explicitly does NOT matter whether a service can be translated into our
// spec: for the permission question every service the file names counts —
// especially the one our model does not represent. A service that silently
// dropped out during translation would be a container without a permission
// check.
export function serviceNamesFromConfig(config: unknown): string[] | null {
  const services = (config as { services?: unknown } | null)?.services;
  if (!services || typeof services !== "object" || Array.isArray(services)) return null;
  const names = Object.keys(services as Record<string, unknown>);
  if (names.length === 0) return null;
  return [...names].sort();
}

export type ServiceDiff = {
  // Services that exist before and after. The caller must have permissions
  // on them — the main API checks that, since it knows the grants.
  remaining: string[];
  // Services this edit introduces. For them there is necessarily neither an
  // allowlist entry nor a grant.
  new: string[];
  // Services this edit removes. Their containers are stopped and removed
  // (data in volumes survives).
  removed: string[];
};

export function diffServices(before: readonly string[], after: readonly string[]): ServiceDiff {
  const previous = new Set(before);
  const updated = new Set(after);
  return {
    remaining: [...updated].filter((name) => previous.has(name)).sort(),
    new: [...updated].filter((name) => !previous.has(name)).sort(),
    removed: [...previous].filter((name) => !updated.has(name)).sort()
  };
}

// --- Confirmations --------------------------------------------------------
//
// The core of the decision for this stage: a service that did not exist before
// must not come into being as a side effect of a text change. The caller must
// name it in the same request.
//
// The response is therefore NOT "refused" but "a decision is missing here, for
// exactly these names" — the caller sends the same request again with the
// list. That is the permission query: it necessarily happens before any
// container exists.
//
// The check is for an EXACT match, not a subset. A confirmation for a name that
// does not exist in the diff at all means that the caller assumes a different
// file state than the one currently present — then the confirmation is
// worthless, no matter how complete it is. The same strictness as with
// `acknowledgeImageId` in 5a.
export type ConfirmationValidation = {
  ok: boolean;
  missing: string[];
  unknown: string[];
};

export function checkConfirmation(
  expected: readonly string[],
  confirmed: readonly string[]
): ConfirmationValidation {
  const wanted = new Set(expected);
  const is = new Set(confirmed);
  const missing = [...wanted].filter((name) => !is.has(name)).sort();
  const unknown = [...is].filter((name) => !wanted.has(name)).sort();
  return { ok: missing.length === 0 && unknown.length === 0, missing: missing, unknown };
}

// --- Hardening: before/after ----------------------------------------------
//
// The scope `docker.compose.raw` "can bypass any hardening", yet blocking
// findings must stay operable — otherwise `homepage`, `dozzle` (docker.sock)
// and `upsnap` (network_mode: host) would not even be restartable after the
// takeover.
//
// Both hold at the same time if you ask the question differently: not "is the
// state clean?" but **"does THIS edit introduce something new?"**.
//
//   * dozzle already brings `socket-mount` → is in both lists → tolerated. An
//     editor that fails precisely on the stacks it was built for would be
//     useless.
//   * an edit adds `privileged` → is only in "after" → rollback, unless the
//     caller confirmed exactly that.
//
// The purpose is not to stop the operator (he can do the same via SSH), but
// that it does not happen IN PASSING: in eighty lines of YAML a line is easily
// overlooked, and the difference between "intended" and "slipped in" belongs
// in the audit log.
export type ServiceViolations = {
  serviceName: string;
  // ⚠️ Rule name PLUS detail, not just the rule name.
  //
  // Self-review 2026-07-21: with bare rule names, an existing violation masks
  // every further one of the SAME rule on the same service. `dozzle` already
  // brings `socket-mount` — a second socket mount would then no longer be a new
  // finding and would go through without confirmation. The same for a second
  // bind outside the base path next to an existing one.
  //
  // With the detail (path, capability, missing limit) the key is as fine as
  // the violation itself: the same socket stays tolerated, a different path is
  // new.
  rules: readonly string[];
};

// A single finding as the string "service:rule — detail". That is also the
// format of the confirmation: a caller never confirms "the hardening" but
// always a concrete violation on a concrete service.
export function violationKey(serviceName: string, rule: string): string {
  return `${serviceName}:${rule}`;
}

export function violationList(violations: readonly ServiceViolations[]): string[] {
  const keys = new Set<string>();
  for (const entry of violations) {
    for (const rule of entry.rules) keys.add(violationKey(entry.serviceName, rule));
  }
  return [...keys].sort();
}

// What is violated after the edit and was not violated before.
//
// A service that did not exist before necessarily brings nothing but new
// violations — and that is right: on a newly introduced container every
// violation is new, even if the same rule is already violated elsewhere in the
// stack. Otherwise "put a second service with docker.sock next to it" would be
// covered by the existing dozzle violation.
export function newViolations(
  before: readonly ServiceViolations[],
  after: readonly ServiceViolations[]
): string[] {
  const previous = new Set(violationList(before));
  return violationList(after).filter((keys) => !previous.has(keys));
}
