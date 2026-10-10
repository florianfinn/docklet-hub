import { inflateRawSync } from "node:zlib";

export const PUBLIC_SOURCE_ARCHIVE = "docs/next/mockups/opus-source.zip";

// Inspect the explicitly published ZIP in memory, including historical Git blobs.
// Ordinary archives remain private artifacts. No archive entry is written to disk.
export function inspectPublicSourceArchive(content, inspectEntry) {
  const findings = [];
  try {
    if (content.length > 8 * 1024 * 1024) throw new Error("Archive too large");
    let end = content.length - 22;
    while (end >= Math.max(0, content.length - 65557) && content.readUInt32LE(end) !== 0x06054b50) end--;
    if (end < 0 || content.readUInt16LE(end + 4) !== 0 || content.readUInt16LE(end + 6) !== 0) throw new Error("Unsupported ZIP");
    const count = content.readUInt16LE(end + 10);
    if (count !== content.readUInt16LE(end + 8) || count > 500) throw new Error("Unsupported entry count");
    let cursor = content.readUInt32LE(end + 16);
    let total = 0;
    const names = new Set();
    for (let index = 0; index < count; index++) {
      if (content.readUInt32LE(cursor) !== 0x02014b50) throw new Error("Invalid directory");
      const flags = content.readUInt16LE(cursor + 8);
      const method = content.readUInt16LE(cursor + 10);
      const size = content.readUInt32LE(cursor + 24);
      const compressed = content.readUInt32LE(cursor + 20);
      const nameLength = content.readUInt16LE(cursor + 28);
      const name = content.subarray(cursor + 46, cursor + 46 + nameLength).toString("utf8");
      const local = content.readUInt32LE(cursor + 42);
      cursor += 46 + nameLength + content.readUInt16LE(cursor + 30) + content.readUInt16LE(cursor + 32);
      total += size;
      if (flags & 1 || ![0, 8].includes(method) || size > 2 * 1024 * 1024 || total > 8 * 1024 * 1024) throw new Error("Unsupported content");
      if (!name || name.includes("\\") || name.startsWith("/") || name.split("/").includes("..") || names.has(name)) throw new Error("Unsafe entry path");
      names.add(name);
      if (content.readUInt32LE(local) !== 0x04034b50) throw new Error("Invalid entry");
      const start = local + 30 + content.readUInt16LE(local + 26) + content.readUInt16LE(local + 28);
      if (start + compressed > content.length) throw new Error("Truncated entry");
      const bytes = content.subarray(start, start + compressed);
      const decoded = method === 8 ? inflateRawSync(bytes, { maxOutputLength: 2 * 1024 * 1024 }) : bytes;
      if (decoded.length !== size || decoded.includes(0)) throw new Error("Non-text source entry");
      findings.push(...inspectEntry(decoded.toString("utf8"), name));
    }
  } catch {
    findings.push({ path: PUBLIC_SOURCE_ARCHIVE, line: 1, category: "invalid-public-source-archive" });
  }
  return findings;
}
