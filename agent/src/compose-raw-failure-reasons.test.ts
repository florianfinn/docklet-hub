import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

import {
  COMPOSE_RAW_APPLY_FAILURE_REASONS,
  COMPOSE_RAW_CHECK_FAILURE_REASONS,
  COMPOSE_RAW_FAILURE_REASONS,
  COMPOSE_RAW_FILE_FAILURE_REASONS,
  COMPOSE_RAW_GATE_FAILURE_REASONS,
  COMPOSE_RAW_PLAN_FAILURE_REASONS,
  COMPOSE_RAW_PREVIEW_FAILURE_REASONS,
  COMPOSE_RAW_STREAM_FAILURE_REASONS
} from "contract";
import { handlerSource } from "./handler-source-test-support.js";

// Guard over the error keys of the raw editor (#89).
//
// ⚠️ The reason this file exists lies in the opposite direction.
//
// That no unknown key COMES INTO BEING is checked by the compiler: `rawReason()`
// in runtime/raw-ops.ts and the return types in raw-apply.ts take exactly the
// set from compose-raw-failure-reasons.ts. What it does NOT check is whether
// the list still describes reality — a key that exists nowhere any more does
// not bother it, and a throw site that never takes the path through
// `rawReason()` in the first place it never looks at.
//
// Exactly there the list would be worse than none: it would look as if it
// were correct. The hub compares against it and would stay green.
const source = handlerSource();
const applySource = fs.readFileSync(new URL("./raw-apply.ts", import.meta.url), "utf8");
const storeSource = fs.readFileSync(new URL("./compose-store.ts", import.meta.url), "utf8");

// The body of a top-level function: up to the first closing brace at the
// start of a line. Everything nested is indented.
function bodyOf(name: string): string {
  const start = source.indexOf(`async function ${name}(`);
  assert.ok(start >= 0, `${name} is no longer in the handler sources (routes/, runtime/, index.ts)`);
  const end = source.indexOf("\n}\n", start);
  assert.ok(end > start, `the end of ${name} cannot be found`);
  return source.slice(start, end);
}

// All places where a response of these routes comes into being. They are
// listed here by name and not as "the handler sources as a whole": a throw
// site that is newly added belongs in one of them — and if not, that is
// exactly the decision someone is supposed to make explicitly.
function throwSites(): [string, string][] {
  return [
    ["executeRawWithoutLock", bodyOf("executeRawWithoutLock")],
    ["executeRaw", bodyOf("executeRaw")],
    ["previewRaw", bodyOf("previewRaw")],
    ["the branch of the three container routes", bodyOf("handleComposeRaw")],
    ["POST /stacks/raw", bodyOf("handleStackRaw")]
  ];
}

test("the list is the sum of its parts", () => {
  assert.deepEqual(
    [...COMPOSE_RAW_FAILURE_REASONS],
    [
      ...COMPOSE_RAW_GATE_FAILURE_REASONS,
      ...COMPOSE_RAW_CHECK_FAILURE_REASONS,
      ...COMPOSE_RAW_APPLY_FAILURE_REASONS,
      ...COMPOSE_RAW_STREAM_FAILURE_REASONS
    ]
  );
  // No key is in two subsets. Otherwise it would count twice, and "this set
  // here is exactly that set there" would no longer be available to the
  // caller.
  assert.equal(
    new Set(COMPOSE_RAW_FAILURE_REASONS).size,
    COMPOSE_RAW_FAILURE_REASONS.length,
    "a key is in more than one subset"
  );
  // The nested subsets really are subsets — they are written exactly once
  // and passed on, not copied.
  for (const [name, subset, superset] of [
    ["the plan reasons", COMPOSE_RAW_PLAN_FAILURE_REASONS, COMPOSE_RAW_PREVIEW_FAILURE_REASONS],
    ["the preview reasons", COMPOSE_RAW_PREVIEW_FAILURE_REASONS, COMPOSE_RAW_CHECK_FAILURE_REASONS],
    ["the file reasons", COMPOSE_RAW_FILE_FAILURE_REASONS, COMPOSE_RAW_APPLY_FAILURE_REASONS]
  ] as [string, readonly string[], readonly string[]][]) {
    for (const reason of subset) {
      assert.ok(superset.includes(reason), `${name}: ${reason} is missing from the enclosing set`);
    }
  }
});

test("every key of the list occurs at a throw site", () => {
  // ⚠️ The direction the compiler does not know. Without it the list grows
  // beyond the actual code: a removed branch leaves behind a key that the
  // caller keeps translating and never sees again.
  //
  // The search covers the whole source text and not only the branches above:
  // `stack-busy` comes into being in the common error handler from the
  // KeyedMutexBusyError, `file-changed-externally` and `file-already-exists`
  // in compose-store.ts.
  const haystack = `${source}\n${applySource}\n${storeSource}`;
  for (const reason of COMPOSE_RAW_FAILURE_REASONS) {
    assert.ok(
      haystack.includes(`"${reason}"`),
      `${reason} is in the list, but at no throw site — the list no longer describes the actual code`
    );
  }
});

test("no throw site writes its key out freely", () => {
  // ⚠️ The guard over the guard. `rawReason()` only checks what goes through
  // `rawReason()` — a line that writes the key out directly bypasses the list
  // completely and is otherwise noticed by nobody.
  for (const [name, region] of throwSites()) {
    const free = [...region.matchAll(/error: "([^"]+)"/g)].map((match) => match[1]);
    assert.deepEqual(
      free,
      [],
      `${name}: the key is written freely in the line instead of in the list (rawReason)`
    );
  }
});

test("whatever goes through rawReason is also in the list", () => {
  // The compiler says the same — but it only says it as long as someone runs
  // `pnpm run lint`. The test says it on every `pnpm test`, and it names the
  // key while doing so.
  const used = [...source.matchAll(/rawReason\("([^"]+)"\)/g)].map((match) => match[1]);
  assert.ok(used.length > 0, "rawReason() is no longer used anywhere");
  for (const reason of used) {
    assert.ok(
      (COMPOSE_RAW_FAILURE_REASONS as readonly string[]).includes(reason),
      `${reason} goes through rawReason(), but is not in the list`
    );
  }
});

test("the reasons of both phases come from the list and not from a string", () => {
  // ⚠️ Without this promise the list in raw-apply.ts would be ineffective: a
  // `reason: string` accepts every typo, and the caller would get it.
  // Both types sit on the return types, not on an assignment somewhere in the
  // body — otherwise they would only cover the one branch where they
  // stand.
  assert.match(applySource, /\| \{ ok: false; reason: ComposeRawPlanFailureReason; detail\?: string \};/);
  assert.match(applySource, /^ {6}reason: ComposeRawApplyFailureReason;$/m);
  assert.equal(
    /reason: string/.test(applySource),
    false,
    "raw-apply.ts once again has a free string as a reason"
  );
});

test("the 24 from the changelog for v0.22.0 can be recounted", () => {
  // ⚠️ The number is in the changelog, in route-policy.ts and in
  // raw-stream.test.ts — and it is the only figure with which an outsider can
  // check their translation for completeness. A claimed number would be
  // worthless for that.
  //
  // What is counted there are the keys of APPLYING AT THE ANCHOR (POST
  // /containers/:id/compose-raw). It lacks exactly five of the whole set,
  // each for a nameable reason.
  const notAtTheAnchor = [
    // Only on creation (POST /stacks/raw): there is no directory and no file
    // there yet.
    "directory-taken",
    "file-already-exists",
    // Only on the stream (POST /containers/:id/compose-raw-stream).
    "too-many-streams",
    "compose-raw-failed",
    // Reachable on none of the routes: the route table binds them internal-only,
    // the branch exists only for the type promise.
    "tier-missing",
    // Only #102 passed the three anchor reasons through to this route.
    // The historical number for v0.22.0 does not count these later reasons.
    "compose-anchor-labels-missing",
    "compose-anchor-outside-base-path",
    "compose-anchor-file-ambiguous"
  ];
  const atTheAnchor = COMPOSE_RAW_FAILURE_REASONS.filter(
    (reason) => !notAtTheAnchor.includes(reason)
  );
  assert.equal(atTheAnchor.length, 24);
  // The two ends that the changelog names explicitly.
  assert.ok(atTheAnchor.includes("confirmation-missing"));
  assert.ok(atTheAnchor.includes("hardening-newly-violated"));
});
