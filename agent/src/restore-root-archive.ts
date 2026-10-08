import path from "node:path";
import type { ArchiveEntry } from "./archive-reader.js";
import { archiveEvents, type ArchiveStream } from "./archive-stream.js";
import { backupTarHeader } from "./backup-archive.js";
import { RestorePathFailure } from "./restore-metadata.js";

export async function archiveRoot(input: ArchiveStream, target: string): Promise<ArchiveEntry> {
  const events = archiveEvents(input);
  try {
    const first = await events.next();
    if (first.done || !("entry" in first.value) || first.value.entry.name !== path.posix.basename(target)
      || first.value.entry.kind !== "directory") throw new RestorePathFailure(target);
    return first.value.entry;
  } finally { await events.return(undefined); }
}
export function rootMetadataMatches(a: ArchiveEntry, b: ArchiveEntry) {
  return a.uid === b.uid && a.gid === b.gid && (a.mode & 0o7777) === (b.mode & 0o7777);
}
// PUT into the mount itself; its root header must never reach Docker extraction.
export async function* withoutArchiveRoot(input: ArchiveStream, target: string, current: ArchiveEntry): ArchiveStream {
  const basename = path.posix.basename(target);
  let previous: ArchiveEntry | undefined;
  let seenRoot = false;
  for await (const event of archiveEvents(input)) {
    if ("data" in event) { yield event.data; continue; }
    if (previous) yield Buffer.alloc((512 - previous.size % 512) % 512);
    const entry = event.entry;
    if (entry.name === basename) {
      if (entry.kind !== "directory" || !rootMetadataMatches(entry, current)) throw new RestorePathFailure(target);
      seenRoot = true; previous = undefined; continue;
    }
    if (!seenRoot || !entry.name.startsWith(basename + "/")) throw new RestorePathFailure(target);
    previous = entry;
    yield backupTarHeader({ ...entry, name: entry.name.slice(basename.length + 1) });
  }
  if (!seenRoot) throw new RestorePathFailure(target);
  if (previous) yield Buffer.alloc((512 - previous.size % 512) % 512);
  yield Buffer.alloc(1024);
}
