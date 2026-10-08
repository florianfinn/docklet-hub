import { hasPathControls } from "./webftp.js";
import { TAR_BLOCK } from "./tar.js";

export type ArchiveEntry = {
  name: string; kind: "file" | "directory" | "symlink" | "other";
  size: number; changedAt: number; mode: number; uid: number; gid: number; linkTarget: string; content: Buffer;
};
function string(block: Buffer, start: number, size: number): string {
  const bytes = block.subarray(start, start + size);
  const end = bytes.indexOf(0);
  const value = bytes.subarray(0, end < 0 ? bytes.length : end).toString("utf8");
  if (!Buffer.from(value).equals(bytes.subarray(0, end < 0 ? bytes.length : end))) throw new Error("not-readable");
  return value;
}
function number(block: Buffer, start: number, size: number): number {
  if (block[start] & 128) throw new Error("not-readable");
  const value = string(block, start, size).trim();
  if (value && !/^[0-7]+$/.test(value)) throw new Error("not-readable");
  const parsed = value ? parseInt(value, 8) : 0;
  if (!Number.isSafeInteger(parsed)) throw new Error("not-readable");
  return parsed;
}
export function pax(content: Buffer): Record<string, string> {
  const fields: Record<string, string> = {};
  let offset = 0;
  while (offset < content.length) {
    const space = content.indexOf(32, offset);
    const length = Number(content.subarray(offset, space).toString());
    if (space < offset || !Number.isSafeInteger(length) || length <= space - offset + 1 || offset + length > content.length) throw new Error("not-readable");
    const field = content.subarray(space + 1, offset + length - 1).toString("utf8");
    const equal = field.indexOf("=");
    if (equal < 1) throw new Error("not-readable");
    fields[field.slice(0, equal)] = field.slice(equal + 1);
    offset += length;
  }
  return fields;
}
export function archiveHeader(block: Buffer, extensions: Record<string, string> = {}) {
  const checksum = block.reduce((sum, byte, index) => sum + (index >= 148 && index < 156 ? 32 : byte), 0);
  if (checksum !== number(block, 148, 8)) throw new Error("not-readable");
  const size = number(block, 124, 12);
  const flag = string(block, 156, 1);
  const name = (extensions.path ?? [string(block, 345, 155), string(block, 0, 100)].filter(Boolean).join("/")).replace(/\/$/, "");
  if (!name || name.startsWith("/") || hasPathControls(name) || name.includes("\\") || name.split("/").some((part) => part === ".." || part === "")) throw new Error("path-outside");
  if (extensions.size && Number(extensions.size) !== size) throw new Error("not-readable");
  const owner = (key: "uid" | "gid", offset: number) => {
    if (extensions[key] === undefined) return number(block, offset, 8);
    const value = Number(extensions[key]);
    if (!/^[0-9]+$/.test(extensions[key]) || !Number.isSafeInteger(value) || value > 0xffffffff) throw new Error("not-readable");
    return value;
  };
  const entry: ArchiveEntry = { name, size, kind: flag === "5" ? "directory" : flag === "2" ? "symlink" : flag === "0" || flag === "" ? "file" : "other",
    changedAt: number(block, 136, 12), mode: number(block, 100, 8), uid: owner("uid", 108), gid: owner("gid", 116),
    linkTarget: extensions.linkpath ?? string(block, 157, 100), content: Buffer.alloc(0) };
  return { flag, size, entry };
}
// Docker emits ustar with optional PAX or GNU long-name metadata.
export function archiveEntries(archive: Buffer): ArchiveEntry[] {
  const entries: ArchiveEntry[] = [];
  let extensions: Record<string, string> = {};
  for (let offset = 0; offset + TAR_BLOCK <= archive.length;) {
    const block = archive.subarray(offset, offset + TAR_BLOCK);
    if (block.every((byte) => byte === 0)) return entries;
    const checksum = block.reduce((sum, byte, index) => sum + (index >= 148 && index < 156 ? 32 : byte), 0);
    if (checksum !== number(block, 148, 8)) throw new Error("not-readable");
    const size = number(block, 124, 12);
    const end = offset + TAR_BLOCK + size;
    if (end > archive.length) throw new Error("not-readable");
    const content = archive.subarray(offset + TAR_BLOCK, end);
    offset += TAR_BLOCK + Math.ceil(size / TAR_BLOCK) * TAR_BLOCK;
    const flag = string(block, 156, 1);
    if (flag === "x") { extensions = { ...extensions, ...pax(content) }; continue; }
    if (flag === "L" || flag === "K") { extensions[flag === "L" ? "path" : "linkpath"] = string(content, 0, content.length); continue; }
    if (flag === "g") throw new Error("not-readable");
    const prefix = string(block, 345, 155);
    const name = (extensions.path ?? [prefix, string(block, 0, 100)].filter(Boolean).join("/")).replace(/\/$/, "");
    if (!name || name.startsWith("/") || hasPathControls(name) || name.includes("\\") || name.split("/").some((part) => part === ".." || part === "")) throw new Error("path-outside");
    if (extensions.size && Number(extensions.size) !== size) throw new Error("not-readable");
    entries.push({ name, size, kind: flag === "5" ? "directory" : flag === "2" ? "symlink" : flag === "0" || flag === "" ? "file" : "other",
      changedAt: number(block, 136, 12), mode: number(block, 100, 8), uid: number(block, 108, 8), gid: number(block, 116, 8),
      linkTarget: extensions.linkpath ?? string(block, 157, 100), content });
    extensions = {};
  }
  throw new Error("not-readable");
}
