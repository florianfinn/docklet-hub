import assert from "node:assert/strict";
import test from "node:test";
import {
  findHardeningViolations,
  hardeningReport,
  hardeningRuleNames,
  hasDelegationLock,
  normalizePath,
  selfCheckViolations,
  type InspectedContainer
} from "./hardening.js";

// The base is deliberately a fully hardened container: that way every test
// measures exactly the one deviation it sets.
function container(overrides: Partial<InspectedContainer> = {}): InspectedContainer {
  return {
    id: "abc123",
    name: "harmlos",
    image: "nginx@sha256:deadbeef",
    privileged: false,
    capAdd: [],
    capDrop: ["ALL"],
    securityOpt: ["no-new-privileges:true"],
    pidMode: "",
    ipcMode: "",
    networkMode: "bridge",
    binds: ["daten:/var/lib/data", "/home/docker/appdata/nginx:/etc/nginx:ro"],
    devices: [],
    memoryLimitBytes: 512 * 1024 * 1024,
    pidsLimit: 256,
    cpuLimited: true,
    // Bounded rotation (S9/K4b) — otherwise `logging-unbounded` fires in every
    // test as well and every comparison would have to carry it along.
    logDriver: "json-file",
    logOptions: { "max-size": "10m", "max-file": "3" },
    ...overrides
  };
}

function rules(c: InspectedContainer) {
  return findHardeningViolations(c)
    .map((v) => v.rule)
    .sort();
}

test("an inconspicuous container is clean", () => {
  // Named volumes and a path below the app data directory.
  const c = container({ binds: ["daten:/var/lib/data", "/srv/appdata/x:/data"] });
  assert.deepEqual(findHardeningViolations(c), []);
  assert.equal(hasDelegationLock(c), false);
});

test("docker.sock is rejected categorically — both path variants", () => {
  for (const bind of ["/var/run/docker.sock:/var/run/docker.sock", "/run/docker.sock:/tmp/d.sock:ro"]) {
    assert.deepEqual(rules(container({ binds: [bind] })), ["docker-socket-mount"], bind);
  }
});

test("docker.sock cannot be hidden via ..", () => {
  // A plain prefix comparison would have slipped past here.
  const c = container({ binds: ["/var/lib/../run/docker.sock:/x"] });
  assert.deepEqual(rules(c), ["docker-socket-mount"]);
});

test("an ANCESTOR of the socket is the same finding — not just a warning", () => {
  // ⚠️ Finding from R3 (§27.4). Until then isDockerSocket only compared for
  // equality: `/var/run:/var/run` contains the socket but was classified as
  // `sensitive-host-path` (warning), and `/var:/var` even only as
  // `bind-outside-base` (hint). Both containers would then carry no
  // delegation lock, although they are host root via the contained socket.
  //
  // That is word for word the lesson S9 had already drawn for
  // `dashboard-self-mount`: a prefix list is blind to ancestors. It did not
  // apply to the core rule itself.
  for (const bind of ["/var/run:/var/run", "/run:/run", "/var:/var", "/var/run/..:/x"]) {
    assert.deepEqual(rules(container({ binds: [bind] })), ["docker-socket-mount"], bind);
  }
  // "/" reaches both core rules; that dashboard-self-mount wins there is a
  // question of explanation, not of effect (see findHardeningViolations).
  // All that matters: it stays a lock.
  for (const bind of ["/:/host", "/var/run:/var/run", "/var:/var"]) {
    assert.equal(hasDelegationLock(container({ binds: [bind] })), true, bind);
  }
});

test("neighbours of the socket stay outside the rule", () => {
  // The counter-check: the widening must not sweep up everything under /var.
  // /var/lib and /var/run/foo neither contain the socket nor lie below it —
  // they stay what they were before.
  for (const bind of ["/var/lib/docker:/x", "/var/run/foo:/x", "/etc:/x"]) {
    assert.ok(
      !rules(container({ binds: [bind] })).includes("docker-socket-mount"),
      `${bind} is not a socket mount`
    );
  }
});

test("bind violations carry the normalised host path as a stable key", () => {
  // The same docker.sock in different spellings (target path, :ro, ..)
  // ALWAYS yields the same hostPath. That is the key the raw editor uses to
  // tell "existed before" from "newly introduced" — if it were the full bind,
  // a mere reformatting would count as new.
  for (const bind of [
    "/var/run/docker.sock:/var/run/docker.sock:ro",
    "/var/run/docker.sock:/tmp/anderes-ziel.sock",
    "/var/run/../run/docker.sock:/x"
  ]) {
    const [violation] = findHardeningViolations(container({ binds: [bind] }));
    assert.equal(violation.rule, "docker-socket-mount", bind);
    assert.equal(violation.hostPath, "/var/run/docker.sock", bind);
  }
});

test("different danger paths keep different keys", () => {
  // So that a genuinely NEW dangerous mount still stands out: two different
  // socket paths are two hostPaths, not one.
  const [a] = findHardeningViolations(container({ binds: ["/var/run/docker.sock:/x"] }));
  const [b] = findHardeningViolations(container({ binds: ["/run/docker.sock:/x"] }));
  assert.equal(a.hostPath, "/var/run/docker.sock");
  assert.equal(b.hostPath, "/run/docker.sock");
  assert.notEqual(a.hostPath, b.hostPath);
});

test("privileged is rejected", () => {
  assert.deepEqual(rules(container({ privileged: true })), ["privileged"]);
});

test("dangerous capabilities are detected, also with CAP_ prefix and lower case", () => {
  for (const cap of ["SYS_ADMIN", "CAP_SYS_ADMIN", "cap_sys_module", "ALL"]) {
    assert.deepEqual(rules(container({ capAdd: [cap] })), ["dangerous-capability"], cap);
  }
  // A harmless capability stays allowed.
  assert.deepEqual(rules(container({ capAdd: ["NET_BIND_SERVICE"] })), []);
});

test("host namespaces are rejected", () => {
  assert.deepEqual(rules(container({ pidMode: "host" })), ["host-namespace"]);
  assert.deepEqual(rules(container({ ipcMode: "host" })), ["host-namespace"]);
  assert.deepEqual(rules(container({ networkMode: "host" })), ["host-namespace"]);
});

test("sensitive host paths are reported, even read-only", () => {
  for (const bind of ["/etc:/etc:ro", "/root:/r", "/var/lib/docker:/vld", "/proc:/p"]) {
    assert.ok(rules(container({ binds: [bind] })).includes("sensitive-host-path"), bind);
  }
});

// --- S9: the fourth core rule of the delegation lock -----------------------

test("the own operational directories are a delegation lock, not a warning", () => {
  // dashboard-state holds the secrets, dashboard-repo the deployed code.
  // Whoever has one of them in a container can rewrite the management through
  // which all other rights run — the same statement as docker.sock.
  for (const bind of [
    "/home/docker/dashboard-state:/s:ro",
    "/home/docker/dashboard-repo:/r:ro",
    "/home/docker/dashboard-state/secrets:/x"
  ]) {
    assert.deepEqual(rules(container({ binds: [bind] })), ["dashboard-self-mount"], bind);
    assert.equal(hasDelegationLock(container({ binds: [bind] })), true, bind);
  }
});

test("a mount ABOVE the operational directories locks just the same", () => {
  // The branch that a plain prefix list is blind to: "/" contains
  // dashboard-state and is therefore not one bit more harmless than the direct
  // mount. Without it "/" would only be a warning — and the container delegable.
  for (const bind of ["/:/host", "/home:/h", "/home/docker:/hd", "/home/docker/../docker:/hd"]) {
    assert.deepEqual(rules(container({ binds: [bind] })), ["dashboard-self-mount"], bind);
  }
});

// --- Self-protection per host (S23) ------------------------------------------
//
// Until S23 the list of own operational directories was a constant with LOCAL
// paths. On a remote host it never matched — one of the five
// delegation locks was effectively switched off there, and a container that
// mounts the agent directory would have carried no delegation lock.

test("a remote host protects ITS own directories", () => {
  const selfPaths = ["/mnt/user/appdata/dashboard-agent-bootstrap"];
  for (const bind of [
    "/mnt/user/appdata/dashboard-agent-bootstrap:/x",
    "/mnt/user/appdata/dashboard-agent-bootstrap/.env:/e:ro",
    // Both directions, as locally: a mount ABOVE contains it.
    "/mnt/user/appdata:/a",
    "/mnt/user:/u",
    "/mnt:/m"
  ]) {
    const c = container({ binds: [bind] });
    assert.deepEqual(
      findHardeningViolations(c, { selfPaths }).map((v) => v.rule),
      ["dashboard-self-mount"],
      bind
    );
  }
});

test("without selfPaths the local fallback still applies", () => {
  // A forgetful caller behaves as before S23 — i.e. it keeps protecting the
  // local host instead of checking nothing at all.
  assert.deepEqual(rules(container({ binds: ["/home/docker/dashboard-state:/s"] })), [
    "dashboard-self-mount"
  ]);
});

test("an EMPTY list is not an off switch", () => {
  // Otherwise `selfPaths: []` would be the silent way to switch the rule off.
  assert.deepEqual(
    findHardeningViolations(container({ binds: ["/home/docker/dashboard-state:/s"] }), {
      selfPaths: []
    }).map((v) => v.rule),
    ["dashboard-self-mount"]
  );
});

test("one host's own paths do not lock those of another", () => {
  // The unraid agent must not fire because of a path that only exists on the
  // local server — and vice versa.
  const c = container({ binds: ["/home/docker/dashboard-state:/s"] });
  assert.deepEqual(
    findHardeningViolations(c, { selfPaths: ["/mnt/user/appdata/dashboard-agent-bootstrap"] })
      .map((v) => v.rule)
      .filter((rule) => rule === "dashboard-self-mount"),
    []
  );
});

test("a neighbour of dashboard-state is not a self mount", () => {
  // "/home/docker/dashboard-state-backup" only starts with the name.
  assert.deepEqual(rules(container({ binds: ["/home/docker/dashboard-state-backup/x:/b"] })), []);
});

test("normal app data under /home/docker stays allowed", () => {
  // A blanket /home/docker lock would be useless — that is where the payload
  // data of the managed containers lives.
  assert.deepEqual(rules(container({ binds: ["/home/docker/appdata/nginx:/etc/nginx:ro"] })), []);
});

test("a path that only STARTS with a sensitive name is not a match", () => {
  // "/etchosts" must not pass as "/etc".
  assert.deepEqual(rules(container({ binds: ["/etchosts:/x"] })), []);
  assert.deepEqual(rules(container({ binds: ["/rootfs-backup:/x"] })), []);
});

test("named volumes are never a sensitive host path", () => {
  assert.deepEqual(rules(container({ binds: ["etc:/etc", "root:/root"] })), []);
});

test("disabled AppArmor/seccomp is detected", () => {
  // no-new-privileges stays set, otherwise the test measures two things.
  for (const option of ["apparmor=unconfined", "seccomp:unconfined"]) {
    assert.deepEqual(
      rules(container({ securityOpt: ["no-new-privileges:true", option] })),
      ["apparmor-or-seccomp-disabled"],
      option
    );
  }
});

test("device passthrough is rejected", () => {
  assert.deepEqual(rules(container({ devices: ["/dev/sda:/dev/sda:rwm"] })), ["device-passthrough"]);
});

test("several violations are all reported, not just the first", () => {
  const c = container({
    privileged: true,
    binds: ["/var/run/docker.sock:/var/run/docker.sock", "/etc:/etc"],
    capAdd: ["SYS_ADMIN"]
  });
  assert.deepEqual(rules(c), [
    "dangerous-capability",
    "docker-socket-mount",
    "privileged",
    "sensitive-host-path"
  ]);
});

// --- Stage 4 / S9: hints and the separation of the three levels ------------

test("missing no-new-privileges is reported but does not lock", () => {
  const c = container({ securityOpt: [] });
  assert.deepEqual(rules(c), ["no-new-privileges-missing"]);
  assert.equal(hasDelegationLock(c), false);
});

test("no-new-privileges is detected in both spellings", () => {
  for (const option of ["no-new-privileges:true", "no-new-privileges=true", "No-New-Privileges:True"]) {
    assert.deepEqual(rules(container({ securityOpt: [option] })), [], option);
  }
});

test("missing cap_drop ALL is reported but does not lock", () => {
  const c = container({ capDrop: [] });
  assert.deepEqual(rules(c), ["capabilities-not-dropped"]);
  assert.equal(hasDelegationLock(c), false);
  // Here too the normalised form counts.
  assert.deepEqual(rules(container({ capDrop: ["CAP_ALL"] })), []);
});

test("missing resource limits are bundled into ONE finding", () => {
  const c = container({ memoryLimitBytes: 0, cpuLimited: false, pidsLimit: null });
  const violations = findHardeningViolations(c);
  assert.equal(violations.length, 1);
  assert.equal(violations[0].rule, "resource-limit-missing");
  assert.equal(violations[0].detail, "no limit: Memory, CPU, PIDs");
  assert.equal(hasDelegationLock(c), false);
});

test("a single missing limit is enough for the finding", () => {
  assert.deepEqual(rules(container({ pidsLimit: 0 })), ["resource-limit-missing"]);
  assert.deepEqual(rules(container({ memoryLimitBytes: 0 })), ["resource-limit-missing"]);
});

test("hints lock nothing, the delegation lock does", () => {
  // The realistic existing case: nothing hardened, but no escape path either.
  const inventory = container({
    capDrop: [],
    securityOpt: [],
    memoryLimitBytes: 0,
    cpuLimited: false,
    pidsLimit: null
  });
  const report = hardeningReport(inventory);
  assert.equal(report.delegationLock.length, 0);
  assert.equal(report.warning.length, 0);
  assert.equal(report.hint.length, 3);
  assert.equal(hasDelegationLock(inventory), false);

  // The same container with a socket mount: from here on it is no longer delegable.
  const dangerous = container({ ...inventory, binds: ["/var/run/docker.sock:/var/run/docker.sock"] });
  assert.deepEqual(
    hardeningReport(dangerous).delegationLock.map((v) => v.rule),
    ["docker-socket-mount"]
  );
  assert.equal(hasDelegationLock(dangerous), true);
});

test("an unresolvable volume is fail-closed and not delegable", () => {
  const unknown = container({ unresolvedVolumes: ["proj_hostroot", "proj_hostroot"] });
  const report = hardeningReport(unknown);

  assert.deepEqual(report.delegationLock.map((v) => v.rule), ["volume-unresolved"]);
  assert.deepEqual(hardeningRuleNames(unknown).delegationLock, ["volume-unresolved"]);
  assert.equal(hasDelegationLock(unknown), true);
  assert.deepEqual(selfCheckViolations(unknown).map((v) => v.rule), ["volume-unresolved"]);
});

// --- S9: what the relaxation means in concrete terms ----------------------

test("the three cases from §4 are no longer a lock", () => {
  // Named explicitly in the stage plan: tailscale (NET_ADMIN), hardware
  // transcoding (/dev/dri), upsnap (network_mode: host — that one stays
  // locked because it shares the host namespace).
  assert.equal(hasDelegationLock(container({ capAdd: ["NET_ADMIN"] })), false);
  assert.equal(hasDelegationLock(container({ devices: ["/dev/dri:/dev/dri:rwm"] })), false);
  assert.deepEqual(hardeningRuleNames(container({ capAdd: ["NET_ADMIN"] })).hint, [
    "dangerous-capability"
  ]);
  // Host namespace stays a delegation lock: the container IS the host.
  assert.equal(hasDelegationLock(container({ networkMode: "host" })), true);
});

test("the self-check is stricter than the operational rule", () => {
  // /dev/dri no longer stops operation — but should it also not be newly
  // created via the spec path? It may: devices and capabilities are exactly
  // the cases §4 releases. What the self-check still catches are path
  // statements and the identity of the container.
  assert.deepEqual(selfCheckViolations(container({ devices: ["/dev/dri:/dev/dri"] })), []);
  assert.deepEqual(
    selfCheckViolations(container({ binds: ["/etc:/etc"] })).map((v) => v.rule),
    ["sensitive-host-path"]
  );
  assert.deepEqual(
    selfCheckViolations(container({ binds: ["/mnt/x:/x"] }), { bindBasePath: "/home/docker" }).map(
      (v) => v.rule
    ),
    ["bind-outside-base"]
  );
});

// --- K4b: logging-unbounded (§21.6) ---------------------------------------

test("json-file without max-size is a hint", () => {
  const c = container({ logDriver: "json-file", logOptions: {} });
  assert.deepEqual(rules(c), ["logging-unbounded"]);
  assert.equal(hasDelegationLock(c), false);
});

test("an empty driver name is treated like json-file", () => {
  // Docker's default. Better reported once too often than a silent trap.
  assert.deepEqual(rules(container({ logDriver: "", logOptions: {} })), ["logging-unbounded"]);
});

test("configured rotation and rotating/forwarding drivers are not a finding", () => {
  assert.deepEqual(rules(container({ logDriver: "json-file", logOptions: { "max-size": "10m" } })), []);
  // `local` rotates on its own (20m x 5); syslog/journald/none hand the log off
  // entirely — neither is our disk.
  for (const logDriver of ["local", "syslog", "journald", "none", "fluentd"]) {
    assert.deepEqual(rules(container({ logDriver: logDriver, logOptions: {} })), [], logDriver);
  }
});

test("rule names are deduplicated, the detail findings are not", () => {
  // Found live on 2026-07-20 on dashboard-tailscale-1: two forbidden
  // capabilities yielded "dangerous-capability,dangerous-capability" — the
  // translation in the main API then reported "3 hardening rules", although
  // there are two different ones.
  const c = container({
    capAdd: ["NET_ADMIN", "SYS_MODULE"],
    devices: ["/dev/net/tun:/dev/net/tun:rwm"]
  });

  // The detail list keeps both capabilities — each names a different one.
  const report = hardeningReport(c);
  assert.equal(report.hint.length, 3);
  assert.deepEqual(
    report.hint.filter((v) => v.rule === "dangerous-capability").map((v) => v.detail),
    ["NET_ADMIN", "SYS_MODULE"]
  );

  // The name list does not: without details the second entry would be identical.
  assert.deepEqual(hardeningRuleNames(c).hint, ["dangerous-capability", "device-passthrough"]);
});

test("every violation carries one of the three levels", () => {
  const c = container({ privileged: true, capDrop: [], binds: ["/etc:/x"] });
  const seen = new Set<string>();
  for (const violation of findHardeningViolations(c)) {
    assert.ok(
      violation.severity === "delegation-lock" ||
        violation.severity === "warning" ||
        violation.severity === "notice",
      `${violation.rule} without a level`
    );
    seen.add(violation.severity);
  }
  // And all three actually occur in this one container.
  assert.deepEqual([...seen].sort(), ["delegation-lock", "notice", "warning"]);
});

test("normalizePath resolves . and .. as well as multiple slashes", () => {
  assert.equal(normalizePath("/var/lib/../../etc"), "/etc");
  assert.equal(normalizePath("/a//b/./c"), "/a/b/c");
  assert.equal(normalizePath("/.."), "/");
  assert.equal(normalizePath("daten"), "daten");
});

// --- Stage 5a: bind mount allowlist ----------------------------------------

const Base = { bindBasePath: "/home/docker" };

function bindRules(binds: string[]) {
  return findHardeningViolations(container({ binds }), Base)
    .map((v) => v.rule)
    .sort();
}

test("binds below the base path are allowed", () => {
  // The real existing setup: 49 of 53 host binds look like this.
  assert.deepEqual(bindRules(["/home/docker/tautulli/config:/config"]), []);
  assert.deepEqual(bindRules(["/home/docker/homepage/data:/app/config:ro"]), []);
});

test("binds outside the base path are blocked", () => {
  for (const bind of ["/mnt/media:/media", "/opt/zeug:/zeug", "/srv/x:/x:ro"]) {
    assert.deepEqual(bindRules([bind]), ["bind-outside-base"], bind);
  }
});

test("the base path ITSELF is not an allowed bind", () => {
  // Exactly such a mount exists on the live server. Since S9 it even falls one
  // level higher than bind-outside-base: /home/docker CONTAINS
  // dashboard-state and dashboard-repo, so it is a self mount.
  assert.deepEqual(bindRules(["/home/docker:/host"]), ["dashboard-self-mount"]);
  assert.deepEqual(bindRules(["/home/docker/:/host"]), ["dashboard-self-mount"]);
});

test("a path that only has the base path as a prefix does not count as inside", () => {
  assert.deepEqual(bindRules(["/home/dockerX/daten:/d"]), ["bind-outside-base"]);
});

// --- Security review 5c (2026-07-21): the project directory itself ---------

test("a PROJECT DIRECTORY is not an allowed bind", () => {
  // The finding: since stage 5c /home/docker/<name> holds the compose.yaml,
  // i.e. the DEFINITION of the container. If the container may mount it, it
  // can rewrite it from inside (privileged, "/" as a volume) and start as a
  // privileged container on the next recreate — host root, bypassing a model
  // that explicitly has no field for privileged.
  //
  // The definition must lie outside the reach of what it defines.
  assert.deepEqual(bindRules(["/home/docker/evil:/proj"]), ["bind-outside-base"]);
  assert.deepEqual(bindRules(["/home/docker/evil/:/proj"]), ["bind-outside-base"]);
  // Not a NEIGHBOUR's directory either.
  assert.deepEqual(bindRules(["/home/docker/homepage:/fremd"]), ["bind-outside-base"]);
  // And not via a detour.
  assert.deepEqual(bindRules(["/home/docker/a/../evil:/proj"]), ["bind-outside-base"]);
});

test("data directories INSIDE a project directory stay allowed", () => {
  // The tightening must not break the goal of the stage: a backup of the
  // container directory should contain definition AND data, so data
  // directories must stay mountable.
  //
  // Survey 2026-07-21: none of the 48 bind sources under /home/docker is a
  // project directory — the rule costs no existing mount.
  assert.deepEqual(bindRules(["/home/docker/evil/data:/data"]), []);
  assert.deepEqual(bindRules(["/home/docker/evil/a/b/c:/x"]), []);
  // A neighbour's too — per 6.2 explicitly a trust decision of the operator,
  // not a matter for the dashboard.
  assert.deepEqual(bindRules(["/home/docker/homepage/data:/fremd"]), []);
});

test("the allowlist cannot be left via ..", () => {
  // "/home/docker/../etc" is "/home/etc" after normalisation — not sensitive,
  // but outside the base path. Exactly the case a plain denylist slips past
  // and the allowlist catches.
  assert.deepEqual(bindRules(["/home/docker/../etc:/etc"]), ["bind-outside-base"]);
  assert.deepEqual(bindRules(["/home/docker/x/../../opt:/opt"]), ["bind-outside-base"]);
  // Two levels up really lands in /etc — there the denylist applies.
  assert.deepEqual(bindRules(["/home/docker/../../etc:/etc"]), ["sensitive-host-path"]);
});

test("the denylist beats the allowlist", () => {
  // dashboard-state lies BELOW the base path and still stays locked: the
  // secrets live there. Since S9 as a delegation lock instead of a warning.
  assert.deepEqual(bindRules(["/home/docker/dashboard-state:/s:ro"]), ["dashboard-self-mount"]);
  assert.deepEqual(bindRules(["/home/docker/dashboard-repo:/r:ro"]), ["dashboard-self-mount"]);
});

test("named volumes are not affected by the allowlist", () => {
  assert.deepEqual(bindRules(["daten:/var/lib/data", "cache:/tmp/cache"]), []);
});

test("without a configured base path the rule does not run at all", () => {
  // Deliberately: a missing configuration must not lead to everything that
  // was allowed before suddenly being rejected.
  assert.deepEqual(
    findHardeningViolations(container({ binds: ["/mnt/media:/media"] })).map((v) => v.rule),
    []
  );
});

// --- Stage 5e: protected containers / own universe -------------------------

function securedRules(binds: string[], universe: string) {
  return findHardeningViolations(container({ binds }), {
    bindBasePath: "/home/docker",
    secureUniverse: universe
  })
    .map((v) => v.rule)
    .sort();
}

test("protected: the own data folder stays allowed", () => {
  assert.deepEqual(securedRules(["/home/docker/homepage/data:/data"], "/home/docker/homepage"), []);
  assert.deepEqual(
    securedRules(["/home/docker/homepage/data/sub:/x:ro"], "/home/docker/homepage"),
    []
  );
});

test("protected: a neighbour's mount becomes bind-outside-universe", () => {
  // Exactly the case the class rules out structurally: for a NORMAL container
  // /home/docker/traefik/data is a trust decision (allowed), for a protected
  // one it is an escape.
  assert.deepEqual(
    securedRules(["/home/docker/traefik/data:/fremd"], "/home/docker/homepage"),
    ["bind-outside-universe"]
  );
});

test("protected: the own directory ITSELF stays locked (compose.yaml)", () => {
  // It lies in the universe, but not STRICTLY below it — the definition lives there.
  // bind-outside-base applies first (only one level below the base path).
  assert.deepEqual(
    securedRules(["/home/docker/homepage:/proj"], "/home/docker/homepage"),
    ["bind-outside-base"]
  );
});

test("protected is a true subset: what the base path forbids stays forbidden", () => {
  // A path outside the base path still falls under bind-outside-base, not under
  // the new rule — the tightening only adds, it replaces nothing.
  assert.deepEqual(securedRules(["/mnt/media:/media"], "/home/docker/homepage"), ["bind-outside-base"]);
  // docker.sock stays the most severe finding, regardless of the class.
  assert.deepEqual(
    securedRules(["/var/run/docker.sock:/var/run/docker.sock"], "/home/docker/homepage"),
    ["docker-socket-mount"]
  );
});
