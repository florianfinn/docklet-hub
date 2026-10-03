import { selfUpdateRequestSchema } from "contract";
import crypto from "node:crypto";
import { mutabilityOf, parseImageRef } from "../image-ref.js";
import { localManifestDigest } from "../update.js";
import { resolveTargetRef, type SelfUpdateJob } from "../self-update.js";
import {
  jobOpen,
  readStatus,
  readAvailable,
  writeJob
} from "../self-update-state.js";
import { AGENT_VERSION } from "../version.js";
import { config, engine, audit, ownContainerId } from "../runtime/state.js";
import { send, readJsonBody, parseRequest, rejectRequest, RouteContext } from "../runtime/http.js";

// --- Self-update of the agent (#36) -------------------------------------
//
// The agent triggers NOTHING here that it could execute itself. It places a
// job in the shared /state; it is executed by the watcher — a second
// container from the same image. The reason is mechanical: during the swap the
// engine stops this container here, and a process that pulls the ground out
// from under itself aborts in the middle of the most dangerous step.
//
// Without a running watcher, simply nothing happens after this 202. That is
// visible (`running` stays set, `last` does not change) and deliberately not
// built as an error: from here the agent cannot determine whether the watcher
// is alive, and an invented promise would be worse than a missing answer.
export async function handleSelfUpdateStart(ctx: RouteContext): Promise<void> {
  const { request, response, actor, tier } = ctx;
  const ownId = ownContainerId();
  const reject = (reason: string, status: number): void => {
    audit.write({
      action: "self-update",
      containerId: ownId,
      containerName: null,
      actor,
      networkTier: tier,
      outcome: "denied",
      reason: reason
    });
    send(response, status, { error: reason });
  };

  // The break-glass applies here too. A kill switch that switches the agent to
  // read-only but still allows its own replacement would be no kill switch.
  if (config.readOnly) {
    reject("read-only", 409);
    return;
  }
  // ⚠️ The most important bolt of this endpoint, since it became clear what a
  // wrong value does here: on 2026-08-26 the job on remote-host carried the id of
  // the tunnel sidecar, the watcher conscientiously replaced it, and the host
  // was unreachable for an hour. Better no self-update than one on a foreign
  // container.
  if (!ownId) {
    reject("own-container-id-unverifiable", 409);
    return;
  }
  if (jobOpen(config.selfUpdateDir)) {
    // Two swap operations side by side would be two choreographies on the
    // same container.
    reject("already-running", 409);
    return;
  }

  let self;
  try {
    self = await engine.inspect(ownId);
  } catch {
    reject("own-container-not-readable", 409);
    return;
  }
  const imageRef = typeof self.Config?.Image === "string" ? self.Config.Image : "";
  const imageId = typeof self.Image === "string" ? self.Image : "";
  if (!imageRef || !imageId) {
    reject("own-image-ref-unknown", 409);
    return;
  }

  // Since v0.30.0 the caller may name the target (`{ imageRef }`),
  // otherwise the own ref applies as before — see resolveTargetRef().
  // Invalid JSON is answered centrally (`400 invalid-json`), as everywhere.
  const parsedBody = parseRequest(selfUpdateRequestSchema, await readJsonBody(request));
  if (!parsedBody.ok) {
    rejectRequest(ctx, { action: "self-update", containerId: ownId, containerName: null }, parsedBody.rejection);
    return;
  }
  const target = resolveTargetRef(imageRef, parsedBody.value.imageRef);
  if (!target.ok) {
    reject(target.reason, 400);
    return;
  }

  const job: SelfUpdateJob = {
    jobId: crypto.randomUUID(),
    requestedBy: actor ?? "unknown",
    requestedAt: new Date().toISOString(),
    agentContainerId: ownId,
    imageRef: target.imageRef,
    runningVersion: AGENT_VERSION,
    runningImageId: imageId
  };
  writeJob(config.selfUpdateDir, job);
  audit.write({
    action: "self-update",
    containerId: ownId,
    containerName: (self.Name ?? "").replace(/^\//, "") || null,
    actor,
    networkTier: tier,
    outcome: "allowed",
    reason: `${job.jobId}: ${imageRef} -> ${target.imageRef} (${AGENT_VERSION})`
  });
  // 202 and not 200: accepted, not done. Whoever read 200 here would confuse
  // the outcome with the acceptance.
  send(response, 202, { ok: true, jobId: job.jobId, imageRef: target.imageRef });
  return;
}

export async function handleSelfUpdateStatus(ctx: RouteContext): Promise<void> {
  const { response } = ctx;
  // The outcome comes from /state and not from memory: the process that
  // placed the job did not survive the swap. That is exactly why it lives in a
  // file.
  send(response, 200, {
    running: jobOpen(config.selfUpdateDir),
    version: AGENT_VERSION,
    last: readStatus(config.selfUpdateDir)
  });
  return;
}

// Is there anything newer at all? The same comparison as in the update check
// of managed containers (D2) — local manifest digest against the digest the
// daemon fetches via the distribution API, without pulling layers.
//
// ⚠️ With `:latest`, "local != remote" says ONLY that there is something newer
// — not WHICH version. That is only settled after the pull, and only there do
// signature verification and the downgrade bolt apply. That is why
// `imageMutability` travels along: a UI that shows both the same way promises
// more than is known here.
export async function handleSelfUpdateAvailable(ctx: RouteContext): Promise<void> {
  const { response } = ctx;
  const ownIdForInfo = ownContainerId();
  if (!ownIdForInfo) {
    send(response, 409, { error: "own-container-id-unverifiable" });
    return;
  }
  const self = await engine.inspect(ownIdForInfo);
  const imageRef = typeof self.Config?.Image === "string" ? self.Config.Image : "";
  const parsedRef = imageRef ? parseImageRef(imageRef) : null;
  if (!parsedRef) {
    send(response, 409, { error: "own-image-ref-unknown" });
    return;
  }
  const imageInspect = self.Image ? await engine.inspectImage(self.Image) : null;
  const local = localManifestDigest(imageInspect?.RepoDigests, imageRef);

  // Two sources, in this order.
  //
  // 1. The daemon itself. It asks ANONYMOUSLY — it holds no credentials —,
  //    and for a private package the registry answers it with
  //    `unauthorized`. For a public image, on the other hand, its answer is
  //    the freshest available.
  // 2. The watcher. It has `config.json` mounted, asks periodically WITH
  //    authentication and places the result in the shared /state.
  //
  // ⚠️ This way the agent gets the information but no token. Giving it the
  // credentials would have been the shorter path and would have made the
  // process with docker.sock the bearer of a registry token that it needs for
  // none of its tasks.
  const fromDaemon = await engine.remoteManifestDigest(imageRef);
  const fromWatcher = fromDaemon ? null : readAvailable(config.selfUpdateDir, imageRef);
  const removed = fromDaemon ?? fromWatcher?.remoteDigest ?? null;
  send(response, 200, {
    imageRef,
    version: AGENT_VERSION,
    localDigest: local,
    remoteDigest: removed,
    // Null and not `false` when one of the two values is missing: "I cannot
    // determine it" is something different from "there is nothing new".
    updatable: local && removed ? local !== removed : null,
    imageMutability: mutabilityOf(parsedRef),
    // Where the remote digest comes from and how old it is. The watcher's
    // value is by construction older than this moment; a UI that hides that
    // promises a freshness that does not exist. `null` here means "no value at
    // all", not "just now".
    digestSource: fromDaemon ? "daemon" : fromWatcher?.remoteDigest ? "watcher" : null,
    digestCheckedAt: fromDaemon ? new Date().toISOString() : (fromWatcher?.checkedAt ?? null),
    // Why nothing could be determined — the difference between "no watcher
    // is running" and "the watcher has no credentials".
    digestReason: removed ? null : (fromWatcher?.reason ?? "not-given")
  });
  return;
}
