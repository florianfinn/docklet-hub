import assert from "node:assert/strict";
import test from "node:test";
import {
  composeContextOf,
  composeContextFindingOf,
  emitComposeYaml,
  isInsideBase,
  isValidComposeFileName,
  locationFor,
  servicesFromComposeConfig,
  specFromComposeConfig,
  UPDATE_ROLLBACK_OVERRIDE_FILE_NAME
} from "./compose.js";
import type { ContainerSpec } from "./spec.js";

const Base = "/home/docker";

function spec(overrides: Partial<ContainerSpec> = {}): ContainerSpec {
  return {
    name: "minecraft",
    imageRef: "itzg/minecraft-server:2024.1",
    env: [{ key: "EULA", value: "TRUE" }],
    ports: [{ containerPort: 25565, hostPort: 25565, protocol: "tcp", hostIp: "127.0.0.1" }],
    volumes: [{ type: "bind", source: "/home/docker/minecraft/data", target: "/data", readOnly: false }],
    networks: ["spiele"],
    restartPolicy: "unless-stopped",
    resources: { memoryMb: 4096, cpus: 2, pidsLimit: 512 },
    ...overrides
  };
}

// --- The location ----------------------------------------------------------

test("the directory is derived from the name", () => {
  assert.deepEqual(locationFor("minecraft", Base), {
    projectDir: "/home/docker/minecraft",
    filePath: "/home/docker/minecraft/compose.yaml",
    serviceName: "minecraft"
  });
});

test("names that would lead out of the base path have no location", () => {
  // The actual bolt: there is no way to give the agent a PATH. Even if someone
  // did get a name with traversal through, it would not yield a location
  // outside the base path.
  for (const name of ["..", "../etc", "/etc/passwd", "a/b", ".", "", "-leading-dash"]) {
    assert.equal(locationFor(name, Base), null, name);
  }
});

test("the base path itself does not lie below itself", () => {
  // Same rule as the bind allowlist in hardening.ts: there is a mount on
  // /home/docker ITSELF, and it is exactly the case the rule is meant to
  // catch.
  assert.equal(isInsideBase("/home/docker", Base), false);
  assert.equal(isInsideBase("/home/docker/a", Base), true);
  assert.equal(isInsideBase("/home/docker/../etc", Base), false);
  assert.equal(isInsideBase("/home/dockerfoo", Base), false);
});

test("the compose directory is read off the container, not taken on trust", () => {
  const labels = {
    "com.docker.compose.project": "minecraft",
    "com.docker.compose.service": "minecraft",
    "com.docker.compose.project.working_dir": "/home/docker/minecraft",
    "com.docker.compose.project.config_files": "/home/docker/minecraft/compose.yaml"
  };
  assert.deepEqual(composeContextOf(labels, Base), {
    projectDir: "/home/docker/minecraft",
    serviceName: "minecraft",
    project: "minecraft",
    composeFileName: "compose.yaml"
  });
});

// Stage 5d: the file name is no longer a constant. All three usual names occur
// in the existing setup — a `--file` pointing at the wrong one does not look
// like an error but like "project does not exist".
test("the file name comes from the label, not from an assumption", () => {
  const labels = {
    "com.docker.compose.project": "tautulli",
    "com.docker.compose.service": "tautulli",
    "com.docker.compose.project.working_dir": "/home/docker/tautulli",
    "com.docker.compose.project.config_files": "/home/docker/tautulli/docker-compose.yml"
  };
  assert.equal(composeContextOf(labels, Base)?.composeFileName, "docker-compose.yml");
});

test("without an unambiguous file there is no location", () => {
  const base = {
    "com.docker.compose.project": "x",
    "com.docker.compose.service": "x",
    "com.docker.compose.project.working_dir": "/home/docker/x"
  };
  // No label at all: guessing would be worse than rejecting — the three usual
  // names can sit side by side in the same directory.
  assert.equal(composeContextOf(base, Base), null);
  // Several files (started with an override): the truth is spread across
  // files that a later `--file` with only one of them would resolve
  // differently. Better not to touch it at all than halfway.
  assert.equal(
    composeContextOf(
      { ...base, "com.docker.compose.project.config_files": "/home/docker/x/a.yaml,/home/docker/x/b.yaml" },
      Base
    ),
    null
  );
  // File outside the project directory: the same traversal bolt as for the
  // directory itself.
  assert.equal(
    composeContextOf(
      { ...base, "com.docker.compose.project.config_files": "/home/docker/y/compose.yaml" },
      Base
    ),
    null
  );
});

test("only the fixed S12 rollback override stays unambiguously anchored after the rollback", () => {
  const base = {
    "com.docker.compose.project": "x",
    "com.docker.compose.service": "web",
    "com.docker.compose.project.working_dir": "/home/docker/x"
  };
  const context = composeContextOf(
    {
      ...base,
      "com.docker.compose.project.config_files":
        `/home/docker/x/compose.yaml,/home/docker/x/${UPDATE_ROLLBACK_OVERRIDE_FILE_NAME}`
    },
    Base
  );
  assert.deepEqual(context, {
    projectDir: "/home/docker/x",
    serviceName: "web",
    project: "x",
    composeFileName: "compose.yaml"
  });

  // A freely named or additional override stays forbidden.
  assert.equal(
    composeContextOf(
      {
        ...base,
        "com.docker.compose.project.config_files":
          `/home/docker/x/compose.yaml,/home/docker/x/${UPDATE_ROLLBACK_OVERRIDE_FILE_NAME},/home/docker/x/drittes.yaml`
      },
      Base
    ),
    null
  );
});

// Follow-up to security review 5d: the file name now comes from two sources.
// From the label composeFileNameOf checks it; from the agent's allowlist copy
// it was unchecked until then, although the directory next to it is
// cross-checked.
test("a compose file name is a plain file name", () => {
  for (const good of ["compose.yaml", "docker-compose.yml", "docker-compose.yaml"]) {
    assert.equal(isValidComposeFileName(good), true, good);
  }
  for (const bad of [
    "",
    ".",
    "..",
    "../compose.yaml",
    "unter/compose.yaml",
    "unter\\compose.yaml",
    // Line break generated programmatically, so that no control character
    // ends up in the source of this file.
    `compose${String.fromCharCode(10)}.yaml`
  ]) {
    assert.equal(isValidComposeFileName(bad), false, JSON.stringify(bad));
  }
});

test("a compose directory outside the base path does not count", () => {
  // A container that Dockge created elsewhere must not get the agent to write
  // outside /home/docker.
  const labels = {
    "com.docker.compose.project": "fremd",
    "com.docker.compose.service": "fremd",
    "com.docker.compose.project.working_dir": "/opt/stacks/fremd",
    "com.docker.compose.project.config_files": "/opt/stacks/fremd/compose.yaml"
  };
  assert.equal(composeContextOf(labels, Base), null);
});

test("a container without compose labels has no location", () => {
  assert.equal(composeContextOf({}, Base), null);
  assert.equal(composeContextOf(undefined, Base), null);
});

// --- #468: the finding says WHY ---------------------------------------------
//
// Until here "no compose context" was a `null` — three very different
// situations under one value. The rejection of the guided update therefore
// carried the same name as the pre-check of the main API, and the matching
// sentence sent the search to a place where everything was fine.

test("the finding distinguishes missing labels, wrong path and ambiguous file", () => {
  // No compose labels at all: there is no directory to name either.
  assert.deepEqual(composeContextFindingOf({}, Base), {
    ok: false,
    reason: "compose-anchor-labels-missing",
    projectDir: null
  });

  // Labels incomplete, but the directory is there — it belongs in the
  // message, otherwise the operator cannot verify it.
  assert.deepEqual(
    composeContextFindingOf({ "com.docker.compose.project.working_dir": "/home/docker/x" }, Base),
    { ok: false, reason: "compose-anchor-labels-missing", projectDir: "/home/docker/x" }
  );

  // The live case from #468: the same files reachable via two paths, the
  // container carries one, the agent manages the other.
  assert.deepEqual(
    composeContextFindingOf(
      {
        "com.docker.compose.project": "fileflows",
        "com.docker.compose.service": "fileflows",
        "com.docker.compose.project.working_dir": "/mnt/user/docker/fileflows",
        "com.docker.compose.project.config_files": "/mnt/user/docker/fileflows/docker-compose.yml"
      },
      "/mnt/cache/docker"
    ),
    {
      ok: false,
      reason: "compose-anchor-outside-base-path",
      projectDir: "/mnt/user/docker/fileflows"
    }
  );

  // Directory matches, but `config_files` does not name exactly one file in
  // it.
  assert.deepEqual(
    composeContextFindingOf(
      {
        "com.docker.compose.project": "x",
        "com.docker.compose.service": "x",
        "com.docker.compose.project.working_dir": "/home/docker/x",
        "com.docker.compose.project.config_files": "/home/docker/x/a.yaml,/home/docker/x/b.yaml"
      },
      Base
    ),
    { ok: false, reason: "compose-anchor-file-ambiguous", projectDir: "/home/docker/x" }
  );
});

test("a valid anchor yields the same context as composeContextOf", () => {
  const labels = {
    "com.docker.compose.project": "x",
    "com.docker.compose.service": "web",
    "com.docker.compose.project.working_dir": "/home/docker/x",
    "com.docker.compose.project.config_files": "/home/docker/x/compose.yaml"
  };
  const finding = composeContextFindingOf(labels, Base);
  assert.equal(finding.ok, true);
  assert.deepEqual(finding.ok ? finding.context : null, composeContextOf(labels, Base));
});

// --- The generated file -----------------------------------------------------
//
// Until stage 5c these guarantees lived in spec.test.ts on the engine payload.
// The path has changed (compose file instead of create call), the promise has
// not: there is no field through which anyone could request privileged,
// capabilities or a device passthrough.

test("the hardening properties are in the file and not configurable", () => {
  const yaml = emitComposeYaml(spec(), { imageRef: "itzg/minecraft-server:2024.1" });
  assert.match(yaml, /cap_drop:\n {6}- ALL/);
  assert.match(yaml, /security_opt:\n {6}- 'no-new-privileges:true'/);
  assert.match(yaml, /mem_limit: 4096m/);
  assert.match(yaml, /cpus: 2/);
  assert.match(yaml, /pids_limit: 512/);
  // What must NOT be in it.
  assert.ok(!yaml.includes("privileged"));
  assert.ok(!yaml.includes("devices"));
  assert.ok(!yaml.includes("cap_add"));
});

test("without a limit the line is missing — it is not set to 0", () => {
  // `mem_limit: 0m` and `cpus: 0` would be SET limits of zero bytes and zero
  // CPUs for Compose. "No limit" has exactly one spelling in a compose file:
  // the line is missing.
  const yaml = emitComposeYaml(spec({ resources: { memoryMb: null, cpus: null, pidsLimit: null } }), {
    imageRef: "x:1"
  });
  assert.ok(!yaml.includes("mem_limit"));
  assert.ok(!yaml.includes("cpus"));
  assert.ok(!yaml.includes("pids_limit"));
  // What does NOT go with it: the hardening stays unchanged.
  assert.ok(yaml.includes("    cap_drop:\n      - ALL"));
  assert.ok(yaml.includes("    security_opt:\n      - 'no-new-privileges:true'"));
});

test("individual limits can be mixed", () => {
  const yaml = emitComposeYaml(spec({ resources: { memoryMb: 2048, cpus: null, pidsLimit: 256 } }), {
    imageRef: "x:1"
  });
  assert.match(yaml, /mem_limit: 2048m/);
  assert.match(yaml, /pids_limit: 256/);
  assert.ok(!yaml.includes("cpus"));
});

test("log rotation is preset (K4b)", () => {
  // Docker's default for json-file does NOT rotate. Without these lines every
  // self-created container would come into being with exactly the finding
  // `logging-unbounded` reports (§21.6).
  const yaml = emitComposeYaml(spec(), { imageRef: "x:1" });
  assert.match(yaml, /logging:\n {6}driver: json-file\n {6}options:\n {8}max-size: '10m'\n {8}max-file: '3'/);
});

test("even a spec with extra fields set cannot soften the hardening", () => {
  // Even if a caller sends privileged/capAdd along: the fields do not exist in
  // the model, the emitter never reads them.
  const malicious = { ...spec(), privileged: true, capAdd: ["SYS_ADMIN"], devices: ["/dev/sda"] };
  const yaml = emitComposeYaml(malicious as ContainerSpec, { imageRef: "x:1" });
  assert.ok(!yaml.includes("privileged"));
  assert.ok(!yaml.includes("SYS_ADMIN"));
  assert.ok(!yaml.includes("/dev/sda"));
});

test("the image ref comes from the options, not from the spec", () => {
  // Stage plan 3.6: which image may run is a statement of the registry.
  // Otherwise "change ports" would be a way to swap the image on the side.
  const yaml = emitComposeYaml(spec({ imageRef: "boese/image:latest" }), {
    imageRef: "itzg/minecraft-server:2024.1"
  });
  assert.match(yaml, /image: 'itzg\/minecraft-server:2024\.1'/);
  assert.ok(!yaml.includes("boese/image"));
});

test("Compose does not pull on its own", () => {
  // The moment foreign code arrives on the host should remain an explicit,
  // logged step of the agent.
  assert.match(emitComposeYaml(spec(), { imageRef: "x:1" }), /pull_policy: never/);
});

test("networks are declared as external", () => {
  // Without "external: true" Compose would create its own networks
  // "<project>_<name>" — the container would then hang next to Traefik instead
  // of in its network.
  const yaml = emitComposeYaml(spec({ networks: ["spiele", "monitoring"] }), { imageRef: "x:1" });
  assert.match(yaml, /networks:\n {2}'spiele':\n {4}external: true\n {2}'monitoring':\n {4}external: true/);
});

test("ports keep the host IP", () => {
  const yaml = emitComposeYaml(spec(), { imageRef: "x:1" });
  assert.match(yaml, /- '127\.0\.0\.1:25565:25565\/tcp'/);
});

// --- Quoting: the trickiest part of the emitter -----------------------------

test("quotes in values cannot break out of the scalar", () => {
  const yaml = emitComposeYaml(
    spec({ env: [{ key: "MOTD", value: "it's a 'trap'" }] }),
    { imageRef: "x:1" }
  );
  // Single-quoted YAML scalars have no escape sequences; the only special
  // character is the quote itself, and it is doubled.
  assert.match(yaml, /'MOTD': 'it''s a ''trap'''/);
});

test("a dollar sign in a value does not become a variable", () => {
  // Compose interpolates the file BEFORE YAML parsing. Without doubling, a
  // password with "$" would be a reference to an environment variable — the
  // value would arrive silently empty in the container, or with the content of
  // a foreign variable.
  const yaml = emitComposeYaml(
    spec({ env: [{ key: "PASSWORD", value: "a$bc${HOME}" }] }),
    { imageRef: "x:1" }
  );
  assert.match(yaml, /'PASSWORD': 'a\$\$bc\$\$\{HOME\}'/);
});

test("a value that looks like YAML structure stays a value", () => {
  const yaml = emitComposeYaml(
    spec({ env: [{ key: "X", value: "\n    privileged: true" }] }),
    { imageRef: "x:1" }
  );
  // validateSpec already forbids line breaks (control characters). Even if
  // one got through, it stands inside the quotes and creates no new key at
  // service level.
  assert.ok(!/^ {4}privileged: true$/m.test(yaml));
});

// --- What is read back ------------------------------------------------------

test("the normalised compose JSON yields a spec again", () => {
  const config = {
    services: {
      minecraft: {
        image: "itzg/minecraft-server:2024.1",
        container_name: "minecraft",
        restart: "unless-stopped",
        environment: { EULA: "TRUE", TZ: "Europe/Berlin" },
        ports: [{ target: 25565, published: "25565", protocol: "tcp", host_ip: "127.0.0.1" }],
        volumes: [
          { type: "bind", source: "/home/docker/minecraft/data", target: "/data", read_only: false }
        ],
        networks: { "spiele": null },
        mem_limit: 4096 * 1024 * 1024,
        cpus: 2,
        pids_limit: 512,
        // Written by the emitter itself (K4b) — must not count as
        // "unsupported" when read back, otherwise the UI would report a
        // deviation on a file the dashboard has just generated.
        logging: { driver: "json-file", options: { "max-size": "10m", "max-file": "3" } }
      }
    }
  };
  const read = specFromComposeConfig(config, "minecraft");
  assert.equal(read.ok, true);
  if (!read.ok) return;
  assert.equal(read.spec.name, "minecraft");
  assert.equal(read.spec.imageRef, "itzg/minecraft-server:2024.1");
  assert.deepEqual(read.spec.resources, { memoryMb: 4096, cpus: 2, pidsLimit: 512 });
  assert.deepEqual(read.spec.ports, [
    { containerPort: 25565, hostPort: 25565, protocol: "tcp", hostIp: "127.0.0.1" }
  ]);
  assert.deepEqual(read.spec.networks, ["spiele"]);
  assert.deepEqual(read.unsupportedKeys, []);
});

test("missing limits come back as null, not as 0", () => {
  // ⚠️ The finding that forced this line: no grown container carries
  // `pids_limit`. As long as missing limits came back as 0, editing such a
  // definition reported "PIDs limit must be 16-16384" — on a field the
  // operator had never touched.
  const config = {
    services: {
      "dienst": { image: "x:1", container_name: "dienst", restart: "always" }
    }
  };
  const read = specFromComposeConfig(config, "dienst");
  assert.equal(read.ok, true);
  if (!read.ok) return;
  assert.deepEqual(read.spec.resources, { memoryMb: null, cpus: null, pidsLimit: null });
});

test("fields our spec does not model are reported instead of concealed", () => {
  // Open point 3 from 6.2: the UI must not present a file it read in as a
  // complete spec when there is a `devices:` next to it.
  const config = {
    services: {
      app: {
        image: "x:1",
        devices: ["/dev/sda"],
        healthcheck: { test: ["CMD", "true"] },
        // Compose fills empty/null keys itself — they are not a deviation and
        // must not be reported as one.
        command: null,
        entrypoint: null,
        sysctls: {}
      }
    }
  };
  const read = specFromComposeConfig(config, "app");
  assert.equal(read.ok, true);
  if (!read.ok) return;
  assert.deepEqual(read.unsupportedKeys, ["devices", "healthcheck"]);
});

test("escaped dollar signs come back as plain text", () => {
  // ⚠️ Found live 2026-07-21: `docker compose config` returns dollar signs
  // ESCAPED, so that its output is valid Compose again. Whoever takes that for
  // the plain text escapes again on the next write — the value grows with
  // EVERY edit ($ → $$ → $$$$), and of all things for passwords.
  const config = {
    services: { a: { image: "x:1", environment: { PASSWORD: "a$$bc$${HOME}" } } }
  };
  const read = specFromComposeConfig(config, "a");
  assert.equal(read.ok, true);
  if (!read.ok) return;
  assert.deepEqual(read.spec.env, [{ key: "PASSWORD", value: "a$bc${HOME}" }]);
});

test("emitter and reader are inverse to each other", () => {
  // The actual protection against the class of bug above: write once, read
  // once, and the value is the same. Compose's interpolation is reproduced
  // here (the file contains "$$", and so does the JSON from `config`).
  const value = "p@ss$word'mit\"allem${DRIN}";
  const yaml = emitComposeYaml(spec({ env: [{ key: "P", value: value }] }), { imageRef: "x:1" });
  assert.ok(yaml.includes("'P': 'p@ss$$word''mit\"allem$${DRIN}'"));

  const read = specFromComposeConfig(
    { services: { minecraft: { image: "x:1", environment: { P: "p@ss$$word'mit\"allem$${DRIN}" } } } },
    "minecraft"
  );
  assert.equal(read.ok, true);
  if (!read.ok) return;
  assert.equal(read.spec.env[0].value, value);
});

// --- Stacks (stage 5d) -----------------------------------------------------

test("a file with several services yields one spec per service", () => {
  // Synthetic multi-service project: container and service names differ.
  const config = {
    services: {
      homepage: { image: "ghcr.io/gethomepage/homepage:latest", container_name: "homepage" },
      "code-server": {
        image: "lscr.io/linuxserver/code-server:latest",
        container_name: "homepage_code-server",
        env_file: [".env"]
      }
    }
  };
  const read = servicesFromComposeConfig(config);
  assert.equal(read.ok, true);
  if (!read.ok) return;

  assert.deepEqual(read.services.map((entry) => entry.serviceName), ["homepage", "code-server"]);
  assert.equal(read.services[1].spec.name, "homepage_code-server");
  // The model does not cover env_file. It is reported, not concealed — a UI
  // that shows this spec as complete lies to the operator (open point 3 from
  // 6.2).
  assert.deepEqual(read.services[1].unsupportedKeys, ["env_file"]);
});

test("a single unreadable service does not make the whole file unreadable", () => {
  const config = { services: { a: { image: "x:1" }, b: { build: "." } } };
  const read = servicesFromComposeConfig(config);
  assert.equal(read.ok, true);
  if (!read.ok) return;
  assert.deepEqual(read.services.map((entry) => entry.serviceName), ["a"]);
});

test("a service that does not exist is a finding, not an approximation", () => {
  // Until 5d the reader fell back to "the only service if the name does not
  // match". The name now comes from the labels of the running container — it
  // is a statement, not a guess.
  const config = { services: { a: { image: "x:1" } } };
  assert.deepEqual(specFromComposeConfig(config, "b"), {
    ok: false,
    reason: "service-not-found"
  });
});

test("a file without an image yields no spec", () => {
  const read = specFromComposeConfig({ services: { a: { build: "." } } }, "a");
  assert.deepEqual(read, { ok: false, reason: "no-image" });
});

test("a missing port binding is reported as 0.0.0.0, not glossed over", () => {
  // Reading means reporting how it IS. The 127.0.0.1 default applies to NEW
  // ports and is decided in validation, not here.
  const config = {
    services: { a: { image: "x:1", ports: [{ target: 80, published: "8080", protocol: "tcp" }] } }
  };
  const read = specFromComposeConfig(config, "a");
  assert.equal(read.ok, true);
  if (!read.ok) return;
  assert.equal(read.spec.ports[0].hostIp, "0.0.0.0");
});
