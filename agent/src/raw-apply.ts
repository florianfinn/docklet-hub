// The choreography around a hand-written Compose file (stage 7).
//
// Counterpart to compose-apply.ts, but with three differences that all have
// the same reason — here the CONTENT comes from the operator and not from a
// validated spec:
//
//  1. **The check happens before anything real is written.** The draft lands
//     under a name that Compose does not consider a project file and is read
//     by `docker compose config`. Only when a usable service list comes out of
//     it is the actual file touched.
//
//  2. **The service SET is a permission question.** An added service is a
//     container for which there can be neither an allowlist entry nor a grant.
//     It therefore only comes into being if the request names it explicitly.
//
//  3. **The hardening is collected before AND after.** Not "is the state
//     clean?" (the three inventory stacks never would be), but "does THIS edit
//     introduce something new?".
//
// As everywhere in this project: what is checked is the RUNNING container, not
// the file. A file can claim anything.

import type { ComposeApplyStep } from "contract";
import type {
  ComposeRawApplyFailureReason,
  ComposeRawPlanFailureReason,
  MountSource
} from "contract";
import {
  CANDIDATE_FILE_NAME,
  diffServices,
  newViolations,
  serviceNamesFromConfig,
  type ServiceDiff,
  type ServiceViolations
} from "./compose-raw.js";
import {
  removeCandidateFile,
  restoreRawComposeFile,
  writeCandidateFile,
  writeRawComposeFile
} from "./compose-store.js";
import { mountSourcesOf } from "./mount-sources.js";

export type RawLocation = {
  projectDir: string;
  composeFileName: string;
  // S11: fixed Compose project name. Optional only for old/unit-test ops;
  // productive raw routes set it from the agent registry or from the
  // validated name of a new stack.
  projectName?: string;
};

export type RawApplyOps = {
  // `docker compose config` against a specific file in the project directory.
  config(projectDir: string, composeFileName: string, projectName?: string): Promise<unknown>;
  // Which containers currently belong to which service of this project.
  containerIds(location: RawLocation): Promise<Map<string, string>>;
  up(location: RawLocation): Promise<string>;
  down(location: RawLocation): Promise<void>;
  // Stops and removes a container. For services that have disappeared from the
  // file — `docker compose` no longer knows them afterwards, so the path goes
  // through the engine and not through `compose rm`.
  removeContainer(containerId: string): Promise<void>;
  // Blocking hardening violations of the RUNNING container, each as
  // "rule — detail" (see ServiceViolations: the rule name alone would mask a
  // second violation of the same rule).
  violationsOf(containerId: string): Promise<string[]>;
  runState(containerId: string): Promise<{ running: boolean; restarting: boolean }>;
  // Which of the given image refs are NOT present locally.
  missingImages(refs: readonly string[]): Promise<string[]>;
};

// --- The running report (#86) ----------------------------------------------

// The steps this flow goes through.
//
// They are not invented but read off: every value stands for exactly one call
// further down. Three of them have a timeout — `config` and `ps` 30 s each,
// `up` 300 s —, pulling an image has none at all, and a rollback runs
// `up`/`down` a second time with the same timeouts. The worst provable case is
// thus beyond ten minutes.
//
// ⚠️ Until #86 NOT A SINGLE byte went to the caller over this whole stretch.
// It could not tell whether something was being pulled, started or rolled
// back, whether it hung or whether the connection was dead — and therefore had
// to set its timeout against the worst conceivable case instead of against a
// signal.
//
// Since #272 the steps are `composeApplyStepSchema` in the shared contract
// (`contract/src/agent/streams.ts`), with what each one means.
export type RawStep = ComposeApplyStep;

// Where a step is reported to. `detail` names the concrete subject where there
// is one.
export type RawStepSink = (step: RawStep, detail?: string) => void;

// ⚠️ An observer must not be able to topple the operation it is watching.
//
// That is the most dangerous spot of this extension. The reporter writes into
// an HTTP response, and that hangs on a connection that can be gone at any
// time. If it threw — today or after the next change to `sendLine` — the
// exception would fly right out of `executeRawApply`. Between writing the file
// and the `up` that would mean: the new Compose file is in place, the stack is
// not running, and the rollback does not happen — a state this module
// carefully avoids everywhere else.
//
// That is why EVERY report goes through this wrapper instead of each call site
// carrying its own try/catch: a spot that can be forgotten is exactly the one
// that will be forgotten.
export function reportedTo(sink: RawStepSink | undefined): RawStepSink {
  if (!sink) return () => {};
  return (step, detail) => {
    try {
      sink(step, detail);
    } catch {
      // The operation continues. Whoever stopped listening does not stop it.
    }
  };
}

// --- Phase 1: check without touching anything ------------------------------

// What the phase 1 check chain finds out about a draft — complete and without
// a verdict.
//
// ⚠️ Separate from `RawPlan`, but not ALONGSIDE it: `planRawApply` bases its
// verdict exclusively on this finding, and the preview (#85) shows exactly the
// same finding without turning it into an abort. A preview with its own
// calculation would be a second track next to the same controls — the failure
// mode this module is written against: it would drift apart as soon as a step
// is added here, and silently.
export type RawInspection = {
  // `docker compose config` did not read the draft. The reason is in
  // `configError` IF there was one to capture — hence two fields: a failure
  // without a message is something different from no failure.
  configFailed: boolean;
  configError: string | null;
  // The service names of the normalized output. null means: the output names
  // not a single one (or was not even read).
  services: string[] | null;
  imagesByService: Record<string, string>;
  // Services the file names without an image. They cannot start, and otherwise
  // that would only show up at the `up`.
  servicesWithoutImage: string[];
  // From here on only filled if the file names any services at all: without
  // them there is nothing to compare and nothing to pull.
  diff: ServiceDiff | null;
  missingImages: string[] | null;
  violationsBefore: ServiceViolations[];
  mountSources: MountSource[];
};

export async function inspectRawApply(
  ops: RawApplyOps,
  options: {
    location: RawLocation;
    content: string;
    basePath: string;
    // The services that exist NOW. Empty for a new stack.
    currentServices: readonly string[];
  }
): Promise<RawInspection> {
  const { location, basePath } = options;

  // The draft is stored, read and removed again in EVERY case — even if
  // `compose config` throws. A leftover draft would not be a project file for
  // Compose (hence its own name), but it would sit in the directory with the
  // content of a refused edit.
  //
  // ⚠️ It has ONE name per project directory. Two runs at the same time in the
  // same directory would overwrite the draft under each other's feet — one
  // would then check the other's text. That is why preview and apply both run
  // under the project lock (src/runtime/raw-ops.ts).
  let normalized: unknown;
  let configFailed = false;
  let configError: string | null = null;
  try {
    writeCandidateFile(location.projectDir, options.content, basePath);
    normalized = await ops.config(location.projectDir, CANDIDATE_FILE_NAME, location.projectName);
  } catch {
    configFailed = true;
    configError = "compose-config-failed";
  } finally {
    try {
      removeCandidateFile(location.projectDir);
    } catch {
      // A draft that cannot be deleted is no reason to topple the edit — the
      // actual operation does not depend on it.
    }
  }

  const services = configFailed ? null : serviceNamesFromConfig(normalized);
  const imagesByService = services ? imagesOf(normalized, services) : {};
  const servicesWithoutImage = (services ?? []).filter((name) => !imagesByService[name]);
  // The comparison of the service SETS is a pure calculation. It costs no call
  // and is therefore present even if the draft is refused right away — the
  // preview can show it without anyone paying for it.
  const diff = services ? diffServices(options.currentServices, services) : null;
  const mountSources = services ? mountSourcesOf(normalized, services, location.projectDir) : [];

  // ⚠️ From here on calls go against Compose and the engine, and from here on
  // the finding stops exactly where the verdict no longer needs it.
  //
  // That is not thrift but the condition for this split not touching the apply
  // path: `ops.missingImages` runs `engine.imageId` and throws on every engine
  // error except 404. If it ran before the refusal "service-without-image", the
  // caller would get an exception in the error case instead of the named 400 it
  // got before — a narrow but real change of behaviour on a path that should
  // not change.
  if (!services || servicesWithoutImage.length > 0) {
    return {
      configFailed,
      configError,
      services,
      imagesByService,
      servicesWithoutImage,
      diff,
      // Not collected because the draft already fails before — not "none".
      // What it fails on is said by the verdict (planFromInspection).
      missingImages: null,
      violationsBefore: [],
      mountSources
    };
  }

  const missingImages = await ops.missingImages([...new Set(Object.values(imagesByService))]);

  // The before state of the hardening. It is collected NOW, while the old file
  // is still in place — afterwards the old containers would no longer exist.
  const violationsBefore = await violationsOf(ops, await ops.containerIds(location));

  return {
    configFailed,
    configError,
    services,
    imagesByService,
    servicesWithoutImage,
    diff,
    missingImages,
    violationsBefore,
    mountSources
  };
}

export type RawPlan =
  | {
      ok: true;
      services: string[];
      diff: ServiceDiff;
      imagesByService: Record<string, string>;
      missingImages: string[];
      violationsBefore: ServiceViolations[];
      mountSources: MountSource[];
    }
  // The reasons are listed as a set in contract/src/agent/compose-reasons.ts (#89):
  // they are contract — the caller translates each one into a follow-up
  // question — and a bare `string` here let every typo through.
  | { ok: false; reason: ComposeRawPlanFailureReason; detail?: string };

// The verdict on the finding. It is here and not in the finding itself because
// the preview needs the same finding without it becoming an abort.
export function planFromInspection(inspection: RawInspection): RawPlan {
  if (inspection.configFailed) {
    return {
      ok: false,
      reason: "invalid-compose-file",
      ...(inspection.configError === null ? {} : { detail: inspection.configError })
    };
  }
  if (!inspection.services) return { ok: false, reason: "no-services" };
  // A service without an image cannot start. Otherwise that would only show up
  // at the `up`, and by then the file is already in place.
  //
  // ⚠️ The order is that of the old, undivided `planRawApply` and not a matter
  // of taste: it decides which reason a draft gets that carries several errors
  // at once.
  if (inspection.servicesWithoutImage.length > 0) {
    return {
      ok: false,
      reason: "service-without-image",
      detail: inspection.servicesWithoutImage.join(", ")
    };
  }
  // Unreachable: as soon as there are services and each carries an image,
  // inspectRawApply has filled both fields. The branch is there for the type
  // guarantee — and a guarantee that consists of an assumption is none. The
  // direction is the safe one: when in doubt, refused.
  if (!inspection.diff || !inspection.missingImages) {
    return { ok: false, reason: "no-services" };
  }
  return {
    ok: true,
    services: inspection.services,
    diff: inspection.diff,
    imagesByService: inspection.imagesByService,
    missingImages: inspection.missingImages,
    violationsBefore: inspection.violationsBefore,
    mountSources: inspection.mountSources
  };
}

export async function planRawApply(
  ops: RawApplyOps,
  options: {
    location: RawLocation;
    content: string;
    basePath: string;
    // The services that exist NOW. Empty for a new stack.
    currentServices: readonly string[];
  }
): Promise<RawPlan> {
  return planFromInspection(await inspectRawApply(ops, options));
}

// --- Phase 2: execute ------------------------------------------------------

export type RawApplyOutcome =
  | {
      ok: true;
      composeHash: string;
      // Per service, the id of the container that now belongs to it.
      containerIds: Record<string, string>;
      removedContainerIds: string[];
      // Created does not mean running (lesson from 5c).
      running: string[];
      restartLooping: string[];
    }
  | {
      ok: false;
      // As with RawPlan: from the list, not from the line (#89).
      reason: ComposeRawApplyFailureReason;
      rolledBack: boolean;
      detail?: string;
      newViolations?: string[];
      // Only for "file-changed-externally": the hash of the current state, so that
      // the caller can resolve the conflict (§13.4) instead of only learning
      // "did not work".
      actualHash?: string | null;
    };

export async function executeRawApply(
  ops: RawApplyOps,
  options: {
    location: RawLocation;
    content: string;
    basePath: string;
    // null = create (there must not be a file yet).
    expectedHash: string | null;
    plan: Extract<RawPlan, { ok: true }>;
    // Already checked: exactly the newly introduced violations that the caller
    // explicitly accepts.
    acceptedViolations: readonly string[];
    // Who is reading along (#86). If missing, the operation runs silently —
    // exactly as before.
    onStep?: RawStepSink;
  }
): Promise<RawApplyOutcome> {
  const { location, plan, basePath } = options;
  const report = reportedTo(options.onStep);

  // The containers of the services that disappear — remember them NOW, while
  // the old file still names them. They are only removed after a successful
  // `up`: until then nothing destructive has happened, and a failure costs no
  // container.
  report("resolve-containers");
  const oldIds = await ops.containerIds(location);
  const toRemove = plan.diff.removed
    .map((serviceName) => oldIds.get(serviceName))
    .filter((id): id is string => Boolean(id));

  report("write-file");
  const written = writeRawComposeFile(location.projectDir, location.composeFileName, options.content, {
    expectedHash: options.expectedHash,
    basePath
  });
  if (!written.ok) {
    // Nothing was touched, so there is nothing to roll back.
    //
    // ⚠️ This assignment is also the watchdog over the hash guard: the compiler
    // checks `written.reason` against the set from
    // contract/src/agent/compose-reasons.ts. If a third reason is added in
    // compose-store.ts, the build breaks here — instead of an unknown key
    // reaching the caller (#89).
    return { ok: false, reason: written.reason, rolledBack: true, actualHash: written.actualHash };
  }

  const previousContent = written.previousContent;
  const rollback = async (): Promise<boolean> => {
    // The step that was not visible at all until #86: from outside a rollback
    // looked exactly like an `up` that is still running — both take up to
    // 300 s and both were silent.
    report("roll-back");
    try {
      restoreRawComposeFile(location.projectDir, location.composeFileName, previousContent);
      if (previousContent === null) {
        // On create there was nothing before. The half-created stack has to
        // go — a container that occupies the name and is not running is worse
        // than none. `down` runs against the file just restored, hence BEFORE
        // deleting it: afterwards Compose would no longer know what belongs to
        // the project.
        await ops.down(location);
        restoreRawComposeFile(location.projectDir, location.composeFileName, null);
      } else {
        await ops.up(location);
      }
      return true;
    } catch {
      return false;
    }
  };

  try {
    report("start");
    await ops.up(location);
  } catch {
    return {
      ok: false,
      reason: "compose-up-failed",
      rolledBack: await rollback()
    };
  }

  report("resolve-containers");
  const newIds = await ops.containerIds(location);
  const missing = plan.services.filter((name) => !newIds.get(name));
  if (missing.length > 0) {
    return {
      ok: false,
      reason: "container-not-resolvable",
      detail: missing.join(", "),
      rolledBack: await rollback()
    };
  }

  // Self-check on the result. Nobody validated what is in the file; what became
  // of it is checked here against the same rules as the whole inventory.
  report("check-hardening");
  const after = await violationsOf(ops, newIds, plan.services);
  const added = newViolations(plan.violationsBefore, after);
  const accepted = new Set(options.acceptedViolations);
  const unconfirmed = added.filter((keys) => !accepted.has(keys));
  if (unconfirmed.length > 0) {
    return {
      ok: false,
      reason: "hardening-newly-violated",
      newViolations: unconfirmed,
      rolledBack: await rollback()
    };
  }

  // Only now, after an `up` that succeeded in every respect, do the containers
  // of the dropped services disappear. Up to here every failure was without
  // consequences.
  const removedContainerIds: string[] = [];
  // Reported only if there really is something to remove: a line about zero
  // containers would claim an operation that does not take place.
  if (toRemove.length > 0) report("clean-up");
  for (const id of toRemove) {
    try {
      await ops.removeContainer(id);
      removedContainerIds.push(id);
    } catch {
      // An old container that cannot be removed does not undo the edit — the
      // new definition is in place and running. It stands out by missing from
      // `removedContainerIds`.
    }
  }

  const containerIds: Record<string, string> = {};
  const running: string[] = [];
  const restartLooping: string[] = [];
  for (const name of plan.services) {
    const id = newIds.get(name) as string;
    containerIds[name] = id;
    const state = await ops.runState(id);
    if (state.restarting) restartLooping.push(name);
    else if (state.running) running.push(name);
  }

  return {
    ok: true,
    composeHash: written.hash,
    containerIds,
    removedContainerIds,
    running,
    restartLooping
  };
}

// --- Helpers --------------------------------------------------------------

async function violationsOf(
  ops: RawApplyOps,
  ids: Map<string, string>,
  onlyThis?: readonly string[]
): Promise<ServiceViolations[]> {
  const names = onlyThis ?? [...ids.keys()];
  const result: ServiceViolations[] = [];
  for (const serviceName of names) {
    const id = ids.get(serviceName);
    if (!id) continue;
    try {
      result.push({ serviceName, rules: await ops.violationsOf(id) });
    } catch {
      // A container that cannot be inspected yields no before list. That is the
      // safe direction: if it is missing in BEFORE, its violations count as new
      // afterwards and must be confirmed.
    }
  }
  return result;
}

function imagesOf(config: unknown, services: readonly string[]): Record<string, string> {
  const raw = (config as { services?: Record<string, { image?: unknown }> } | null)?.services ?? {};
  const images: Record<string, string> = {};
  for (const name of services) {
    const image = raw[name]?.image;
    if (typeof image === "string" && image.trim()) images[name] = image.trim();
  }
  return images;
}
