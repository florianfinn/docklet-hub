import { openDescriptor } from "./file-descriptors.js";
import fs from "node:fs";
import path from "node:path";
import { definitionBlocked, protectionOf, within, type SourcePolicy } from "./file-sources.js";
import { checkEntryPath, checkName } from "./webftp.js";
import type { FileAccessError } from "contract";

class Denied extends Error { constructor(readonly reason: FileAccessError) { super(reason); } }
function same(a: fs.Stats, b: fs.Stats) { return a.dev === b.dev && a.ino === b.ino; }
function failure(error: unknown) {
  const code = (error as NodeJS.ErrnoException).code;
  return { ok: false as const, reason: error instanceof Denied ? error.reason
    : code === "EEXIST" || code === "ENOTEMPTY" ? "already-exists" as const
    : code === "ELOOP" ? "path-outside" as const : "not-writable" as const };
}
export class VisibleFileActions {
  constructor(private readonly root: string, private readonly base: string, private readonly policy: SourcePolicy,
    private readonly writable: boolean) {}
  private async checked(relative: string) {
    if (!this.writable || !this.base || !path.isAbsolute(this.root) || !within(this.root, this.base)) throw new Denied("not-writable");
    const valid = checkEntryPath(relative, this.root);
    if (!valid.ok) throw new Denied(valid.reason === "path-too-long" || valid.reason === "share-empty" ? "path-invalid-characters" : valid.reason);
    for (const target of [this.root, valid.absolute]) {
      if (await definitionBlocked(target, this.policy)) throw new Denied("path-blocked");
      const protection = await protectionOf(target, this.policy);
      if (protection !== "none") throw new Denied(protection === "backup" ? "backup-directory-protected" : "source-protected");
    }
    return valid.absolute;
  }
  private async directory(absolute: string) {
    const parent = await openDescriptor(this.root, this.base, path.relative(this.root, absolute), this.policy, "directory", true);
    try { await fs.promises.access(parent.pinned, fs.constants.W_OK | fs.constants.X_OK); return parent; }
    catch (error) { await parent.handle.close(); throw error; }
  }
  async available(relative: string): Promise<boolean> {
    try {
      const parent = await this.directory(await this.checked(relative));
      await parent.handle.close();
      return true;
    } catch { return false; }
  }
  private async prepare(relative: string) {
    const absolute = await this.checked(relative);
    if (absolute === this.root) throw new Denied("path-blocked");
    const parent = await this.directory(path.dirname(absolute));
    try {
      const leaf = path.join(parent.pinned, path.basename(absolute));
      const stat = await fs.promises.lstat(leaf);
      if (stat.isSymbolicLink()) throw new Denied("path-outside");
      if (!stat.isFile() && !stat.isDirectory()) throw new Denied("wrong-kind");
      return { parent, leaf, stat };
    } catch (error) { await parent.handle.close(); throw error; }
  }
  private async unchanged(entry: Awaited<ReturnType<VisibleFileActions["prepare"]>>) {
    if (!same(entry.parent.stat, await fs.promises.lstat(entry.parent.absolute)) ||
      !same(entry.stat, await fs.promises.lstat(entry.leaf))) throw new Denied("file-replaced");
  }
  async delete(relative: string) {
    let entry: Awaited<ReturnType<VisibleFileActions["prepare"]>> | undefined;
    try {
      entry = await this.prepare(relative);
      await this.unchanged(entry);
      if (entry.stat.isFile()) await fs.promises.unlink(entry.leaf); else await fs.promises.rmdir(entry.leaf);
      return { ok: true as const, kind: entry.stat.isFile() ? "file" as const : "directory" as const };
    } catch (error) { return failure(error); }
    finally { await entry?.parent.handle.close(); }
  }
  async rename(relative: string, newName: string) {
    let entry: Awaited<ReturnType<VisibleFileActions["prepare"]>> | undefined;
    let reserved: fs.Stats | undefined;
    let target = "";
    try {
      const name = checkName(newName);
      if (!name.ok) throw new Denied("path-blocked");
      await this.checked(path.join(path.dirname(relative), name.name).replace(/^\.\//, ""));
      entry = await this.prepare(relative);
      target = path.join(entry.parent.pinned, name.name);
      await this.unchanged(entry);
      if (entry.stat.isFile()) {
        // Hard links reserve destinations exclusively without replacing existing names.
        await fs.promises.link(entry.leaf, target);
        reserved = await fs.promises.lstat(target);
        if (!same(reserved, entry.stat)) throw new Denied("file-replaced");
        await this.unchanged(entry);
        await fs.promises.unlink(entry.leaf);
      } else {
        await fs.promises.mkdir(target, { mode: 0o700 });
        reserved = await fs.promises.lstat(target);
        await this.unchanged(entry);
        if (!same(reserved, await fs.promises.lstat(target))) throw new Denied("already-exists");
        await fs.promises.rename(entry.leaf, target);
      }
      reserved = undefined;
      return { ok: true as const, name: name.name };
    } catch (error) { return failure(error); }
    finally {
      if (reserved) {
        try {
          if (same(reserved, await fs.promises.lstat(target))) {
            if (reserved.isDirectory()) await fs.promises.rmdir(target); else await fs.promises.unlink(target);
          }
        } catch { /* Only remove our own reservation. */ }
      }
      await entry?.parent.handle.close();
    }
  }
}
