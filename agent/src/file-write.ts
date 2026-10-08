import fs, { type FileHandle } from "node:fs/promises";
import { MAX_TEXT_BYTES } from "contract";
import { constants } from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { hashOf } from "./compose-store.js";
import { descriptorPath, fileWriteBlocker, openBelow } from "./webftp.js";

async function textHash(file: FileHandle): Promise<string> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of file.createReadStream({ autoClose: false })) {
    size += chunk.length;
    if (size > MAX_TEXT_BYTES) throw new Error("too-large");
    chunks.push(Buffer.from(chunk));
  }
  const bytes = Buffer.concat(chunks);
  const content = bytes.toString("utf8");
  if (bytes.includes(0) || !Buffer.from(content).equals(bytes)) throw new Error("not-a-text-file");
  return hashOf(content);
}
export async function writePinned(input: { directory: string; root: string; name: string; content?: Buffer; expectedHash?: string }) {
  if (input.content && input.expectedHash) {
    const openedFile = await openBelow(path.join(input.directory, input.name), input.root, "file", true);
    if (!openedFile.ok) return { ok: false as const, reason: openedFile.reason };
    try {
      const blocker = await fileWriteBlocker(openedFile.entry.real);
      if (blocker) return { ok: false as const, reason: blocker };
      const hash = await textHash(openedFile.entry.handle);
      if (hash !== input.expectedHash) return { ok: false as const, reason: "file-changed-externally", hash };
      await openedFile.entry.handle.truncate(0);
      let offset = 0;
      while (offset < input.content.length) {
        const written = await openedFile.entry.handle.write(input.content, offset, input.content.length - offset, offset);
        if (!written.bytesWritten) throw new Error("not-writable");
        offset += written.bytesWritten;
      }
      await openedFile.entry.handle.sync();
      return { ok: true as const, uid: openedFile.entry.uid };
    } catch { return { ok: false as const, reason: "not-writable" }; }
    finally { await openedFile.entry.handle.close().catch(() => {}); }
  }
  const opened = await openBelow(input.directory, input.root, "directory");
  if (!opened.ok) return { ok: false as const, reason: opened.reason };
  const directory = opened.entry;
  const destination = path.join(descriptorPath(directory), input.name);
  const temporary = path.join(descriptorPath(directory), `.docklet-${randomUUID()}`);
  let created = false;
  try {
    const blocker = await fileWriteBlocker(path.join(directory.real, input.name));
    if (blocker) return { ok: false as const, reason: blocker };
    let previous;
    try { previous = await fs.lstat(destination); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    if (previous?.isSymbolicLink()) return { ok: false as const, reason: "path-outside" };
    if (previous && !input.expectedHash) return { ok: false as const, reason: "already-exists" };
    if (previous && !previous.isFile()) return { ok: false as const, reason: "wrong-kind" };
    if (input.expectedHash) {
      if (!previous) return { ok: false as const, reason: "file-replaced" };
      const file = await fs.open(destination, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
      try {
        const stat = await file.stat();
        if (!stat.isFile() || stat.ino !== previous.ino || stat.dev !== previous.dev) return { ok: false as const, reason: "file-replaced" };
        const hash = await textHash(file);
        if (hash !== input.expectedHash) return { ok: false as const, reason: "file-changed-externally", hash };
      } finally { await file.close(); }
    }
    const uid = previous?.uid ?? directory.uid;
    const gid = previous?.gid ?? directory.gid;
    const mode = previous ? previous.mode & 0o7777 : directory.mode & (input.content ? 0o666 : 0o777);
    if (input.content) {
      const file = await fs.open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
      created = true;
      try {
        const stat = await file.stat();
        if (stat.uid !== uid || stat.gid !== gid) await file.chown(uid, gid);
        await file.chmod(mode);
        await file.writeFile(input.content);
        await file.sync();
      } finally { await file.close(); }
      if (previous) {
        const current = await fs.lstat(destination);
        if (current.ino !== previous.ino || current.dev !== previous.dev) return { ok: false as const, reason: "file-replaced" };
        const verification = await fs.open(destination, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
        try {
          const actualHash = await textHash(verification);
          if (actualHash !== input.expectedHash) return { ok: false as const, reason: "file-changed-externally", hash: actualHash };
        } finally { await verification.close(); }
        await fs.rename(temporary, destination);
      } else {
        await fs.link(temporary, destination);
      }
    } else {
      await fs.mkdir(destination, { mode: 0o700 });
      const folder = await fs.open(destination, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
      try {
        const stat = await folder.stat();
        if (stat.uid !== uid || stat.gid !== gid) await folder.chown(uid, gid);
        await folder.chmod(mode);
      } catch (error) { await fs.rmdir(destination).catch(() => {}); throw error; }
      finally { await folder.close(); }
    }
    return { ok: true as const, uid };
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    return { ok: false as const, reason: code === "EEXIST" ? "already-exists" : ["EACCES", "EPERM", "EROFS"].includes(code ?? "") ? "not-writable" : "file-replaced" };
  } finally {
    if (created) await fs.unlink(temporary).catch(() => {});
    await directory.handle.close().catch(() => {});
  }
}
