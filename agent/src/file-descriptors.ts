import fs from "node:fs";
import path from "node:path";
import { definitionBlocked, protectionOf, within, type SourcePolicy } from "./file-sources.js";
import { checkEntryPath } from "./webftp.js";
import type { FileAccessError } from "contract";

export class DescriptorError extends Error { constructor(readonly reason: FileAccessError) { super(reason); } }
export function sameFile(a: fs.Stats, b: fs.Stats) { return a.dev === b.dev && a.ino === b.ino; }
export function descriptorFailure(error: unknown, writing = false) {
  const code = (error as NodeJS.ErrnoException).code;
  return { ok: false as const, reason: error instanceof DescriptorError ? error.reason
    : code === "ELOOP" || code === "ENOTDIR" ? "path-outside" as const
    : writing ? "not-writable" as const : "not-readable" as const, ...(code === "ENOENT" ? { missing: true } : {}) };
}
export async function visibleRootOf(source: string, base: string): Promise<string | null> {
  if (process.platform !== "linux" || !base) return null;
  try {
    const [root, actualBase] = await Promise.all([fs.promises.realpath(source), fs.promises.realpath(base)]);
    return actualBase === path.resolve(base) && within(root, actualBase) ? root : null;
  } catch { return null; }
}
export async function hostBoundary(root: string, base: string, relative: string, policy: SourcePolicy, writing = false) {
  if (!base || !within(root, base)) throw new DescriptorError("path-outside");
  const valid = checkEntryPath(relative, root);
  if (!valid.ok) throw new DescriptorError(valid.reason === "path-too-long" || valid.reason === "share-empty" ? "path-invalid-characters" : valid.reason);
  if (await definitionBlocked(valid.absolute, policy)) throw new DescriptorError("path-blocked");
  const protection = await protectionOf(valid.absolute, policy);
  if (protection === "backup") throw new DescriptorError("backup-directory-protected");
  if (protection === "agent" || protection === "unknown" || writing && protection !== "none") throw new DescriptorError("source-protected");
  return valid.absolute;
}
export async function openDescriptor(root: string, base: string, relative: string, policy: SourcePolicy,
  kind: "file" | "directory", writing = false) {
  if (process.platform !== "linux") throw new DescriptorError("not-readable");
  const absolute = await hostBoundary(root, base, relative, policy, writing);
  let handle = await fs.promises.open(base, fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW);
  try {
    const components = [{ absolute: path.resolve(base), stat: await handle.stat() }];
    const segments = path.relative(base, absolute).split(path.sep).filter(Boolean);
    for (const [index, segment] of segments.entries()) {
      const finalFile = index === segments.length - 1 && kind === "file";
      const next = await fs.promises.open(`/proc/self/fd/${handle.fd}/${segment}`,
        (finalFile && writing ? fs.constants.O_RDWR : fs.constants.O_RDONLY) | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK |
        (finalFile ? 0 : fs.constants.O_DIRECTORY));
      await handle.close();
      handle = next;
      components.push({ absolute: path.join(base, ...segments.slice(0, index + 1)), stat: await handle.stat() });
    }
    const pinned = `/proc/self/fd/${handle.fd}`;
    const real = await fs.promises.realpath(pinned);
    if (real !== absolute || !within(real, root)) throw new DescriptorError("path-outside");
    const stat = await handle.stat();
    if (kind === "file" ? !stat.isFile() : !stat.isDirectory()) throw new DescriptorError("wrong-kind");
    if (!sameFile(stat, await fs.promises.lstat(absolute))) throw new DescriptorError("file-replaced");
    return { handle, pinned, absolute, stat, components };
  } catch (error) { await handle.close(); throw error; }
}
export type OpenDescriptor = Awaited<ReturnType<typeof openDescriptor>>;
export async function verifyDescriptor(entry: OpenDescriptor) {
  if (!sameFile(entry.stat, await fs.promises.lstat(entry.absolute))) throw new DescriptorError("file-replaced");
}

// Reopen every component without following links and compare it to the pinned chain.
export async function verifyDescriptorPath(entry: OpenDescriptor) {
  const first = entry.components[0];
  let handle = await fs.promises.open(first.absolute, fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW);
  try {
    if (!sameFile(first.stat, await handle.stat())) throw new DescriptorError("file-replaced");
    for (const component of entry.components.slice(1)) {
      const directory = component.stat.isDirectory();
      const next = await fs.promises.open(path.join(`/proc/self/fd/${handle.fd}`, path.basename(component.absolute)),
        fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK | (directory ? fs.constants.O_DIRECTORY : 0));
      await handle.close(); handle = next;
      if (!sameFile(component.stat, await handle.stat())) throw new DescriptorError("file-replaced");
    }
    if (!sameFile(entry.stat, await handle.stat()) || !sameFile(entry.stat, await entry.handle.stat())) throw new DescriptorError("file-replaced");
  } finally { await handle.close(); }
}

export async function canonicalPolicy(policy: SourcePolicy): Promise<SourcePolicy> {
  const actual = async (roots: readonly string[]) => {
    const paths = await Promise.all(roots.map(async (root) => { try { return await fs.promises.realpath(root); } catch { return root; } }));
    return [...new Set([...roots, ...paths])];
  };
  return { ...policy, backupAliases: await actual([policy.backupDirectory, ...(policy.backupAliases ?? [])]),
    agentPaths: await actual(policy.agentPaths), socketAliases: await actual([policy.socketPath, ...(policy.socketAliases ?? [])]),
    dockerRootAliases: await actual([policy.dockerRootDir ?? "/var/lib/docker", ...(policy.dockerRootAliases ?? [])]) };
}
