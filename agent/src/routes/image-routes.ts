import type { PullStreamLine } from "contract";
import {
  EngineAbortError,
  EngineError
} from "../engine.js";
import { mutabilityOf, parseImageRef } from "../image-ref.js";
import { isComposeManaged } from "../recreate.js";
import {
  composeContextFindingOf
} from "../compose.js";
import {
  pullStreamFailureReason,
  type PullStreamFailureReason
} from "../stream-failure-reasons.js";
import { sendLine } from "../ndjson-line.js";
import { engine, registry, audit, openStreams } from "../runtime/state.js";
import { composeBasePath, selectedComposeContext } from "../runtime/containers.js";
import { send, ContainerRouteContext } from "../runtime/http.js";
import { gate } from "../runtime/gate.js";

// --- Image update (pull) -----------------------------------------------
// Pulls exclusively the ref stored in the agent's OWN allowlist (stage plan
// 3.6). Whatever the main API sends along as a ref is deliberately ignored
// here — otherwise "update" would be synonymous with "run arbitrary foreign
// code on the host" as soon as the API is compromised.
//
// The pull ONLY swaps the image in the local cache. The running container
// keeps using its old image until it is recreated. The response says so
// explicitly via `imageChanged`/`recreateRequired`, instead of suggesting a
// success that has not reached the application.
export async function handlePull(ctx: ContainerRouteContext): Promise<void> {
  const { response, actor, containerId, action } = ctx;
  const result = await gate(containerId, { mutating: true, action, actor });
  const containerName = result.ok ? (result.inspect.Name ?? "").replace(/^\//, "") : null;
  if (!result.ok) {
    audit.write({
      action: "pull",
      containerId,
      containerName,
      actor,
      outcome: "denied",
      reason: result.reason
    });
    send(response, result.status, { error: result.reason });
    return;
  }

  const expected = registry.expectedImageRef(containerId);
  const parsed = expected ? parseImageRef(expected) : null;
  if (!parsed) {
    // No ref or an incomprehensible one means: do not pull. A fallback to the
    // container's current image would be exactly the bypass that 3.6 is meant
    // to prevent.
    audit.write({
      action: "pull",
      containerId,
      containerName,
      actor,
      outcome: "denied",
      reason: expected ? "image-ref-unreadable" : "no-image-ref"
    });
    send(response, 409, { error: expected ? "image-ref-unreadable" : "no-image-ref" });
    return;
  }

  const before = await engine.imageId(parsed.fullRef);
  await engine.pull(parsed);
  const after = await engine.imageId(parsed.fullRef);
  const imageChanged = before !== after;

  // R1: the mutability goes INTO the log as well. A pull on a movable tag is
  // the moment foreign code arrives on the host without anyone having said
  // which — exactly the question one asks the log afterwards.
  const mutability = mutabilityOf(parsed);
  audit.write({
    action: "pull",
    containerId,
    containerName,
    actor,
    outcome: "allowed",
    reason: `${expected} (${imageChanged ? "new image" : "unchanged"}, ${mutability})`
  });
  send(response, 200, {
    ok: true,
    imageRef: expected,
    imageChanged,
    // Named honestly: the new image is ready but not running yet.
    recreateRequired: imageChanged,
    imageMutability: mutability
  });
  return;
}

// --- Image update with live output (guided update) --------------------
//
// Exactly the same pull as above, with exactly the same ref source (the OWN
// allowlist) — the only difference is that the progress goes out while it
// happens instead of being buffered until the end. That is the part the UI
// shows as terminal output.
//
// The output names the registry, layer ids and sizes — the silent `pull`
// does not.
export async function handlePullStream(ctx: ContainerRouteContext): Promise<void> {
  const { response, actor, containerId, action } = ctx;
  const result = await gate(containerId, { mutating: true, action, actor });
  const containerName = result.ok ? (result.inspect.Name ?? "").replace(/^\//, "") : null;
  if (!result.ok) {
    audit.write({
      action: "pull",
      containerId,
      containerName,
      actor,
      outcome: "denied",
      reason: result.reason
    });
    send(response, result.status, { error: result.reason });
    return;
  }

  const expected = registry.expectedImageRef(containerId);
  const parsed = expected ? parseImageRef(expected) : null;
  if (!parsed || !expected) {
    audit.write({
      action: "pull",
      containerId,
      containerName,
      actor,
      outcome: "denied",
      reason: expected ? "image-ref-unreadable" : "no-image-ref"
    });
    send(response, 409, { error: expected ? "image-ref-unreadable" : "no-image-ref" });
    return;
  }

  // R3: the pull stream counts towards the same pool as the log streams. It
  // is the most expensive of all — it holds the engine connection while
  // layers go over the wire in the background.
  const releaseStreamSlot = openStreams.tryAcquire();
  if (!releaseStreamSlot) {
    audit.write({
      action: "pull",
      containerId,
      containerName,
      actor,
      outcome: "denied",
      reason: "too-many-streams"
    });
    send(response, 429, { error: "too-many-streams" });
    return;
  }
  // Fallback as with the log streams: `close` fires on every path, the
  // release only counts once.
  response.once("close", releaseStreamSlot);

  // From here on the status is fixed (200) — any further error can only
  // appear IN the stream, no longer as an HTTP status. Hence the own
  // try/catch: the outer one would attempt `send(500)`, and that no longer
  // works once headers have been sent.
  response.writeHead(200, {
    "content-type": "application/x-ndjson; charset=utf-8",
    "cache-control": "no-store, no-transform"
  });
  sendLine(response, { kind: "start", imageRef: expected } satisfies PullStreamLine);

  // Aborts the engine connection when the main API in turn loses the
  // connection — exactly what happens when "Cancel" is pressed in the
  // browser: the fetch there closes, which propagates all the way to the
  // agent. Docker cancels the pull itself as soon as the engine connection
  // closes during it. Limited to the pull phase (via the `pullFinished`
  // guard): the subsequent recreation can no longer be aborted safely and
  // therefore always runs to completion.
  const pullAbort = new AbortController();
  let pullFinished = false;
  const onDisconnect = () => {
    if (!pullFinished) pullAbort.abort();
  };
  response.on("close", onDisconnect);

  try {
    const before = await engine.imageId(parsed.fullRef);
    await engine.pull(
      parsed,
      (progress) => sendLine(response, { kind: "progress", ...progress } satisfies PullStreamLine),
      pullAbort.signal
    );
    const after = await engine.imageId(parsed.fullRef);
    const imageChanged = before !== after;

    const mutability = mutabilityOf(parsed);
    audit.write({
      action: "pull",
      containerId,
      containerName,
      actor,
      outcome: "allowed",
      reason: `${expected} (${imageChanged ? "new image" : "unchanged"}, ${mutability}, streamed)`
    });
    sendLine(response, {
      kind: "result",
      ok: true,
      imageRef: expected,
      imageChanged,
      recreateRequired: imageChanged,
      imageMutability: mutability
    } satisfies PullStreamLine);
  } catch (error) {
    const aborted = error instanceof EngineAbortError;
    if (!aborted) console.error("[agent] pull-stream:", error);
    // Typed as PullStreamFailureReason (issue #82), since #80 resolved by
    // cause instead of written into a catch-all bucket.
    const pullStreamReason: PullStreamFailureReason | null = aborted
      ? null
      : pullStreamFailureReason(error);
    audit.write({
      action: "pull",
      containerId,
      containerName,
      actor,
      // "denied" in this log consistently means "the permission check said
      // no". An abort was allowed and merely not carried through — counted
      // as "denied" it would fake a permission violation. The reason below
      // says what it was.
      outcome: "error",
      // Word for word what is on the wire, so that the same case can be
      // found under ONE word in the archive and in the display. The engine
      // status follows where there is one: the archive is read months later
      // and then no longer has the error next to it — `engine-refused` alone
      // would not say there whether it was a 403 or a 500.
      //
      // Since #80 `aborted` only appears here and no longer on the wire —
      // English nevertheless, and that because of the situation of this one
      // field: the other values in the same assignment change their wording
      // in this change anyway (`engine-503` -> `engine-refused (503)`). So
      // the cut-off date in the non-rotating archive falls for this field
      // either way; a single German word next to them buys nothing and costs
      // consistency.
      reason:
        pullStreamReason === null
          ? "aborted"
          : error instanceof EngineError
            ? `${pullStreamReason} (engine-${error.status})`
            : pullStreamReason
    });
    // Only the reason, never the engine message: it can contain paths and
    // names (the same rule as in the outer error handler).
    if (pullStreamReason !== null) {
      sendLine(response, { kind: "error", reason: pullStreamReason } satisfies PullStreamLine);
    }
  } finally {
    pullFinished = true;
    releaseStreamSlot();
    response.off("close", onDisconnect);
  }
  response.end();
  return;
}

// --- Recreate preview (stage 5a) ---------------------------------------
// The core of the decision on the deferred pull question: before a recreate
// runs, it must be visible WHICH image would start. Otherwise an externally
// triggered pull would be a silent lever — someone pulls :latest, and the
// next internal recreate starts, unchecked, whatever lies there by then.
//
// The preview is read-only and changes nothing.
export async function handleRecreatePreview(ctx: ContainerRouteContext): Promise<void> {
  const { response, containerId } = ctx;
  const result = await gate(containerId, {
    mutating: false,
    action: "recreate"
  });
  if (!result.ok) {
    send(response, result.status, { error: result.reason });
    return;
  }

  const expected = registry.expectedImageRef(containerId);
  const parsed = expected ? parseImageRef(expected) : null;
  if (!parsed) {
    send(response, 409, { error: expected ? "image-ref-unreadable" : "no-image-ref" });
    return;
  }

  const targetImageId = await engine.imageId(parsed.fullRef);
  const runningImageId = result.inspect.Image ?? null;
  send(response, 200, {
    containerId,
    containerName: (result.inspect.Name ?? "").replace(/^\//, ""),
    imageRef: expected,
    // Exactly this id must be confirmed along with the execution.
    targetImageId,
    runningImageId,
    imageWouldChange: Boolean(targetImageId) && targetImageId !== runningImageId,
    // If the ref is not present locally at all, recreate would be flying blind.
    imageAvailable: Boolean(targetImageId),
    // R1: the preview exists so that before the recreate it is visible WHICH
    // image would start. With a movable tag the answer to that is "whatever
    // lies there right now" — that belongs in the same preview and not in a
    // footnote.
    imageMutability: mutabilityOf(parsed),
    composeManaged: isComposeManaged(result.inspect),
    // #468: `composeManaged` only answers "carries Compose labels" — the
    // guided update needs considerably more (directory in the base path,
    // exactly one file in it). The preview therefore promised a path that the
    // same agent refused seconds later, and only AFTER the pull. The anchor
    // belongs before the decision, not after it.
    composeAnchor: (() => {
      const selected = selectedComposeContext(
        (result.inspect.Name ?? "").replace(/^\//, ""),
        result.inspect.Config?.Labels ?? undefined
      );
      if (selected) return { ok: true as const, projectDir: selected.projectDir, composeBasePath };
      const finding = composeContextFindingOf(
        result.inspect.Config?.Labels ?? undefined,
        composeBasePath
      );
      return finding.ok
        ? { ok: true as const, projectDir: finding.context.projectDir, composeBasePath }
        : { ok: false as const, reason: finding.reason, projectDir: finding.projectDir, composeBasePath };
    })()
  });
  return;
}
