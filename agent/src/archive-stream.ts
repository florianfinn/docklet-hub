import { archiveHeader, pax, type ArchiveEntry } from "./archive-reader.js";

export type ArchiveStream = AsyncIterable<Buffer>;
export type ArchiveEvent = { entry: ArchiveEntry } | { data: Buffer };
// The cursor retains only the current transport chunk, never an entire file.
export async function* archiveEvents(input: ArchiveStream, bodies = true): AsyncGenerator<ArchiveEvent> {
  const iterator = input[Symbol.asyncIterator]();
  let pending: Buffer = Buffer.alloc(0);
  let extensions: Record<string, string> = {};
  async function* chunks(size: number) {
    while (size > 0) {
      if (!pending.length) {
        const next = await iterator.next();
        if (next.done) throw new Error("not-readable");
        pending = next.value;
      }
      const length = Math.min(size, pending.length);
      yield pending.subarray(0, length);
      pending = pending.subarray(length);
      size -= length;
    }
  }
  const take = async (size: number) => {
    const parts = [];
    for await (const chunk of chunks(size)) parts.push(chunk);
    return Buffer.concat(parts, size);
  };
  try {
    for (;;) {
      const block = await take(512);
      if (block.every((byte) => byte === 0)) return;
      const { flag, size, entry } = archiveHeader(block, extensions);
      if (["x", "L", "K"].includes(flag)) {
        if (size > 65536) throw new Error("not-readable");
        const content = await take(size);
        if (flag === "x") extensions = { ...extensions, ...pax(content) };
        else extensions[flag === "L" ? "path" : "linkpath"] = content.toString("utf8").replace(/\0.*$/s, "").replace(/\n$/, "");
      } else {
        if (flag === "g") throw new Error("not-readable");
        extensions = {};
        yield { entry };
        for await (const data of chunks(size)) if (bodies) yield { data };
      }
      await take((512 - size % 512) % 512);
    }
  } finally { await iterator.return?.(); }
}
