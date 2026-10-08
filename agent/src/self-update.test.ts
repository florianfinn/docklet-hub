import assert from "node:assert/strict";
import test from "node:test";
import { selfUpdateRequestSchema } from "contract";
import type { RawInspect } from "./engine.js";
import {
  executeSelfUpdateFrom,
  isRegression,
  resolveTargetRef,
  compareVersions,
  versionFromLabel,
  type ImageFinding,
  type SelfUpdateJob,
  type SelfUpdateOps
} from "./self-update.js";

const ALT = `sha256:${"a".repeat(64)}`;
const New = `sha256:${"b".repeat(64)}`;
const DIGEST = `ghcr.io/florianfinn/docklet-hub-agent@sha256:${"c".repeat(64)}`;

const Job: SelfUpdateJob = {
  jobId: "auftrag-1",
  requestedBy: "dashboard",
  requestedAt: "2026-08-25T20:00:00.000Z",
  agentContainerId: "agent-alt",
  imageRef: "ghcr.io/florianfinn/docklet-hub-agent:latest",
  runningVersion: "0.11.0",
  runningImageId: ALT
};

function inspected(id: string, image: string): RawInspect {
  return { Id: id, Name: "/dashboard-docker-agent-1", Image: image };
}

type Recording = {
  ops: SelfUpdateOps;
  swap: Array<{ imageRef: string; expected: string }>;
  signatures: Array<{ digestRef: string; version: string }>;
};

function fakeOps(
  overrides: Partial<SelfUpdateOps> & { finding?: ImageFinding; startOk?: boolean[] } = {}
): Recording {
  const swap: Recording["swap"] = [];
  const signatures: Recording["signatures"] = [];
  const startResponses = overrides.startOk ?? [true];
  let time = 1_700_000_000_000;

  const ops: SelfUpdateOps = {
    async pull() {},
    async imageId() {
      return New;
    },
    async imageFinding() {
      return overrides.finding ?? { version: "v0.12.0", digestRef: DIGEST };
    },
    async checkSignature(digestRef, version) {
      signatures.push({ digestRef, version });
      return { ok: true, reason: null };
    },
    async inspect(containerId) {
      return inspected(containerId, containerId === "agent-alt" ? ALT : New);
    },
    async swap(_raw, imageRef, expected) {
      swap.push({ imageRef, expected });
      return `agent-neu-${swap.length}`;
    },
    async waitForStart() {
      const response = startResponses.shift() ?? true;
      return response ? { ok: true, reason: null } : { ok: false, reason: "Frist abgelaufen" };
    },
    logLine() {},
    now() {
      time += 1000;
      return time;
    },
    ...overrides
  };
  return { ops, swap, signatures };
}

test("versionAusLabel nimmt nur ein vollstaendiges vX.Y.Z", () => {
  assert.equal(versionFromLabel("v0.11.0"), "v0.11.0");
  assert.equal(versionFromLabel("  v1.2.3-rc1  "), "v1.2.3-rc1");
  assert.equal(versionFromLabel("0.11.0"), null);
  assert.equal(versionFromLabel("latest"), null);
  assert.equal(versionFromLabel(""), null);
  assert.equal(versionFromLabel(undefined), null);
  assert.equal(versionFromLabel(null), null);
});

test("compareVersions ordnet nach Bestandteilen, nicht alphabetisch", () => {
  // Der Fall, an dem eine Zeichenkettenordnung scheitert und der beim
  // `latest`-Tag im Release-Workflow schon einmal geregelt werden musste.
  assert.ok((compareVersions("v0.10.0", "v0.9.0") ?? 0) > 0);
  assert.equal(compareVersions("v1.2.3", "1.2.3"), 0);
  assert.ok((compareVersions("v1.0.0-rc1", "v1.0.0") ?? 0) < 0);
  assert.equal(compareVersions("v1.0.0", "unknown"), null);
});

test("istRueckschritt meldet nur eine belegbare Rueckwaertsbewegung", () => {
  assert.equal(isRegression("0.11.0", "v0.10.1"), true);
  assert.equal(isRegression("0.11.0", "v0.11.0"), false);
  assert.equal(isRegression("0.11.0", "v0.12.0"), false);
  // Unreadable does not mean backwards — versionFromLabel rejects that case.
  assert.equal(isRegression("unknown", "v0.12.0"), false);
});

test("gleiches Image bleibt unveraendert und fasst den Container nicht an", async () => {
  const { ops, swap, signatures } = fakeOps({
    async imageId() {
      return ALT;
    }
  });
  const status = await executeSelfUpdateFrom(ops, Job);
  assert.equal(status.outcome, "unchanged");
  assert.deepEqual(swap, []);
  // No signature call: there is nothing new to verify.
  assert.deepEqual(signatures, []);
});

test("a failed pull leaves the agent untouched", async () => {
  const { ops, swap } = fakeOps({
    async pull() {
      throw new Error("Registry antwortete 401");
    }
  });
  const status = await executeSelfUpdateFrom(ops, Job);
  assert.equal(status.outcome, "failed");
  assert.match(status.reason ?? "", /pull: Registry antwortete 401/);
  assert.deepEqual(swap, []);
});

test("Image ohne brauchbares Versions-Label wird abgelehnt, nicht geprueft", async () => {
  const { ops, swap, signatures } = fakeOps({ finding: { version: null, digestRef: DIGEST } });
  const status = await executeSelfUpdateFrom(ops, Job);
  assert.equal(status.outcome, "aborted");
  assert.match(status.reason ?? "", /version-label-unreadable/);
  // Ohne Identitaet wird gar nicht erst gegen eine leere Identitaet geprueft.
  assert.deepEqual(signatures, []);
  assert.deepEqual(swap, []);
});

test("Image ohne Digest wird abgelehnt", async () => {
  const { ops, swap } = fakeOps({ finding: { version: "v0.12.0", digestRef: null } });
  const status = await executeSelfUpdateFrom(ops, Job);
  assert.equal(status.outcome, "aborted");
  assert.equal(status.reason, "digest-undeterminable");
  assert.deepEqual(swap, []);
});

test("fehlgeschlagene Signatur verhindert den Tausch", async () => {
  const { ops, swap, signatures } = fakeOps({
    async checkSignature(digestRef, version) {
      recordSignatures(signatures, digestRef, version);
      return { ok: false, reason: "no matching signatures" };
    }
  });
  const status = await executeSelfUpdateFrom(ops, Job);
  assert.equal(status.outcome, "aborted");
  assert.match(status.reason ?? "", /signature: no matching signatures/);
  assert.deepEqual(swap, []);
  // Geprueft wird der Digest, nie der bewegliche Tag.
  assert.deepEqual(signatures, [{ digestRef: DIGEST, version: "v0.12.0" }]);
});

function recordSignatures(
  target: Array<{ digestRef: string; version: string }>,
  digestRef: string,
  version: string
): void {
  target.push({ digestRef, version });
}

test("ein echt signiertes, aber aelteres Image wird abgelehnt", async () => {
  // The case the signature does NOT cover: it confirms authenticity, not
  // direction. Without this bolt the button would be a possible downgrade.
  const { ops, swap } = fakeOps({ finding: { version: "v0.10.1", digestRef: DIGEST } });
  const status = await executeSelfUpdateFrom(ops, Job);
  assert.equal(status.outcome, "aborted");
  assert.equal(status.reason, "downgrade: 0.11.0 -> v0.10.1");
  assert.deepEqual(swap, []);
});

test("der Regelweg tauscht genau einmal und meldet beide Versionen", async () => {
  const { ops, swap } = fakeOps();
  const status = await executeSelfUpdateFrom(ops, Job);
  assert.equal(status.outcome, "ok");
  assert.equal(status.reason, null);
  assert.equal(status.fromVersion, "0.11.0");
  assert.equal(status.toVersion, "v0.12.0");
  assert.equal(status.toImageId, New);
  assert.equal(status.digest, DIGEST);
  assert.deepEqual(swap, [{ imageRef: Job.imageRef, expected: New }]);
});

test("ein Agent, der nicht startet, wird auf die alte Image-Id zurueckgerollt", async () => {
  const { ops, swap } = fakeOps({ startOk: [false, true] });
  const status = await executeSelfUpdateFrom(ops, Job);
  assert.equal(status.outcome, "rolled-back");
  assert.equal(status.reason, "Frist abgelaufen");
  assert.equal(status.toVersion, "0.11.0");
  assert.equal(status.toImageId, ALT);
  assert.equal(swap.length, 2);
  // Der Rueckweg nennt die ID, nicht den Ref: der Ref zeigt in diesem Moment
  // auf genau das Image, das gerade nicht startet.
  assert.deepEqual(swap[1], { imageRef: ALT, expected: ALT });
});

test("scheitert auch der Rueckweg, ist der Ausgang fehlgeschlagen", async () => {
  const { ops } = fakeOps({ startOk: [false, false] });
  const status = await executeSelfUpdateFrom(ops, Job);
  assert.equal(status.outcome, "failed");
  assert.match(status.reason ?? "", /rollback not confirmed either/);
});

test("ein Fehler im Tausch selbst gilt nicht als Rueckrollung", async () => {
  // Die Choreografie raeumt selbst auf; getauscht wurde dann nie.
  const { ops } = fakeOps({
    async swap() {
      throw new Error("create abgelehnt");
    }
  });
  const status = await executeSelfUpdateFrom(ops, Job);
  assert.equal(status.outcome, "failed");
  assert.match(status.reason ?? "", /swap: create abgelehnt/);
});

// --- Das Ziel (v0.30.0) ------------------------------------------------------

const OWN_PINNED = `ghcr.io/florianfinn/docklet-hub-agent:v0.29.1@sha256:${"d".repeat(64)}`;
const TARGET_PINNED = `ghcr.io/florianfinn/docklet-hub-agent:v0.30.0@sha256:${"e".repeat(64)}`;

test("ohne genanntes Ziel bleibt es beim eigenen Ref", () => {
  assert.deepEqual(resolveTargetRef(OWN_PINNED, undefined), { ok: true, imageRef: OWN_PINNED });
  assert.deepEqual(resolveTargetRef(OWN_PINNED, null), { ok: true, imageRef: OWN_PINNED });
});

test("ein Ziel aus demselben Repository wird übernommen, auch mit Tag und Digest", () => {
  assert.deepEqual(resolveTargetRef(OWN_PINNED, TARGET_PINNED), { ok: true, imageRef: TARGET_PINNED });
  assert.deepEqual(resolveTargetRef(OWN_PINNED, ` ${TARGET_PINNED} `), { ok: true, imageRef: TARGET_PINNED });
  assert.deepEqual(
    resolveTargetRef("ghcr.io/florianfinn/docklet-hub-agent:latest", "ghcr.io/florianfinn/docklet-hub-agent:v0.30.0"),
    { ok: true, imageRef: "ghcr.io/florianfinn/docklet-hub-agent:v0.30.0" }
  );
});

test("ein Ziel aus einem fremden Repository wird abgelehnt", () => {
  assert.deepEqual(resolveTargetRef(OWN_PINNED, "ghcr.io/fremd/docklet-hub-agent:v0.30.0"), {
    ok: false,
    reason: "target-foreign-repository"
  });
  // Derselbe Name unter einer anderen Registry ist ein anderes Repository.
  assert.deepEqual(resolveTargetRef(OWN_PINNED, "docker.io/florianfinn/docklet-hub-agent:v0.30.0"), {
    ok: false,
    reason: "target-foreign-repository"
  });
});

test("ein Agent aus dem alten Repository-Namen wechselt nicht von selbst auf den neuen (#279)", () => {
  // Up to v0.31.0 the image was `dashboard-docker-agent`. The repository moved
  // with the hub, and a running agent keeps refusing a foreign repository, so
  // that one arm gets its `DOCKER_AGENT_IMAGE` changed once by hand.
  assert.deepEqual(
    resolveTargetRef("ghcr.io/florianfinn/dashboard-docker-agent:v0.31.0", TARGET_PINNED),
    { ok: false, reason: "target-foreign-repository" }
  );
});

test("ein unlesbares Ziel wird abgelehnt, statt auf den eigenen Ref zurückzufallen", () => {
  for (const requested of ["", "   ", "ghcr.io/florianfinn/docklet-hub-agent@sha256:kurz", "a b"]) {
    assert.deepEqual(
      resolveTargetRef(OWN_PINNED, requested),
      { ok: false, reason: "target-image-ref-unreadable" },
      JSON.stringify(requested)
    );
  }
  // Kein Text erreicht resolveTargetRef gar nicht erst: das Schema lehnt ihn
  // beim Lesen der Anfrage ab (#272) und nennt das Feld.
  for (const requested of [42, {}, ["x"]]) {
    const parsed = selfUpdateRequestSchema.safeParse({ imageRef: requested });
    assert.equal(parsed.success, false, JSON.stringify(requested));
    assert.deepEqual(parsed.error?.issues[0]?.path, ["imageRef"]);
  }
});


test("rc update ordering is numeric and keeps the final release after candidates", () => {
  const versions = ["0.32.0-rc.3", "0.32.0-rc.4", "0.32.0-rc.9", "0.32.0-rc.10", "0.32.0", "0.32.1-rc.1"];
  for (const [i, left] of versions.entries()) {
    for (const [j, right] of versions.entries()) {
      const compared = compareVersions(`v${left}`, right);
      assert.ok(compared !== null);
      assert.equal(Math.sign(compared) || 0, Math.sign(i - j) || 0, `${left} vs ${right}`);
      assert.equal(isRegression(left, `v${right}`), j < i, `${left} to ${right}`);
    }
  }
});
