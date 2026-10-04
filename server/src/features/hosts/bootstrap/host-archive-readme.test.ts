import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";

import { quoteShellArgument } from "contract";
import type { HostArchiveInput } from "./host-archive-input.js";
import { renderReadme } from "./host-archive-readme.js";

// The README's copyable commands carry the base path the operator typed
// (#61). Checked twice: the exact text, and what a real POSIX sh hands to the
// command. No service runs; `sh` only prints its arguments.

// Synthetic edge cases: [value, exact quoted form].
const QUOTED: [string, string][] = [
  ["/mnt/cache/docker/docklet-agent", "/mnt/cache/docker/docklet-agent"],
  ["/mnt/my disk", "'/mnt/my disk'"],
  ["/mnt/it's", String.raw`'/mnt/it'\''s'`],
  ['/mnt/a"b', `'/mnt/a"b'`],
  ["/mnt/$(id)", "'/mnt/$(id)'"],
  ["/mnt/a`id`", "'/mnt/a`id`'"],
  ["/mnt/a;b", "'/mnt/a;b'"],
  ["/mnt/a&b", "'/mnt/a&b'"],
  ["/mnt/a\nb", "'/mnt/a\nb'"],
  ["-rf", "'-rf'"],
  ["~/x", "'~/x'"],
  ["a=~", "'a=~'"],
  ["/mnt/a=b", "'/mnt/a=b'"],
  ["", "''"]
];

test("quoteShellArgument leaves plain paths readable and quotes everything else", () => {
  for (const [value, expected] of QUOTED) assert.equal(quoteShellArgument(value), expected, JSON.stringify(value));
});

/** POSIX sh: `sh` on Linux and macOS, the one of Git for Windows elsewhere. */
function resolveSh(): string {
  if (process.platform !== "win32") return "sh";
  const gitCore = execFileSync("git", ["--exec-path"], { encoding: "utf8" }).trim();
  const candidate = join(gitCore, "..", "..", "..", "usr", "bin", "sh.exe");
  assert.ok(existsSync(candidate), `no POSIX sh next to git at ${candidate}`);
  return candidate;
}

/** The argument vector sh builds from a script, through a stub of `sudo` and `cd`. */
function argumentsOf(script: string): string[][] {
  const stubs = "sudo() { printf '%s\\036' \"$@\"; printf '\\035'; }\ncd() { printf 'cd\\036%s\\036' \"$@\"; printf '\\035'; }\n";
  const output = execFileSync(resolveSh(), ["-c", stubs + script], { encoding: "utf8" });
  return output
    .split("\u001d")
    .filter((call) => call !== "")
    .map((call) => call.split("\u001e").slice(0, -1));
}

test("sh receives each quoted value unchanged as one argument", () => {
  for (const [value] of QUOTED) {
    assert.deepEqual(argumentsOf(`sudo ${quoteShellArgument(value)}`), [[value]], JSON.stringify(value));
  }
});

function readmeFor(bindBasePath: string): string {
  return renderReadme({
    host: { id: "host-1", name: "arm", kind: "external", tunnelAddress: "10.254.0.2", dockerGid: 281, bindBasePath },
    hub: { endpoint: "hub.example.test:51821", publicKey: "H".repeat(43) + "=", tunnelCidr: "10.254.0.0/24", hubAddress: "10.254.0.1" },
    agent: { image: "registry.example.test/agent:v1.0.0", port: 8099, secret: "a".repeat(48), privateKey: "P".repeat(43) + "=" },
    registration: { url: "http://10.254.0.1:8080/api/hosts/host-1/register", token: "b".repeat(43) }
  } satisfies HostArchiveInput);
}

/** The three commands of the unpack step, without their indentation. */
function unpackCommands(readme: string): string[] {
  const lines = readme.split("\n").map((line) => line.trim());
  const start = lines.findIndex((line) => line.startsWith("sudo mkdir -p "));
  return lines.slice(start, start + 3);
}

test("the README unpack step quotes the directory and keeps a plain one readable", () => {
  assert.deepEqual(unpackCommands(readmeFor("/mnt/cache/docker")), [
    "sudo mkdir -p /mnt/cache/docker/docklet-agent",
    "sudo tar -xzf <archive>.tar.gz -C /mnt/cache/docker/docklet-agent",
    "cd /mnt/cache/docker/docklet-agent"
  ]);
  assert.deepEqual(unpackCommands(readmeFor("/mnt/a&b$(id)'c")), [
    String.raw`sudo mkdir -p '/mnt/a&b$(id)'\''c/docklet-agent'`,
    String.raw`sudo tar -xzf <archive>.tar.gz -C '/mnt/a&b$(id)'\''c/docklet-agent'`,
    String.raw`cd '/mnt/a&b$(id)'\''c/docklet-agent'`
  ]);
});

test("sh runs the README unpack step with the directory as one argument", () => {
  // Without the line-break case: the hub refuses it, and it would split the
  // README lines this test reads. Its quoting is checked above.
  const usable = QUOTED.filter(([value]) => value.startsWith("/") && !value.includes(String.fromCharCode(10)));
  for (const [path] of usable) {
    const directory = `${path}/docklet-agent`;
    // `<archive>` is a placeholder for the operator; sh would read it as a redirect.
    const script = unpackCommands(readmeFor(path)).join("\n").replace("<archive>", "archive");
    assert.deepEqual(
      argumentsOf(script),
      [
        ["mkdir", "-p", directory],
        ["tar", "-xzf", "archive.tar.gz", "-C", directory],
        ["cd", directory]
      ],
      JSON.stringify(path)
    );
  }
});

test("the README nc check quotes host and port from the endpoint", () => {
  const ncLine = (endpoint: string) => {
    const readme = renderReadme({
      host: { id: "host-1", name: "arm", kind: "external", tunnelAddress: "10.254.0.2", dockerGid: 281, bindBasePath: "/mnt/a" },
      hub: { endpoint, publicKey: "H".repeat(43) + "=", tunnelCidr: "10.254.0.0/24", hubAddress: "10.254.0.1" },
      agent: { image: "registry.example.test/agent:v1.0.0", port: 8099, secret: "a".repeat(48), privateKey: "P".repeat(43) + "=" },
      registration: { url: "http://10.254.0.1:8080/api/hosts/host-1/register", token: "b".repeat(43) }
    });
    return readme.split("\n").find((line) => line.includes("nc -vzu"))?.trim();
  };
  assert.equal(ncLine("hub.example.test:51821"), "from here. Cross-check: `nc -vzu hub.example.test 51821`.");
  assert.equal(ncLine("hub.example.test;id:51821"), "from here. Cross-check: `nc -vzu 'hub.example.test;id' 51821`.");
  assert.equal(ncLine("[2001:db8::1]:51821"), "from here. Cross-check: `nc -vzu '[2001:db8::1]' 51821`.");
});
