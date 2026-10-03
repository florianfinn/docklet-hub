import {
  EngineError
} from "../engine.js";
import {
  selfCheckViolations
} from "../hardening.js";
import { parseImageRef } from "../image-ref.js";
import {
  composeConfig,
  composeDown,
  composePs,
  composeUp,
  ownProject
} from "../compose-cli.js";
import { type ApplyOps } from "../compose-apply.js";
import {
  hasComposeFile,
  readComposeFile
} from "../compose-store.js";
import type { ComposeConfirmations, ComposeRawFailureReason } from "contract";
import {
  checkConfirmation,
  validateRawContent,
  violationList,
  type ServiceViolations
} from "../compose-raw.js";
import {
  executeRawApply,
  inspectRawApply,
  planFromInspection,
  planRawApply,
  reportedTo,
  type RawApplyOps,
  type RawLocation,
  type RawStepSink
} from "../raw-apply.js";
import { engine, registry, audit, stackLocks } from "./state.js";
import {
  composeBasePath,
  hardeningOptionsFor,
  inspectedContainer,
  resolveFullContainerId
} from "./containers.js";
import { AgentTier } from "./http.js";

// applyCompose runs exclusively for stacks whose file the dashboard writes
// itself — hence ownProject() and removeOrphans: true throughout.
// For adopted stacks this path does not exist at all (stage 5d).
export const applyOps: ApplyOps = {
  up: (projectDir) => composeUp(ownProject(projectDir), { removeOrphans: true }),
  down: (projectDir) => composeDown(ownProject(projectDir)),
  resolveContainerId: (projectDir, serviceName) =>
    resolveFullContainerId(ownProject(projectDir), serviceName),
  // ⚠️ Self-check, not operating rule (S9): applyCompose runs exclusively for
  // stacks that the dashboard writes ITSELF from a validated spec. There
  // "everything except notice" is the right yardstick — the relaxation from §4
  // applies to the existing inventory, not to what we are generating right now.
  async blockingViolations(containerId: string): Promise<string[]> {
    const inspect = await engine.inspect(containerId);
    return [
      ...new Set(
        selfCheckViolations(
          await inspectedContainer(inspect),
          hardeningOptionsFor(containerId)
        ).map((violation) => violation.rule)
      )
    ];
  },
  async runState(containerId: string) {
    const inspect = await engine.inspect(containerId);
    return {
      running: inspect.State?.Running === true,
      restarting: inspect.State?.Restarting === true,
      exitCode: inspect.State?.ExitCode ?? 0
    };
  }
};

// The bridge for the raw editor (stage 7). Separate from applyOps because the
// two differ in exactly the places where it counts:
//
//   * ownProject() vs. the carried-along file name — the raw editor explicitly
//     works on adopted files too (compose.yaml, docker-compose.yml,
//     docker-compose.yaml).
//   * removeOrphans: false — for an adopted file it would be data loss
//     (stage 5d).
//   * pullNever: true — a pasted file carries no `pull_policy: never`, and
//     foreign code should not reach the host as a side effect of a text edit.
export const rawOps: RawApplyOps = {
  config: (projectDir, composeFileName, projectName) =>
    composeConfig({ projectDir, composeFileName, projectName }),

  // ⚠️ Full ids, never the short ones from `compose ps` (the same trap for the
  // third time — see 5c and 5d). The allowlist, the grants and the audit log
  // all speak the full form.
  async containerIds(location) {
    // A brand-new stack (POST /stacks/raw) has no Compose file yet before the
    // first `up` — but planRawApply/executeRawApply already query the running
    // containers in the check phase. `compose ps` then fails on the missing
    // file ("no such file or directory") and used to tear down the whole create
    // operation with a 500. Without a file there can be no running container of
    // this project: empty set instead of an error.
    if (!hasComposeFile(location.projectDir, location.composeFileName)) {
      return new Map<string, string>();
    }
    const entries = await composePs(location);
    const ids = new Map<string, string>();
    for (const entry of entries) {
      if (!entry.Service || !entry.ID) continue;
      try {
        ids.set(entry.Service, (await engine.inspect(entry.ID)).Id);
      } catch (error) {
        // A container that has disappeared in the meantime must not topple the
        // survey; it is then simply missing from the map.
        if (error instanceof EngineError && error.status === 404) continue;
        throw error;
      }
    }
    return ids;
  },

  up: (location) => composeUp(location, { removeOrphans: false, pullNever: true }),

  async down(location) {
    await composeDown(location);
  },

  async removeContainer(containerId) {
    // Stop first, then remove: for databases the difference between a clean
    // shutdown and a recovery.
    try {
      await engine.stop(containerId);
    } catch (error) {
      // An already stopped container is not an error.
      if (!(error instanceof EngineError)) throw error;
    }
    await engine.remove(containerId, { force: true });
  },

  // ⚠️ Rule name AND detail, not the deduplicated rule name (self-check
  // 2026-07-21).
  //
  // hardeningRuleNames() deduplicates on purpose — for display, "twice
  // dangerous-capability" is one entry. For the before/after comparison exactly
  // this deduplication would be a hole: `dozzle` already brings `socket-mount`
  // along, and a SECOND socket mount on the same service would then no longer
  // be a new finding. The detail names the concrete path or capability and
  // makes the comparison as fine-grained as the violation.
  //
  // ⚠️ S9: the yardstick is `selfCheckViolations` (delegation lock + warning),
  // no longer the old "blocking" set. A `device-passthrough` or a neighbour
  // mount NEWLY introduced in the raw editor thus needs no confirmation — that
  // is exactly the usability §4 is meant to establish. A new docker.sock, a
  // `privileged` or a mount on /etc still requires the typed confirmation.
  async violationsOf(containerId) {
    const inspect = await engine.inspect(containerId);
    const violations = selfCheckViolations(
      await inspectedContainer(inspect),
      hardeningOptionsFor(containerId)
    );
    // ⚠️ For the bind-derived rules the normalised HOST PATH is the key, not the
    // full `detail`. Otherwise the same docker.sock counts as "new" as soon as
    // only its notation changes (target path, :ro, a different Compose/Docker
    // version on recreate) — and exactly that would have made an adopted stack
    // with docker.sock fail in the raw editor, although it already had the
    // socket before. Two DIFFERENT host paths stay two keys; a second bind at a
    // different danger spot is thus still detected. Rules without hostPath
    // (capability, namespace, …) keep their fine-grained `detail`.
    return violations.map((violation) => `${violation.rule} — ${violation.hostPath ?? violation.detail}`);
  },

  async runState(containerId) {
    const inspect = await engine.inspect(containerId);
    return {
      running: inspect.State?.Running === true,
      restarting: inspect.State?.Restarting === true
    };
  },

  async missingImages(refs) {
    const missing: string[] = [];
    for (const ref of refs) {
      const parsed = parseImageRef(ref);
      // An unreadable ref counts as missing: it should be named and not
      // silently count as present.
      if (!parsed) {
        missing.push(ref);
        continue;
      }
      if (!(await engine.imageId(parsed.fullRef))) missing.push(ref);
    }
    return missing;
  }
};

// An error key of the raw editor, checked against the list (#89).
//
// They are contract: the caller translates each one individually into a
// question that can be answered. Until #89 they came into being as free
// strings at their throw sites — a typo reached the caller as an unknown key,
// and a new line here went unnoticed there, because there was no set it could
// have compared against.
//
// ⚠️ The wrapper deliberately does nothing. The wording should stay at the
// throw site — a constant per key would have put an English identifier in
// front of a German value on every line and made the response unreadable.
// What it contributes is the type promise: `rawReason` takes EXACTLY the set
// from contract/src/agent/compose-reasons.ts.
export function rawReason(reason: ComposeRawFailureReason): ComposeRawFailureReason {
  return reason;
}

// The shared flow behind both writing raw routes (stage 7).
//
// Editing and creating are THE SAME operation with a different starting state:
// when creating, the set of existing services is empty and the expected hash
// is null. A separate create path would be a second lane next to the same
// controls — exactly the failure shape that 5d produced four times.
export type RawExecution = {
  location: RawLocation;
  content: string;
  expectedHash: string | null;
  currentServices: string[];
  // The answers to the follow-up questions, already checked against
  // `composeRawWriteRequestSchema` (contract).
  confirmations: ComposeConfirmations;
  actor: string | null;
  tier: AgentTier;
  // For the audit log: when creating there is no container yet.
  containerId: string | null;
  stackName: string;
  // Who is listening in (#86). The synchronous path does not set it and thus
  // runs character for character as before.
  onStep?: RawStepSink;
};

export async function executeRawWithoutLock(
  operation: RawExecution
): Promise<{ status: number; body: Record<string, unknown> }> {
  const { location, confirmations, actor, tier } = operation;
  const report = reportedTo(operation.onStep);

  const auditEntry = (outcome: "allowed" | "denied" | "error", reason: string): void => {
    audit.write({
      action: "compose-raw",
      containerId: operation.containerId,
      containerName: operation.stackName,
      actor,
      networkTier: tier,
      outcome,
      reason
    });
  };

  const contentError = validateRawContent(operation.content);
  if (contentError.length > 0) {
    auditEntry("denied", `invalid-content: ${contentError.join("; ")}`);
    return { status: 400, body: { error: rawReason("invalid-content"), errors: contentError } };
  }

  // Phase 1: check without touching anything real.
  //
  // One step, three calls: `docker compose config` on the draft (deadline 30 s),
  // then the image inventory and the hardening of the current state. It does
  // not report at a finer grain because `inspectRawApply` reaches its finding
  // as a whole — a subdivision here would be an invention and not a reading.
  report("check");
  const plan = await planRawApply(rawOps, {
    location,
    content: operation.content,
    basePath: composeBasePath,
    currentServices: operation.currentServices
  });
  if (!plan.ok) {
    auditEntry("denied", plan.reason);
    return {
      status: 400,
      body: { error: plan.reason, ...(plan.detail ? { detail: plan.detail } : {}) }
    };
  }

  // The permission question. A service that did not exist before has neither
  // an allowlist entry nor a grant — it must not come into being as a side
  // effect of a text change. The response NAMES what needs to be decided
  // instead of merely rejecting: the same request with the list goes through.
  report("confirmations");
  const newChecked = checkConfirmation(plan.diff.new, confirmations.confirmNew);
  const removedChecked = checkConfirmation(
    plan.diff.removed,
    confirmations.confirmRemoved
  );
  if (!newChecked.ok || !removedChecked.ok) {
    auditEntry(
      "denied",
      `service-confirmation-missing: new=${plan.diff.new.join(",")} removed=${plan.diff.removed.join(",")}`
    );
    return {
      status: 409,
      body: {
        error: rawReason("service-confirmation-missing"),
        diff: plan.diff,
        new: newChecked,
        removed: removedChecked
      }
    };
  }

  // Missing images. The `--pull never` bolt would make the `up` fail anyway;
  // here that becomes a named decision instead of an opaque Compose error
  // message.
  //
  // ⚠️ The pull itself remains an explicit, individually logged step (stage
  // plan 3.6) — it is the moment in which foreign code reaches the host.
  if (plan.missingImages.length > 0) {
    const pullChecked = checkConfirmation(plan.missingImages, confirmations.acknowledgeImagePull);
    if (!pullChecked.ok) {
      auditEntry("denied", `image-not-local: ${plan.missingImages.join(",")}`);
      return {
        status: 409,
        body: {
          error: rawReason("image-not-local"),
          missingImages: plan.missingImages,
          pull: pullChecked
        }
      };
    }
    for (const ref of plan.missingImages) {
      const parsed = parseImageRef(ref);
      if (!parsed) {
        auditEntry("denied", `image-ref-unreadable: ${ref}`);
        return { status: 400, body: { error: rawReason("image-ref-unreadable"), ref } };
      }
      audit.write({
        action: "compose-raw-pull",
        containerId: operation.containerId,
        containerName: operation.stackName,
        actor,
        networkTier: tier,
        outcome: "allowed",
        reason: parsed.fullRef
      });
      // The only step without any deadline — an image can be arbitrarily large.
      // That is why it is the only one carrying the ref in `detail`: with several
      // missing images it would otherwise not be clear which one it is stuck on.
      report("pull-images", parsed.fullRef);
      await engine.pull(parsed);
    }
  }

  auditEntry(
    "allowed",
    `${location.projectDir}/${location.composeFileName}: remaining=${plan.diff.remaining.join(",")} ` +
      `new=${plan.diff.new.join(",")} removed=${plan.diff.removed.join(",")}`
  );

  // Phase 2: execute.
  const result = await executeRawApply(rawOps, {
    location,
    content: operation.content,
    basePath: composeBasePath,
    expectedHash: operation.expectedHash,
    plan,
    acceptedViolations: confirmations.acknowledgeHardening,
    onStep: operation.onStep
  });

  if (!result.ok) {
    audit.write({
      action: "compose-raw-failed",
      containerId: operation.containerId,
      containerName: operation.stackName,
      actor,
      networkTier: tier,
      outcome: "error",
      reason: `${result.reason} (rolled back: ${result.rolledBack})${
        result.newViolations ? `: ${result.newViolations.join(",")}` : ""
      }`
    });
    return {
      status: 409,
      body: {
        error: result.reason,
        rolledBack: result.rolledBack,
        ...(result.detail ? { detail: result.detail } : {}),
        ...(result.newViolations ? { newViolations: result.newViolations } : {}),
        // Only set for "file-changed-externally" (§13.4) — the conflict dialog
        // in the editor needs the actual hash to offer "my version"/"file".
        ...(result.actualHash !== undefined ? { actualHash: result.actualHash } : {}),
        projectDir: location.projectDir
      }
    };
  }

  // The container NAMES as well. The main API needs them to create allowlist
  // rows for newly created services — without names an entry would come about
  // there that would be nameless in the audit log and in every UI.
  // What is read is the actual state, not the service name: `container_name`
  // in the file can differ from it (in the existing inventory it almost
  // always does).
  const containerNames: Record<string, string> = {};
  for (const [serviceName, id] of Object.entries(result.containerIds)) {
    try {
      containerNames[serviceName] = ((await engine.inspect(id)).Name ?? "").replace(/^\//, "");
    } catch {
      // If a name is missing, it is missing — better than a guessed one.
    }
  }

  audit.write({
    action: "compose-raw-done",
    containerId: operation.containerId,
    containerName: operation.stackName,
    actor,
    networkTier: tier,
    outcome: "allowed",
    reason: `${location.projectDir}: ${Object.keys(result.containerIds).join(",")}`
  });

  return {
    status: 200,
    body: {
      ok: true,
      projectDir: location.projectDir,
      composeFileName: location.composeFileName,
      composeHash: result.composeHash,
      services: plan.services,
      diff: plan.diff,
      containerIds: result.containerIds,
      containerNames,
      removedContainerIds: result.removedContainerIds,
      // Named honestly: created does not mean running (lesson from 5c).
      running: result.running,
      restartLooping: result.restartLooping,
      imagesByService: plan.imagesByService
    }
  };
}

// Existing stacks carry the real project name, which may differ from the
// directory name, in the agent registry. New stacks use the validated name
// their directory is also derived from. This way the raw editor shares exactly
// the same lock as the S11 stack actions.
//
// Preview and apply take it from THIS function, not each from a line of its
// own: two computations for the same key would be two locks, and two locks are
// none.
export function rawLockKey(operation: {
  location: RawLocation;
  containerId: string | null;
  stackName: string;
}): string {
  const projectName = operation.location.projectName ?? (operation.containerId
    ? registry.get(operation.containerId)?.compose?.projectName
    : operation.stackName);
  return projectName || `project-dir:${operation.location.projectDir}`;
}

export async function executeRaw(
  operation: RawExecution & {
    // Called as soon as the project lock is held — and only then (#86).
    //
    // ⚠️ This is the seam at which the observable path sends its first line,
    // and its position is not a matter of taste. Before the lock the answer
    // is still available as an HTTP STATUS: if the stack is currently busy,
    // `runExclusive` throws a KeyedMutexBusyError, which the outer error
    // handler translates into the same `409 stack-busy` that the
    // synchronous path delivers. If the header went out earlier, this would
    // turn into a stream with a start line and no result — the caller would
    // get its only named reason as silence.
    onLocked?: () => void;
  }
): Promise<{ status: number; body: Record<string, unknown> }> {
  return stackLocks.runExclusive(rawLockKey(operation), async () => {
    operation.onLocked?.();
    if (operation.containerId && !registry.isAllowed(operation.containerId)) {
      audit.write({
        action: "compose-raw",
        containerId: operation.containerId,
        containerName: operation.stackName,
        actor: operation.actor,
        networkTier: operation.tier,
        outcome: "denied",
        reason: "stack-anchor-stale"
      });
      return { status: 409, body: { error: rawReason("stack-anchor-stale") } };
    }
    // The route has already read this set for permission/dialog purposes.
    // Under the shared project lock it is surveyed fresh once more, so that a
    // stack apply immediately before does not trigger a stale diff.
    const currentServices = [...(await rawOps.containerIds(operation.location)).keys()].sort();
    return executeRawWithoutLock({ ...operation, currentServices });
  });
}

// What is already violated on the RUNNING containers of a stack right now.
//
// It depends not on the draft but on the existing inventory — that is why it
// lives here and not in the check chain: the read response and the dry run
// need the same list, and a second survey next to it would be a second
// interpretation of the same question.
export async function inventoryViolationsOf(running: ReadonlyMap<string, string>): Promise<string[]> {
  const inventory: ServiceViolations[] = [];
  for (const [serviceName, id] of running) {
    try {
      inventory.push({ serviceName, rules: await rawOps.violationsOf(id) });
    } catch {
      // A container that cannot be inspected delivers no list.
    }
  }
  return violationList(inventory);
}

// The dry run for the same flow (#85).
//
// It runs EXACTLY the phase 1 check chain and writes nothing real in doing so:
// the same `inspectRawApply` from which `planRawApply` draws its verdict —
// except that here the finding is the RESPONSE and not the reason for an abort.
//
// Why it exists: of the five questions the apply asks, a caller fundamentally
// cannot answer two by itself. Which images are missing on the host is in no
// response of this agent; and what becomes of `extends`, `include`, profiles
// and `${VAR}` is known only to `docker compose config`. Until now the caller
// got both — as a `409` to an ATTEMPT. That is the same information, just as a
// failure afterwards instead of as an answer beforehand.
//
// ⚠️ The preview is NOT a guarantee. Between it and the apply the file can
// change (hence the actual hash in the response), an image can appear or
// disappear. It is the information the agent has at that same moment, and
// nothing beyond that.
//
// ⚠️ What it does NOT deliver is `newViolations`. `executeRawApply` measures
// those on the RUNNING containers after the `up` — so they only come into
// being after writing. A preview that promised them would have to start the
// stack. Instead `inventoryViolations` stands here: what is ALREADY violated
// now, the same list as in the read response.
export type RawPreviewOperation = {
  location: RawLocation;
  content: string;
  actor: string | null;
  tier: AgentTier;
  containerId: string;
  stackName: string;
};

export async function previewRaw(
  operation: RawPreviewOperation
): Promise<{ status: number; body: Record<string, unknown> }> {
  const { location, actor, tier } = operation;

  // ⚠️ Under THE SAME project lock as the apply, and not for tidiness: the
  // check stores the draft under a fixed name per project directory. If a
  // preview ran next to an apply, it would overwrite the apply's draft — and
  // `docker compose config` would then judge a text that is NOT written right
  // after. That would not be a display error but a check of the wrong object.
  return stackLocks.runExclusive(rawLockKey(operation), async () => {
    if (!registry.isAllowed(operation.containerId)) {
      return { status: 409, body: { error: rawReason("stack-anchor-stale") } };
    }

    // Fresh under the lock, for the same reason as with the apply: a stack apply
    // that ran immediately before would otherwise make the diff stale.
    const running = await rawOps.containerIds(location);
    const currentServices = [...running.keys()].sort();
    const file = readComposeFile(location.projectDir, location.composeFileName);

    const auditEntry = (reason: string): void => {
      audit.write({
        action: "compose-raw-preview",
        containerId: operation.containerId,
        containerName: operation.stackName,
        actor,
        networkTier: tier,
        outcome: "allowed",
        reason
      });
    };

    // The frame of the response. It is complete even when the draft is not
    // readable: a preview that leaves out half of its fields in the error case
    // forces the caller into two evaluations.
    const frame = {
      projectDir: location.projectDir,
      composeFileName: location.composeFileName,
      stackName: operation.stackName,
      // The actual hash. Exactly this one belongs in `expectedComposeHash` when
      // applying — if it differs from the one the caller got when reading,
      // someone wrote in between.
      composeHash: file.hash,
      // The actual state the diff runs against: the existing CONTAINERS, not
      // the services the old file names.
      currentServices
    };

    // ⚠️ An unusable draft is not an error here but the result. This route is
    // an INFORMATION route: it answers with 200 and `valid: false`, and `reason`
    // carries word for word the error with which applying the same draft would
    // abort. A status other than 200 therefore always means that the
    // information itself was not available (anchor stale, file missing) —
    // never that the draft is unusable.
    const contentErrors = validateRawContent(operation.content);
    if (contentErrors.length > 0) {
      auditEntry(`${location.projectDir}: invalid-content`);
      return {
        status: 200,
        body: {
          ...frame,
          valid: false,
          reason: rawReason("invalid-content"),
          errors: contentErrors,
          configError: null,
          services: null,
          diff: null,
          imagesByService: {},
          missingImages: null,
          servicesWithoutImage: [],
          // The inventory does not depend on the draft. An empty field here would
          // mean "nothing violated" — and that would be wrong, just because the
          // caller sent an unusable text.
          inventoryViolations: await inventoryViolationsOf(running)
        }
      };
    }

    const inspection = await inspectRawApply(rawOps, {
      location,
      content: operation.content,
      basePath: composeBasePath,
      currentServices
    });
    const plan = planFromInspection(inspection);

    auditEntry(
      `${location.projectDir}: ${plan.ok ? "valid" : plan.reason}` +
        (inspection.diff
          ? ` (new=${inspection.diff.new.join(",")} removed=${inspection.diff.removed.join(",")})`
          : "")
    );

    return {
      status: 200,
      body: {
        ...frame,
        // Word for word the decision that `planRawApply` reaches for this draft
        // — it comes from the same function and therefore cannot deviate from
        // it.
        valid: plan.ok,
        reason: plan.ok ? null : plan.reason,
        errors: [],
        configError: inspection.configError,
        services: inspection.services,
        diff: inspection.diff,
        imagesByService: inspection.imagesByService,
        // The answer to a question only the host can answer. When applying,
        // exactly these refs belong in `acknowledgeImagePull`.
        missingImages: inspection.missingImages,
        servicesWithoutImage: inspection.servicesWithoutImage,
        // What is ALREADY violated now. Not the violations this edit would
        // introduce — those are only measurable after the `up` (see above) and
        // are safeguarded there with a rollback.
        //
        // The check chain only surveys the inventory if it gets that far —
        // and it does exactly when its verdict is `ok`. Otherwise the inventory
        // is still there, because it depends on the running containers and not
        // on the draft. It is never surveyed twice.
        inventoryViolations: plan.ok
          ? violationList(inspection.violationsBefore)
          : await inventoryViolationsOf(running)
      }
    };
  });
}
